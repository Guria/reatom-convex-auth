// In-memory stand-in for the Convex deployment in stories. The app's real
// Convex client talks to it over a fake websocket (see convex-fake-server);
// better-auth's HTTP endpoints are mocked with MSW so its real client and
// cross-domain plugin run. Tokens are unsigned JWTs with the same claims the
// real backend issues (convex/auth.ts, convex/betterAuth.ts).
import type { AuthProviderId, ConvexAuthTransport } from '#shared/api'

import { createFakeConvexServer, fakeJwt, paginate, readFakeJwt } from 'convex-fake-server'
import { reatomConvexClient } from 'convex/browser'
import { ConvexError } from 'convex/values'
import { http, HttpResponse } from 'msw'

import { BETTER_AUTH_BASE_PATH } from '#convex/authPaths'

export const FAKE_CONVEX_SITE_URL = 'https://convex-site.test'
const FAKE_GITHUB_AUTHORIZE_URL = 'https://github.test/login/oauth/authorize'

/** The account fake GitHub signs in as. */
export const FAKE_GITHUB_EMAIL = 'octocat@example.com'

type User = { id: string; provider: AuthProviderId; email: string; password: string }
type Note = { _id: string; _creationTime: number; owner: string; text: string }

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))

export function createFakeConvexBackend() {
	let nextId = 1
	const id = (prefix: string) => `${prefix}${nextId++}`
	const users = new Map<string, User>()
	const refreshTokens = new Map<string, User>()
	const betterAuthSessions = new Map<string, User>()
	const notes: Note[] = []

	const userKey = (provider: AuthProviderId, email: string) => `${provider}:${email}`

	const createUser = (provider: AuthProviderId, email: string, password: string) => {
		if (users.has(userKey(provider, email))) throw new Error('Account already exists')
		const user: User = { id: id('user'), provider, email, password }
		users.set(userKey(provider, email), user)
		return user
	}

	// The first GitHub sign-in creates the account.
	const githubUser = (provider: AuthProviderId) =>
		users.get(userKey(provider, FAKE_GITHUB_EMAIL)) ?? createUser(provider, FAKE_GITHUB_EMAIL, '')

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
		return { token: fakeJwt({ sub, provider: 'convex-auth', email: user.email }), refreshToken }
	}

	// convex/viewer.ts: the owner is the provider plus its user id.
	const server = createFakeConvexServer({
		authenticate: (token) => {
			const { sub, provider, email } = readFakeJwt(token)
			if (typeof sub !== 'string' || typeof email !== 'string') return 'Invalid token'
			if (provider !== 'convex-auth' && provider !== 'better-auth') return 'Unknown provider'
			const userId = provider === 'convex-auth' ? sub.split('|')[0] : sub
			return { subject: sub, owner: `${provider}:${userId}`, provider, email }
		},
		queries: {
			'viewer:current': ({ identity }) =>
				identity && {
					owner: identity['owner'],
					provider: identity['provider'],
					email: identity['email'],
				},
			'notes:list': (ctx, { paginationOpts }) => {
				if (!ctx.identity) throw new ConvexError('Not authenticated')
				const owner = ctx.identity['owner']
				const owned = notes.filter((note) => note.owner === owner).toReversed()
				return paginate(ctx, owned, paginationOpts!)
			},
		},
		mutations: {
			'notes:add': ({ identity }, { text }) => {
				if (!identity) throw new ConvexError('Not authenticated')
				const note: Note = {
					_id: id('note'),
					_creationTime: Date.now(),
					owner: String(identity['owner']),
					text: String(text).trim(),
				}
				notes.push(note)
				return note._id
			},
		},
	})

	// Convex Auth OAuth: the verifier rides to the backend's sign-in route as
	// `code`; the browser comes back with another code bound to that verifier.
	const convexAuthCodes = new Map<string, { user: User; verifier: string }>()

	const convexAuth: ConvexAuthTransport = {
		async signIn({ provider, params, verifier, refreshToken }) {
			if (refreshToken) {
				const user = refreshTokens.get(refreshToken)
				return { tokens: user ? convexAuthTokens(user) : null }
			}
			if (provider === 'github') {
				const redirect = new URL(`${FAKE_CONVEX_SITE_URL}/api/auth/signin/github`)
				const started = id('verifier')
				redirect.searchParams.set('code', started)
				redirect.searchParams.set('redirectTo', String(params?.['redirectTo']))
				return { redirect: redirect.href, verifier: started }
			}
			if (params?.['code'] !== undefined) {
				const pending = convexAuthCodes.get(String(params['code']))
				convexAuthCodes.delete(String(params['code']))
				if (!pending || pending.verifier !== verifier) throw new Error('Invalid verification code')
				return { tokens: convexAuthTokens(pending.user) }
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

	// better-auth OAuth: the state names where the callback sends the browser
	// back, with a one-time token for the new session.
	const betterAuthStates = new Map<string, string>()
	const betterAuthOneTimeTokens = new Map<string, User>()

	const betterAuth = {
		signInSocial: (body: { callbackURL: string }) => {
			const state = id('state')
			betterAuthStates.set(state, body.callbackURL)
			return HttpResponse.json({
				url: `${FAKE_GITHUB_AUTHORIZE_URL}?state=${state}`,
				redirect: false,
			})
		},
		verifyOneTimeToken: async (body: { token: string }) => {
			const user = betterAuthOneTimeTokens.get(body.token)
			betterAuthOneTimeTokens.delete(body.token)
			if (!user) throw new Error('Invalid token')
			return startBetterAuthSession(user)
		},
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
				token: fakeJwt({ sub: user.id, provider: 'better-auth', email: user.email }),
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
		server,
		/** A real Convex client connected to this deployment. */
		createClient: () =>
			reatomConvexClient('https://fake.convex.cloud', {
				webSocketConstructor: server.WebSocket,
				skipConvexDeploymentUrlCheck: true,
				unsavedChangesWarning: false,
			}),
		convexAuth,
		betterAuth,
		/**
		 * GitHub approving the sign-in the app sent the browser to, and the
		 * backend's callback: returns the URL the browser lands on.
		 */
		approveGitHubSignIn(url: string) {
			const target = new URL(url)
			if (target.href.startsWith(FAKE_GITHUB_AUTHORIZE_URL)) {
				const callbackURL = betterAuthStates.get(target.searchParams.get('state') ?? '')
				if (!callbackURL) throw new Error(`Unknown better-auth state in ${url}`)
				const landing = new URL(callbackURL)
				const ott = id('ott')
				betterAuthOneTimeTokens.set(ott, githubUser('better-auth'))
				landing.searchParams.set('ott', ott)
				return landing.href
			}
			const verifier = target.searchParams.get('code')
			const redirectTo = target.searchParams.get('redirectTo')
			if (!verifier || !redirectTo) throw new Error(`Unknown sign-in URL ${url}`)
			const code = id('code')
			convexAuthCodes.set(code, { user: githubUser('convex-auth'), verifier })
			const landing = new URL(redirectTo)
			landing.searchParams.set('code', code)
			return landing.href
		},
		/** Seeds a Convex Auth account and returns tokens for a restored session. */
		seedConvexAuthSession(email: string, password: string) {
			return convexAuthTokens(createUser('convex-auth', email, password))
		},
		/** Seeds notes for the Convex Auth account with `email`, oldest first. */
		seedNotes(email: string, texts: string[]) {
			const user = users.get(userKey('convex-auth', email))
			if (!user) throw new Error(`No Convex Auth account for ${email}`)
			for (const text of texts)
				notes.push({
					_id: id('note'),
					_creationTime: Date.now(),
					owner: `convex-auth:${user.id}`,
					text,
				})
		},
		/** Server-side subscriptions to a query, e.g. `notes:list`. */
		subscriptionCount: server.subscriptionCount,
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
	http.post(betterAuthUrl('/sign-in/social'), async ({ request }) => {
		const body = (await request.json()) as { callbackURL: string }
		return fakeConvexBackend.current.betterAuth.signInSocial(body)
	}),
	http.post(betterAuthUrl('/cross-domain/one-time-token/verify'), async ({ request }) => {
		const body = (await request.json()) as { token: string }
		return fakeConvexBackend.current.betterAuth.verifyOneTimeToken(body).catch(errorResponse)
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
