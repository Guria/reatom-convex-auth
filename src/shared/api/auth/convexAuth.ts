import type { AuthAdapter, Credentials } from './types'
import type { FunctionArgs } from 'convex/server'

import { action, atom, computed, withChangeHook, wrap, type AtomLike } from '@reatom/core'
import { ConvexHttpClient } from 'convex/browser'

import { api } from '#convex/_generated/api.js'

import { readJwtClaims } from './jwt'

type Tokens = { token: string; refreshToken: string }

// `auth:signIn` declares no return validator; this is the part used here.
type SignInResult = { tokens?: Tokens | null; redirect?: string; verifier?: string }

/** Convex Auth's two actions, called over HTTP outside the websocket's auth. */
export type ConvexAuthTransport = {
	signIn(args: FunctionArgs<typeof api.auth.signIn>): Promise<SignInResult>
	signOut(token: string): Promise<void>
}

export const createConvexAuthTransport = (url: string): ConvexAuthTransport => ({
	signIn: (args) => new ConvexHttpClient(url).action(api.auth.signIn, args),
	signOut: async (token) => {
		const client = new ConvexHttpClient(url)
		client.setAuth(token)
		await client.action(api.auth.signOut, {})
	},
})

/** The keys and raw-string format of Convex Auth's own client. */
export const convexAuthStorageKeys = (namespace: string) => ({
	token: `__convexAuthJWT_${namespace}`,
	refreshToken: `__convexAuthRefreshToken_${namespace}`,
	verifier: `__convexAuthOAuthVerifier_${namespace}`,
})

const readTokens = (keys: ReturnType<typeof convexAuthStorageKeys>): Tokens | null => {
	const token = localStorage.getItem(keys.token)
	const refreshToken = localStorage.getItem(keys.refreshToken)
	return token && refreshToken ? { token, refreshToken } : null
}

/**
 * Convex Auth's client protocol (its own client ships only as a React
 * provider): `auth:signIn` returns a JWT plus refresh token, the same action
 * exchanges the refresh token for a new pair, and `auth:signOut` ends the
 * server session. For OAuth, `auth:signIn` returns the provider redirect and a
 * verifier; the backend sends the browser back with a `code` that, together
 * with the verifier, signs in.
 */
export const reatomConvexAuthAdapter = (
	transport: AtomLike<ConvexAuthTransport>,
	name: string,
): AuthAdapter => {
	const keys = convexAuthStorageKeys(name)
	const tokens = atom(() => readTokens(keys), `${name}.tokens`).extend(
		withChangeHook((next) => {
			if (next) {
				localStorage.setItem(keys.token, next.token)
				localStorage.setItem(keys.refreshToken, next.refreshToken)
			} else {
				localStorage.removeItem(keys.token)
				localStorage.removeItem(keys.refreshToken)
			}
		}),
	)

	const user = computed(() => {
		const current = tokens()
		const email = current && readJwtClaims(current.token)?.['email']
		return typeof email === 'string' ? { email } : null
	}, `${name}.user`)

	const passwordFlow = (flow: 'signIn' | 'signUp') =>
		action(async ({ email, password }: Credentials) => {
			const result = await wrap(
				transport().signIn({ provider: 'password', params: { email, password, flow } }),
			)
			if (!result.tokens) throw new Error('Convex Auth returned no session')
			tokens.set(result.tokens)
		}, `${name}.${flow}`)

	const startGitHubSignIn = action(async (returnTo: string) => {
		const result = await wrap(
			transport().signIn({ provider: 'github', params: { redirectTo: returnTo } }),
		)
		if (!result.redirect || !result.verifier) throw new Error('Convex Auth returned no redirect')
		localStorage.setItem(keys.verifier, result.verifier)
		return result.redirect
	}, `${name}.startGitHubSignIn`)

	const completeRedirect = action(async (params: URLSearchParams) => {
		const code = params.get('code')
		const verifier = localStorage.getItem(keys.verifier)
		localStorage.removeItem(keys.verifier)
		if (!code || !verifier) throw new Error('No sign-in in progress')
		const result = await wrap(transport().signIn({ params: { code }, verifier }))
		if (!result.tokens) throw new Error('Convex Auth returned no session')
		tokens.set(result.tokens)
	}, `${name}.completeRedirect`)

	const fetchToken = action(async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
		const current = tokens()
		if (!current) return null
		if (!forceRefreshToken) return current.token
		const result = await wrap(transport().signIn({ refreshToken: current.refreshToken }))
		tokens.set(result.tokens ?? null)
		return result.tokens?.token ?? null
	}, `${name}.fetchToken`)

	// The local session ends even when the server call fails.
	const signOut = action(async () => {
		const current = tokens()
		tokens.set(null)
		if (current)
			await wrap(
				transport()
					.signOut(current.token)
					.catch(() => {}),
			)
	}, `${name}.signOut`)

	return {
		id: 'convex-auth',
		user,
		fetchToken,
		signIn: passwordFlow('signIn'),
		signUp: passwordFlow('signUp'),
		startGitHubSignIn,
		redirectParams: ['code'],
		completeRedirect,
		signOut,
	}
}
