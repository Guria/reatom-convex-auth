import {
	abortVar,
	action,
	atom,
	computed,
	effect,
	reatomEnum,
	urlAtom,
	withAsync,
	withConnectHook,
	withLocalStorage,
	wrap,
} from '@reatom/core'

import {
	assignLocation,
	AUTH_PROVIDERS,
	betterAuthClient,
	convex,
	convexAuthTransport,
	reatomBetterAuthAdapter,
	reatomConvexAuthAdapter,
	type AuthAdapter,
	type AuthProviderId,
	type Credentials,
} from '#shared/api'
import { createAppPath } from '#shared/router'

const adapters = {
	'convex-auth': reatomConvexAuthAdapter(convexAuthTransport, 'convexAuth'),
	'better-auth': reatomBetterAuthAdapter(betterAuthClient, 'betterAuth'),
} satisfies Record<AuthProviderId, AuthAdapter>

export const authProvider = reatomEnum(AUTH_PROVIDERS, 'authProvider').extend(
	withLocalStorage('authProvider'),
)

const activeAdapter = computed(() => adapters[authProvider()], 'activeAdapter')

export const sessionUser = computed(() => activeAdapter().user(), 'sessionUser')

// Changes only when the signed-in identity does, not on every session refetch.
const sessionKey = computed(() => {
	const user = sessionUser()
	return user ? `${activeAdapter().id}:${user.email}` : null
}, 'sessionKey')

/** Trades the params the auth library sent the browser back with for a session. */
export const completeRedirect = action(async (adapter: AuthAdapter, params: URLSearchParams) => {
	await wrap(adapter.completeRedirect(params))
}, 'session.completeRedirect').extend(withAsync())

type SessionStatus = 'signedOut' | 'authenticating' | 'authenticated' | 'rejected'

// The session whose token Convex holds. Until it is the current one, Convex's
// answer is about an earlier session.
const convexAuthKey = atom<string | null>(null, 'convexAuthKey')

/**
 * Two-phase session: the auth library holds a session (`sessionUser`), then
 * the Convex backend accepts or rejects its token. Only `authenticated` may
 * render private data.
 */
export const sessionStatus = computed((): SessionStatus => {
	if (!completeRedirect.ready()) return 'authenticating'
	const key = sessionKey()
	if (!key) return 'signedOut'
	if (convexAuthKey() !== key) return 'authenticating'
	const accepted = convex().isAuthenticated()
	if (accepted === null) return 'authenticating'
	return accepted ? 'authenticated' : 'rejected'
}, 'sessionStatus').extend(
	// Hands the active library's token to Convex while the app observes the session.
	withConnectHook(
		() =>
			effect(() => {
				const adapter = activeAdapter()
				const key = sessionKey()
				if (key) convex().setAuth(adapter.fetchToken)
				else convex().clearAuth()
				convexAuthKey.set(key)
			}, 'sessionStatus.syncConvexAuth').unsubscribe,
	),
	// Takes the redirect params off the URL. The exchange is spawned, so the
	// effect rerunning on that URL change does not abort it.
	withConnectHook(
		() =>
			effect(() => {
				const adapter = activeAdapter()
				const url = urlAtom()
				const params = new URLSearchParams()
				for (const name of adapter.redirectParams) {
					const value = url.searchParams.get(name)
					if (value !== null) params.set(name, value)
				}
				if (params.size === 0) return
				const next = new URL(url)
				for (const name of adapter.redirectParams) next.searchParams.delete(name)
				abortVar.spawn(() => completeRedirect(adapter, params))
				urlAtom.set(next, true)
			}, 'sessionStatus.completeRedirect').unsubscribe,
	),
)

export const signIn = action(async (credentials: Credentials) => {
	await wrap(activeAdapter().signIn(credentials))
}, 'session.signIn')

export const signUp = action(async (credentials: Credentials) => {
	await wrap(activeAdapter().signUp(credentials))
}, 'session.signUp')

export const signInWithGitHub = action(async () => {
	const returnTo = new URL(createAppPath('login'), window.location.origin).href
	const url = await wrap(activeAdapter().startGitHubSignIn(returnTo))
	assignLocation()(url)
}, 'session.signInWithGitHub').extend(withAsync())

export const signOut = action(async () => {
	await wrap(activeAdapter().signOut())
}, 'session.signOut')
