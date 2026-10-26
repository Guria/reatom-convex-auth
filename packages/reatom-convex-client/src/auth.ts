// Token fetch, server confirmation and refresh: the state machine of
// convex/src/browser/sync/authentication_manager.ts, kept in an atom.
import type { AuthError, Logger, Transition } from './protocol'
import type { AuthTokenFetcher } from 'convex/browser'

import { atom, context, peek, wrap, type Frame } from '@reatom/core'

type AuthConfig = {
	fetchToken: AuthTokenFetcher
	onAuthChange: (isAuthenticated: boolean) => void
	onRefreshChange?: ((isRefreshing: boolean) => void) | undefined
}

/**
 * By default: send a possibly cached token, fetch a fresh one once the server
 * accepts it, then refetch before each token expires. With
 * `initialAuthTokenReuse` the cached token is kept and its refetch scheduled.
 */
export type AuthState =
	| { state: 'noAuth' }
	| { state: 'waitingForServerConfirmationOfCachedToken'; config: AuthConfig }
	| { state: 'initialRefetch'; config: AuthConfig }
	| {
			state: 'waitingForServerConfirmationOfFreshToken'
			config: AuthConfig
			hadAuth: boolean
			token: string
	  }
	| {
			state: 'waitingForScheduledRefetch'
			config: AuthConfig
			refetch: ReturnType<typeof setTimeout>
	  }
	// A valid token, but fetching a new one returned the same token.
	| { state: 'notRefetching'; config: AuthConfig }

/** The client's side of auth: its token and identity version, and the socket. */
export type AuthSync = {
	isCurrentOrNewerAuthVersion(version: number): boolean
	markAuthCompletion(): void
	token(): string | undefined
	/** Sends `Authenticate` with the token. */
	authenticate(token: string): void
	/** Forgets the token without sending; the socket is stopped. */
	dropToken(): void
	/** Forgets the token and sends `Authenticate` with none. */
	clearAuth(): void
	stopSocket(): Promise<void>
	tryRestartSocket(): void
	pauseSocket(): void
	resumeSocket(): void
}

// setTimeout takes a 32-bit delay, about 24 days.
const MAXIMUM_REFRESH_DELAY = 20 * 24 * 60 * 60 * 1000
const MAX_TOKEN_CONFIRMATION_ATTEMPTS = 2

const decodeClaims = (token: string): { iat?: number; exp?: number } | null => {
	try {
		const payload = token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')
		return JSON.parse(atob(payload)) as { iat?: number; exp?: number }
	} catch {
		return null
	}
}

export const reatomConvexAuth = (
	sync: AuthSync,
	options: { logger: Logger; refreshTokenLeewaySeconds: number; initialAuthTokenReuse: boolean },
	name: string,
) => {
	const { logger } = options
	const state = atom<AuthState>({ state: 'noAuth' }, `${name}.state`)
	const runtime = atom(
		(): { root: Frame; configVersion: number; lastRefreshChange: boolean; attempts: number } => ({
			root: context(),
			// Detects `setConfig` and `stop` while a token is being fetched.
			configVersion: 0,
			lastRefreshChange: false,
			// Attempts to confirm the latest fresh token.
			attempts: 0,
		}),
		`${name}._runtime`,
	)

	const setState = (next: AuthState) => {
		const current = state()
		if (current.state === 'waitingForScheduledRefetch') clearTimeout(current.refetch)
		if (
			next.state === 'waitingForScheduledRefetch' ||
			next.state === 'notRefetching' ||
			next.state === 'noAuth'
		) {
			peek(runtime).attempts = 0
		}
		state.set(next)
	}

	const notifyRefreshChange = (isRefreshing: boolean) => {
		const current = state()
		const rt = peek(runtime)
		if (
			current.state !== 'noAuth' &&
			current.state !== 'initialRefetch' &&
			current.config.onRefreshChange &&
			rt.lastRefreshChange !== isRefreshing
		) {
			rt.lastRefreshChange = isRefreshing
			current.config.onRefreshChange(isRefreshing)
		}
	}

	// The only way into `noAuth`; pairs any pending `onRefreshChange(true)`.
	const reset = () => {
		notifyRefreshChange(false)
		setState({ state: 'noAuth' })
	}

	const reportFailed = (config: AuthConfig) => {
		config.onAuthChange(false)
		reset()
	}

	const fetchToken = async (fetcher: AuthTokenFetcher, forceRefreshToken: boolean) => {
		const rt = peek(runtime)
		const version = ++rt.configVersion
		const token = await wrap(fetcher({ forceRefreshToken }))
		return version === rt.configVersion ? { value: token } : null
	}

	const scheduleRefetch = (token: string, clientClockSkewMs?: number) => {
		const current = state()
		if (current.state === 'noAuth') return
		const claims = decodeClaims(token)
		if (!claims) return void logger.error('Auth token is not a valid JWT, cannot refetch the token')
		const { iat, exp } = claims
		if (!iat || !exp) {
			return void logger.error('Auth token does not have required fields, cannot refetch the token')
		}
		if (exp - iat <= 2) {
			return void logger.error('Auth token does not live long enough, cannot refetch the token')
		}
		const validitySeconds =
			clientClockSkewMs === undefined
				? exp - iat
				: Math.max(0, exp - (Date.now() - clientClockSkewMs) / 1000)
		let delay = Math.min(
			MAXIMUM_REFRESH_DELAY,
			(validitySeconds - options.refreshTokenLeewaySeconds) * 1000,
		)
		if (delay <= 0) {
			logger.warn(
				`Refetching auth token immediately, configured leeway ${options.refreshTokenLeewaySeconds}s is larger than the token's lifetime ${validitySeconds}s`,
			)
			delay = 0
		}
		const refetch = setTimeout(
			wrap(() => void refetchToken(), peek(runtime).root),
			delay,
		)
		setState({ state: 'waitingForScheduledRefetch', config: current.config, refetch })
	}

	// Force-fetches a token, then schedules the next refetch on confirmation.
	const refetchToken = async () => {
		const current = state()
		if (current.state === 'noAuth') return
		const token = await fetchToken(current.config.fetchToken, true)
		if (!token) return
		if (token.value && token.value !== sync.token()) {
			setState({
				state: 'waitingForServerConfirmationOfFreshToken',
				hadAuth: sync.token() !== undefined,
				token: token.value,
				config: current.config,
			})
			sync.authenticate(token.value)
		} else if (token.value) {
			setState({ state: 'notRefetching', config: current.config })
		} else {
			if (sync.token() !== undefined) sync.clearAuth()
			reportFailed(current.config)
		}
		// Restart in case a scheduled refetch ran during reauthentication.
		sync.tryRestartSocket()
	}

	// Like `refetchToken`, but with the socket stopped so requests don't retry with bad auth.
	const reauthenticate = async (message: AuthError) => {
		const current = state()
		const rt = peek(runtime)
		if (
			current.state === 'noAuth' ||
			(current.state === 'waitingForServerConfirmationOfFreshToken' &&
				rt.attempts >= MAX_TOKEN_CONFIRMATION_ATTEMPTS)
		) {
			logger.error(`Failed to authenticate: "${message.error}", check your server auth config`)
			if (sync.token() !== undefined) sync.dropToken()
			if (current.state !== 'noAuth') reportFailed(current.config)
			return
		}
		if (current.state === 'waitingForServerConfirmationOfFreshToken') rt.attempts++
		notifyRefreshChange(true)
		await wrap(sync.stopSocket())
		// `setConfig` or `stop` ran meanwhile.
		if (state().state === 'noAuth') return
		const token = await fetchToken(current.config.fetchToken, true)
		if (!token) return
		if (token.value && token.value !== sync.token()) {
			sync.authenticate(token.value)
			setState({
				state: 'waitingForServerConfirmationOfFreshToken',
				config: current.config,
				token: token.value,
				hadAuth:
					current.state === 'notRefetching' || current.state === 'waitingForScheduledRefetch',
			})
		} else {
			if (sync.token() !== undefined) sync.dropToken()
			reportFailed(current.config)
		}
		sync.tryRestartSocket()
	}

	return {
		state,
		async setConfig(
			fetcher: AuthTokenFetcher,
			onAuthChange: (isAuthenticated: boolean) => void,
			onRefreshChange?: (isRefreshing: boolean) => void,
		) {
			reset()
			sync.pauseSocket()
			const token = await fetchToken(fetcher, false)
			if (!token) return
			const config: AuthConfig = { fetchToken: fetcher, onAuthChange, onRefreshChange }
			if (token.value) {
				setState({ state: 'waitingForServerConfirmationOfCachedToken', config })
				sync.authenticate(token.value)
			} else {
				setState({ state: 'initialRefetch', config })
				await wrap(refetchToken())
			}
			sync.resumeSocket()
		},

		onTransition(message: Transition) {
			const { startVersion, endVersion } = message
			// Stale, or not an answer to `Authenticate`.
			if (!sync.isCurrentOrNewerAuthVersion(endVersion.identity)) return
			if (endVersion.identity <= startVersion.identity) return
			sync.markAuthCompletion()
			const current = state()
			if (current.state === 'waitingForServerConfirmationOfCachedToken') {
				const cached = sync.token()
				if (options.initialAuthTokenReuse && cached) {
					scheduleRefetch(cached, message.clientClockSkew)
				} else {
					void refetchToken()
				}
				current.config.onAuthChange(true)
			} else if (current.state === 'waitingForServerConfirmationOfFreshToken') {
				notifyRefreshChange(false)
				scheduleRefetch(current.token)
				peek(runtime).attempts = 0
				if (!current.hadAuth) current.config.onAuthChange(true)
			}
		},

		onAuthError(message: AuthError) {
			const current = state().state
			// An expired-token error while a new token is already on its way.
			if (
				!message.authUpdateAttempted &&
				(current === 'waitingForServerConfirmationOfFreshToken' ||
					current === 'waitingForServerConfirmationOfCachedToken')
			) {
				return
			}
			// The error reports the version the server stayed at.
			if (!sync.isCurrentOrNewerAuthVersion(message.baseVersion + 1)) return
			void reauthenticate(message)
		},

		stop() {
			reset()
			peek(runtime).configVersion++
		},
	}
}
