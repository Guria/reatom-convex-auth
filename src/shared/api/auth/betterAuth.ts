import type { AuthAdapter, AuthUser, Credentials } from './types'

import { convexClient, crossDomainClient } from '@convex-dev/better-auth/client/plugins'
import { action, atom, withConnectHook, wrap, type AtomLike } from '@reatom/core'
import { createAuthClient } from 'better-auth/client'

import { BETTER_AUTH_BASE_PATH } from '#convex/authPaths'

/**
 * The calls the adapter makes through better-auth's framework-agnostic client.
 * The client itself is a Proxy that answers every property, `then` included,
 * with a request function, so it must not be stored in an atom as-is. The
 * Convex site is another origin: `crossDomainClient` keeps the session cookie
 * in localStorage and sends it as the `Better-Auth-Cookie` header. After
 * OAuth, the backend sends the browser back with a one-time token (`ott`)
 * that the client trades for that cookie.
 */
export const createBetterAuthClient = (siteUrl: string) => {
	const client = createAuthClient({
		baseURL: `${siteUrl}${BETTER_AUTH_BASE_PATH}`,
		plugins: [convexClient(), crossDomainClient()],
	})
	return {
		getSession: () => client.getSession(),
		/** The last session crossDomainClient cached in localStorage. */
		cachedSession: () => client.getSessionData(),
		convexToken: () => client.convex.token({ fetchOptions: { throw: false } }),
		signIn: (credentials: Credentials) => client.signIn.email(credentials),
		signUp: (credentials: Credentials & { name: string }) => client.signUp.email(credentials),
		signInWithGitHub: (returnTo: string) =>
			client.signIn.social({
				provider: 'github',
				callbackURL: returnTo,
				errorCallbackURL: returnTo,
				disableRedirect: true,
			}),
		verifyOneTimeToken: (token: string) => client.crossDomain.oneTimeToken.verify({ token }),
		signOut: () => client.signOut(),
	}
}

export type BetterAuthClient = ReturnType<typeof createBetterAuthClient>

const toUser = (session: unknown): AuthUser | null => {
	if (typeof session !== 'object' || session === null || !('user' in session)) return null
	const { user } = session
	if (typeof user !== 'object' || user === null || !('email' in user)) return null
	return typeof user.email === 'string' ? { email: user.email } : null
}

export const reatomBetterAuthAdapter = (
	client: AtomLike<BetterAuthClient>,
	name: string,
): AuthAdapter => {
	const token = atom<string | null>(null, `${name}.token`)

	// Starts from the session cached by crossDomainClient, then asks the server.
	const user = atom(() => toUser(client().cachedSession()), `${name}.user`).extend(
		withConnectHook(() => {
			void restore()
		}),
	)

	const restore = action(async () => {
		const { data, error } = await wrap(client().getSession())
		if (!error) user.set(toUser(data))
	}, `${name}.restore`)

	const fetchToken = action(async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
		const cached = token()
		if (cached && !forceRefreshToken) return cached
		const { data } = await wrap(client().convexToken())
		token.set(data?.token ?? null)
		return data?.token ?? null
	}, `${name}.fetchToken`)

	const signIn = action(async ({ email, password }: Credentials) => {
		const { data, error } = await wrap(client().signIn({ email, password }))
		if (error) throw new Error(error.message ?? 'Sign-in failed')
		token.set(null)
		user.set(toUser(data))
	}, `${name}.signIn`)

	const signUp = action(async ({ email, password }: Credentials) => {
		const displayName = email.split('@')[0] ?? email
		const { data, error } = await wrap(client().signUp({ email, password, name: displayName }))
		if (error) throw new Error(error.message ?? 'Sign-up failed')
		token.set(null)
		user.set(toUser(data))
	}, `${name}.signUp`)

	const startGitHubSignIn = action(async (returnTo: string) => {
		const { data, error } = await wrap(client().signInWithGitHub(returnTo))
		if (error || !data?.url) throw new Error(error?.message ?? 'Better Auth returned no redirect')
		return data.url
	}, `${name}.startGitHubSignIn`)

	// better-auth sends `error` instead of `ott` when the provider refused.
	const completeRedirect = action(async (params: URLSearchParams) => {
		const ott = params.get('ott')
		if (!ott) throw new Error(params.get('error') ?? 'No sign-in in progress')
		const { data, error } = await wrap(client().verifyOneTimeToken(ott))
		if (error) throw new Error(error.message ?? 'Sign-in failed')
		token.set(null)
		user.set(toUser(data))
	}, `${name}.completeRedirect`)

	const signOut = action(async () => {
		user.set(null)
		token.set(null)
		await wrap(client().signOut())
	}, `${name}.signOut`)

	return {
		id: 'better-auth',
		user,
		fetchToken,
		signIn,
		signUp,
		startGitHubSignIn,
		redirectParams: ['ott', 'error'],
		completeRedirect,
		signOut,
	}
}
