import type { AtomLike } from '@reatom/core'
import type { AuthTokenFetcher } from 'convex/browser'

export const AUTH_PROVIDERS = ['convex-auth', 'better-auth'] as const
export type AuthProviderId = (typeof AUTH_PROVIDERS)[number]

export type AuthUser = { email: string }

export type Credentials = { email: string; password: string }

/** What the session model needs from an auth library. */
export type AuthAdapter = {
	id: AuthProviderId
	/** Client-side session, before the Convex backend has accepted its token. */
	user: AtomLike<AuthUser | null>
	fetchToken: AuthTokenFetcher
	signIn: (credentials: Credentials) => Promise<void>
	signUp: (credentials: Credentials) => Promise<void>
	signOut: () => Promise<void>
}
