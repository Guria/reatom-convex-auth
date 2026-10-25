// In-memory stand-in for the Convex deployment in stories. Convex speaks a
// websocket protocol MSW cannot intercept, so the app's transports are
// replaced instead; better-auth's HTTP endpoints are still mocked with MSW so
// its real client and cross-domain plugin run. Tokens are unsigned JWTs with
// the same claims the real backend issues (convex/auth.ts, convex/betterAuth.ts).
import type { AuthProviderId, ConvexAuthTransport, ConvexTransport } from '#shared/api'
import type { FunctionReference, FunctionReturnType } from 'convex/server'

import { getFunctionName } from 'convex/server'
import { http, HttpResponse } from 'msw'

import { BETTER_AUTH_BASE_PATH } from '#convex/authPaths'

export const FAKE_CONVEX_SITE_URL = 'https://convex-site.test'

type User = { id: string; provider: AuthProviderId; email: string; password: string }
type Identity = { owner: string; provider: AuthProviderId; email: string }
type Note = { _id: string; _creationTime: number; owner: string; text: string }
type Subscription = { name: string; deliver: () => void }

const base64url = (value: unknown) =>
	btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const issueJwt = (claims: Record<string, string>) =>
	`${base64url({ alg: 'none' })}.${base64url(claims)}.fake`

const readClaims = (token: string): Record<string, unknown> => {
	const payload = token.split('.')[1] ?? ''
	return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>
}

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))

export function createFakeConvexBackend() {
	let nextId = 1
	const id = (prefix: string) => `${prefix}${nextId++}`
	const users = new Map<string, User>()
	const refreshTokens = new Map<string, User>()
	const betterAuthSessions = new Map<string, User>()
	const notes: Note[] = []
	const subscriptions = new Set<Subscription>()
	let identity: Identity | null = null

	const userKey = (provider: AuthProviderId, email: string) => `${provider}:${email}`

	const createUser = (provider: AuthProviderId, email: string, password: string) => {
		if (users.has(userKey(provider, email))) throw new Error('Account already exists')
		const user: User = { id: id('user'), provider, email, password }
		users.set(userKey(provider, email), user)
		return user
	}

	const findUser = (provider: AuthProviderId, email: string, password: string) => {
		const user = users.get(userKey(provider, email))
		if (!user || user.password !== password) throw new Error('InvalidSecret')
		return user
	}

	// Convex Auth's subject is `userId|sessionId`; better-auth's is the user id.
	const convexAuthTokens = (user: User) => {
		const refreshToken = id('refresh')
		refreshTokens.set(refreshToken, user)
		const sub = `${user.id}|${id('session')}`
		return { token: issueJwt({ sub, provider: 'convex-auth', email: user.email }), refreshToken }
	}

	const verify = (token: string): Identity | null => {
		const { sub, provider, email } = readClaims(token)
		if (typeof sub !== 'string' || typeof email !== 'string') return null
		if (provider !== 'convex-auth' && provider !== 'better-auth') return null
		const userId = provider === 'convex-auth' ? sub.split('|')[0] : sub
		return { owner: `${provider}:${userId}`, provider, email }
	}

	const requireIdentity = () => {
		if (!identity) throw new Error('Not authenticated')
		return identity
	}

	const runQuery = (name: string): unknown => {
		switch (name) {
			case 'viewer:current':
				return identity
			case 'notes:list': {
				const { owner } = requireIdentity()
				return notes.filter((note) => note.owner === owner).toReversed()
			}
			default:
				throw new Error(`Fake backend has no query ${name}`)
		}
	}

	const notifyAll = () => subscriptions.forEach((subscription) => subscription.deliver())

	// Answers arrive on a later task, like a network round trip.
	const later = (fn: () => void) => void setTimeout(fn, 0)

	const transport: ConvexTransport = {
		onUpdate<Query extends FunctionReference<'query'>>(
			query: Query,
			_args: unknown,
			onResult: (result: FunctionReturnType<Query>) => void,
			onError: (error: Error) => void,
		) {
			const name = getFunctionName(query)
			const subscription: Subscription = {
				name,
				deliver: () => {
					try {
						onResult(runQuery(name) as FunctionReturnType<Query>)
					} catch (error) {
						onError(toError(error))
					}
				},
			}
			subscriptions.add(subscription)
			later(() => subscriptions.has(subscription) && subscription.deliver())
			return () => void subscriptions.delete(subscription)
		},
		async mutation<Mutation extends FunctionReference<'mutation'>>(
			mutation: Mutation,
			args: Record<string, unknown>,
		) {
			const name = getFunctionName(mutation)
			if (name !== 'notes:add') throw new Error(`Fake backend has no mutation ${name}`)
			const { owner } = requireIdentity()
			const note: Note = {
				_id: id('note'),
				_creationTime: Date.now(),
				owner,
				text: String(args['text']),
			}
			notes.push(note)
			later(notifyAll)
			return note._id as FunctionReturnType<Mutation>
		},
		setAuth(fetchToken, onChange) {
			void fetchToken({ forceRefreshToken: false }).then((token) => {
				identity = token ? verify(token) : null
				later(() => {
					onChange(identity !== null)
					notifyAll()
				})
			})
		},
		clearAuth() {
			identity = null
			later(notifyAll)
		},
	}

	const convexAuth: ConvexAuthTransport = {
		async signIn({ params, refreshToken }) {
			if (refreshToken) {
				const user = refreshTokens.get(refreshToken)
				return { tokens: user ? convexAuthTokens(user) : null }
			}
			const { email, password, flow } = params as Record<string, string>
			if (!email || !password) throw new Error('Missing credentials')
			const user =
				flow === 'signUp'
					? createUser('convex-auth', email, password)
					: findUser('convex-auth', email, password)
			return { tokens: convexAuthTokens(user) }
		},
		async signOut() {},
	}

	const betterAuthSession = (cookie: string | null) => {
		const token = cookie?.match(/better-auth\.session_token=([^;]+)/)?.[1]
		return token ? betterAuthSessions.get(token) : undefined
	}

	const startBetterAuthSession = (user: User) => {
		const token = id('ba-session')
		betterAuthSessions.set(token, user)
		return HttpResponse.json(
			{ token, user: { id: user.id, email: user.email, name: user.email } },
			{
				headers: {
					'set-better-auth-cookie': `better-auth.session_token=${token}; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax`,
				},
			},
		)
	}

	const betterAuth = {
		signUp: async (body: { email: string; password: string }) =>
			startBetterAuthSession(createUser('better-auth', body.email, body.password)),
		signIn: async (body: { email: string; password: string }) =>
			startBetterAuthSession(findUser('better-auth', body.email, body.password)),
		getSession: (cookie: string | null) => {
			const user = betterAuthSession(cookie)
			return HttpResponse.json(
				user
					? {
							session: { id: 'session', userId: user.id, expiresAt: '2999-01-01T00:00:00Z' },
							user: { id: user.id, email: user.email, name: user.email },
						}
					: null,
			)
		},
		token: (cookie: string | null) => {
			const user = betterAuthSession(cookie)
			if (!user) return HttpResponse.json(null, { status: 401 })
			return HttpResponse.json({
				token: issueJwt({ sub: user.id, provider: 'better-auth', email: user.email }),
			})
		},
		signOut: (cookie: string | null) => {
			const token = cookie?.match(/better-auth\.session_token=([^;]+)/)?.[1]
			if (token) betterAuthSessions.delete(token)
			return HttpResponse.json(
				{ success: true },
				{
					headers: {
						'set-better-auth-cookie': 'better-auth.session_token=; Max-Age=0; Path=/',
					},
				},
			)
		},
	}

	return {
		transport,
		convexAuth,
		betterAuth,
		/** Seeds a Convex Auth account and returns tokens for a restored session. */
		seedConvexAuthSession(email: string, password: string) {
			return convexAuthTokens(createUser('convex-auth', email, password))
		},
		/** Active `onUpdate` subscriptions to a query, e.g. `notes:list`. */
		subscriptionCount: (name: string) =>
			[...subscriptions].filter((subscription) => subscription.name === name).length,
		noteTexts: () => notes.map((note) => note.text),
	}
}

export type FakeConvexBackend = ReturnType<typeof createFakeConvexBackend>

let current: FakeConvexBackend | null = null

/** The backend of the story being rendered; the preview sets it per story. */
export const fakeConvexBackend = {
	get current() {
		if (!current) throw new Error('No fake Convex backend for this story')
		return current
	},
	set current(backend: FakeConvexBackend) {
		current = backend
	},
}

const errorResponse = (error: unknown) =>
	HttpResponse.json({ message: toError(error).message }, { status: 401 })

const betterAuthUrl = (path: string) => `${FAKE_CONVEX_SITE_URL}${BETTER_AUTH_BASE_PATH}${path}`

export const fakeBetterAuthHandlers = [
	http.post(betterAuthUrl('/sign-up/email'), async ({ request }) => {
		const body = (await request.json()) as { email: string; password: string }
		return fakeConvexBackend.current.betterAuth.signUp(body).catch(errorResponse)
	}),
	http.post(betterAuthUrl('/sign-in/email'), async ({ request }) => {
		const body = (await request.json()) as { email: string; password: string }
		return fakeConvexBackend.current.betterAuth.signIn(body).catch(errorResponse)
	}),
	http.get(betterAuthUrl('/get-session'), ({ request }) =>
		fakeConvexBackend.current.betterAuth.getSession(request.headers.get('better-auth-cookie')),
	),
	http.get(betterAuthUrl('/convex/token'), ({ request }) =>
		fakeConvexBackend.current.betterAuth.token(request.headers.get('better-auth-cookie')),
	),
	http.post(betterAuthUrl('/sign-out'), ({ request }) =>
		fakeConvexBackend.current.betterAuth.signOut(request.headers.get('better-auth-cookie')),
	),
]
