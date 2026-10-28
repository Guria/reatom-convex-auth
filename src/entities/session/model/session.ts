import {
	abortVar,
	action,
	computed,
	effect,
	reatomEnum,
	urlAtom,
	withAsync,
	withConnectHook,
	withLocalStorage,
	wrap,
} from '@reatom/core'
import { reatomAuthState } from '@reatomized/convex'
import { reatomBetterAuthProvider } from '@reatomized/convex/better-auth'
import { reatomConvexAuthProvider } from '@reatomized/convex/convex-auth'

import {
	assignLocation,
	AUTH_PROVIDERS,
	betterAuthClient,
	convex,
	readJwtClaims,
	type AuthProviderId,
	type Credentials,
} from '#shared/api'
import { createAppPath } from '#shared/router'

export const authProvider = reatomEnum(AUTH_PROVIDERS, 'authProvider').extend(
	withLocalStorage('authProvider'),
)

// crossDomainClient caches the session in localStorage. Without a cached one
// there is no session to wait for, so the sign-in page shows at once.
const betterAuthProvider = () => {
	const client = betterAuthClient()()
	const provider = reatomBetterAuthProvider(
		client,
		{ shouldHandleOneTimeToken: false },
		'betterAuth',
	)
	const cached = client.getSessionData() !== null
	return {
		...provider,
		isLoading: computed(
			() => (cached ? provider.isLoading() : !provider.completeSignIn.ready()),
			'betterAuth.isLoadingCached',
		),
	}
}

// The app reads redirect params from `urlAtom` itself (below): stories land
// on them in place, without the page load the providers would check on start.
const providers = computed(
	() => ({
		'convex-auth': reatomConvexAuthProvider(
			convex(),
			{
				storageNamespace: 'convexAuth',
				shouldHandleCode: false,
				navigate: (url) => assignLocation()(url.href),
			},
			'convexAuth',
		),
		'better-auth': betterAuthProvider(),
	}),
	'authProviders',
)

const activeProvider = computed(() => providers()[authProvider()], 'activeProvider')

const authState = computed(
	() => reatomAuthState(convex(), activeProvider, 'session.auth'),
	'session.authState',
)

/** The signed-in user per the auth library, before the backend accepts its token. */
export const sessionUser = computed(() => {
	const { 'convex-auth': convexAuth, 'better-auth': betterAuth } = providers()
	if (authProvider() === 'better-auth') {
		const email = betterAuth.data()?.user.email
		return email ? { email } : null
	}
	const token = convexAuth.token()
	const email = token && readJwtClaims(token)?.['email']
	return typeof email === 'string' ? { email } : null
}, 'sessionUser')

/** Query params each library sends the browser back with after OAuth. */
const REDIRECT_PARAMS = {
	'convex-auth': ['code'],
	'better-auth': ['ott', 'error'],
} as const satisfies Record<AuthProviderId, readonly string[]>

/** Trades the params the auth library sent the browser back with for a session. */
export const completeRedirect = action(async (id: AuthProviderId, params: URLSearchParams) => {
	if (id === 'convex-auth') {
		const code = params.get('code')
		if (!code) throw new Error('No sign-in in progress')
		await wrap(providers()['convex-auth'].completeSignIn(code))
		return
	}
	// better-auth sends `error` instead of `ott` when the provider refused.
	const ott = params.get('ott')
	if (!ott) throw new Error(params.get('error') ?? 'No sign-in in progress')
	await wrap(providers()['better-auth'].completeSignIn(ott))
}, 'session.completeRedirect').extend(withAsync())

type SessionStatus = 'signedOut' | 'authenticating' | 'authenticated' | 'rejected'

const STATUSES = {
	loading: 'authenticating',
	unauthenticated: 'signedOut',
	authenticated: 'authenticated',
	rejected: 'rejected',
} as const

/**
 * Two-phase session: the auth library holds a session (`sessionUser`), then
 * the Convex backend accepts or rejects its token. Only `authenticated` may
 * render private data.
 */
export const sessionStatus = computed((): SessionStatus => {
	if (!completeRedirect.ready()) return 'authenticating'
	return STATUSES[authState().status()]
}, 'sessionStatus').extend(
	// Takes the redirect params off the URL. The exchange is spawned, so the
	// effect rerunning on that URL change does not abort it.
	withConnectHook(
		() =>
			effect(() => {
				const id = authProvider()
				const url = urlAtom()
				const params = new URLSearchParams()
				for (const name of REDIRECT_PARAMS[id]) {
					const value = url.searchParams.get(name)
					if (value !== null) params.set(name, value)
				}
				if (params.size === 0) return
				const next = new URL(url)
				for (const name of REDIRECT_PARAMS[id]) next.searchParams.delete(name)
				abortVar.spawn(() => completeRedirect(id, params))
				urlAtom.set(next, true)
			}, 'sessionStatus.completeRedirect').unsubscribe,
	),
)

const passwordFlow = (flow: 'signIn' | 'signUp') =>
	action(async ({ email, password }: Credentials) => {
		if (authProvider() === 'convex-auth') {
			const { signingIn } = await wrap(
				providers()['convex-auth'].signIn('password', { email, password, flow }),
			)
			if (!signingIn) throw new Error('Convex Auth returned no session')
			return
		}
		const client = betterAuthClient()()
		const { error } = await wrap(
			flow === 'signIn'
				? client.signIn.email({ email, password })
				: client.signUp.email({ email, password, name: email.split('@')[0] ?? email }),
		)
		if (error) throw new Error(error.message ?? 'Sign-in failed')
	}, `session.${flow}`)

export const signIn = passwordFlow('signIn')
export const signUp = passwordFlow('signUp')

export const signInWithGitHub = action(async () => {
	const returnTo = new URL(createAppPath('login'), window.location.origin).href
	if (authProvider() === 'convex-auth') {
		// Navigates through `assignLocation`.
		await wrap(providers()['convex-auth'].signIn('github', { redirectTo: returnTo }))
		return
	}
	const { data, error } = await wrap(
		betterAuthClient()().signIn.social({
			provider: 'github',
			callbackURL: returnTo,
			errorCallbackURL: returnTo,
			disableRedirect: true,
		}),
	)
	if (error || !data?.url) throw new Error(error?.message ?? 'Better Auth returned no redirect')
	assignLocation()(data.url)
}, 'session.signInWithGitHub').extend(withAsync())

export const signOut = action(async () => {
	if (authProvider() === 'convex-auth') {
		await wrap(providers()['convex-auth'].signOut())
		return
	}
	await wrap(betterAuthClient()().signOut())
}, 'session.signOut')
