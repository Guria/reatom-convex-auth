import {
	action,
	atom,
	computed,
	effect,
	reatomEnum,
	withConnectHook,
	withLocalStorage,
	wrap,
} from '@reatom/core'

import {
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
)

export const signIn = action(async (credentials: Credentials) => {
	await wrap(activeAdapter().signIn(credentials))
}, 'session.signIn')

export const signUp = action(async (credentials: Credentials) => {
	await wrap(activeAdapter().signUp(credentials))
}, 'session.signUp')

export const signOut = action(async () => {
	await wrap(activeAdapter().signOut())
}, 'session.signOut')
