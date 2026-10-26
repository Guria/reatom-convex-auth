// Real-backend smoke check: both auth providers against one running deployment
// (`mise run convex:dev`). Reads VITE_CONVEX_URL / VITE_CONVEX_SITE_URL from
// .env.local.
import { clearStack, context } from '@reatom/core'
import { ConvexHttpClient } from 'convex/browser'
import { readFileSync } from 'node:fs'

import { api } from '../convex/_generated/api.js'
import { reatomConvex, reatomConvexClient } from '../packages/reatom-convex-client/src/index.js'

const env = Object.fromEntries(
	readFileSync('.env.local', 'utf8')
		.split('\n')
		.map((line) => line.match(/^(\w+)=(.*)$/))
		.filter((match) => match !== null)
		.map((match) => [match[1], match[2]]),
)
const url = env['VITE_CONVEX_URL']
const siteUrl = env['VITE_CONVEX_SITE_URL']
if (!url || !siteUrl) throw new Error('.env.local lacks VITE_CONVEX_URL / VITE_CONVEX_SITE_URL')

if (
	process.argv.includes('--native') &&
	!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)
) {
	throw new Error('The native smoke check only writes to a local deployment')
}

const stamp = Date.now()
const password = 'correct-horse-battery'

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`FAIL: ${message}`)
	console.log(`ok: ${message}`)
}

async function convexAuthToken(email: string) {
	const client = new ConvexHttpClient(url)
	const result = await client.action(api.auth.signIn, {
		provider: 'password',
		params: { email, password, flow: 'signUp' },
	})
	check(result.tokens?.token, 'convex-auth sign-up returns a JWT')
	return result.tokens.token
}

async function betterAuthToken(email: string) {
	const base = `${siteUrl}/api/better-auth`
	const signUp = await fetch(`${base}/sign-up/email`, {
		method: 'POST',
		// crossDomainClient always sends this header; its presence makes the server
		// return the session as `Set-Better-Auth-Cookie`.
		headers: {
			'content-type': 'application/json',
			'better-auth-cookie': '',
			origin: 'http://localhost:5173',
		},
		body: JSON.stringify({ email, password, name: 'Smoke' }),
	})
	check(signUp.ok, `better-auth sign-up responds ${signUp.status}`)
	const setCookie = signUp.headers.get('set-better-auth-cookie')
	check(setCookie, 'better-auth sign-up returns a cross-domain cookie')
	const cookie = setCookie.split(';')[0]
	const tokenResponse = await fetch(`${base}/convex/token`, {
		headers: { 'better-auth-cookie': cookie, origin: 'http://localhost:5173' },
	})
	const body = (await tokenResponse.json()) as { token?: string }
	check(body.token, 'better-auth issues a Convex JWT')
	return body.token
}

async function asUser(token: string) {
	const client = new ConvexHttpClient(url)
	client.setAuth(token)
	return client
}

const firstPage = { paginationOpts: { numItems: 10, cursor: null } }
const anonymous = new ConvexHttpClient(url)
check((await anonymous.query(api.viewer.current, {})) === null, 'anonymous viewer is null')
const rejected = await anonymous.query(api.notes.list, firstPage).then(
	() => false,
	() => true,
)
check(rejected, 'anonymous notes.list is rejected')

const caToken = await convexAuthToken(`ca-${stamp}@example.com`)
const baToken = await betterAuthToken(`ba-${stamp}@example.com`)
const convexAuthUser = await asUser(caToken)
const betterAuthUser = await asUser(baToken)

const caViewer = await convexAuthUser.query(api.viewer.current, {})
check(caViewer?.provider === 'convex-auth', 'convex-auth token is accepted, provider claim read')
const baViewer = await betterAuthUser.query(api.viewer.current, {})
check(baViewer?.provider === 'better-auth', 'better-auth token is accepted, provider claim read')

await convexAuthUser.mutation(api.notes.add, { text: 'from convex-auth' })
await betterAuthUser.mutation(api.notes.add, { text: 'from better-auth' })
const { page: caNotes } = await convexAuthUser.query(api.notes.list, firstPage)
const { page: baNotes } = await betterAuthUser.query(api.notes.list, firstPage)
check(
	caNotes.length === 1 && caNotes[0]?.text === 'from convex-auth',
	'convex-auth user sees only own note',
)
check(
	baNotes.length === 1 && baNotes[0]?.text === 'from better-auth',
	'better-auth user sees only own note',
)
console.log('smoke: all checks passed')

// Native websocket protocol check; the HTTP checks above also prove isolation.
if (process.argv.includes('--native')) {
	clearStack()
	const frame = context.start()
	const client = reatomConvexClient(url, { unsavedChangesWarning: false }, 'smoke.client')
	const convex = reatomConvex(() => client, 'smoke')
	const viewer = convex.query(api.viewer.current, () => ({}), 'smoke.viewer')
	const pages = convex.paginatedQuery(
		api.notes.list,
		() => ({}),
		{ initialNumItems: 1 },
		'smoke.pages',
	)
	const unsubscribe = frame.run(() => viewer.data.subscribe(() => {}))
	const waitFor = async (predicate: () => boolean) => {
		const deadline = Date.now() + 15_000
		while (!frame.run(predicate)) {
			if (Date.now() > deadline) throw new Error('Native client smoke timed out')
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
	}
	let stopPages = () => {}
	try {
		await waitFor(() => viewer.data() === null)
		for (const [provider, token] of [
			['convex-auth', caToken],
			['better-auth', baToken],
		] as const) {
			frame.run(() => convex.setAuth(async () => token))
			await waitFor(
				() => convex.serverAuthenticated() === true && viewer.data()?.provider === provider,
			)
			check(true, `native websocket accepts ${provider} token`)
			await frame.run(() =>
				convex.mutation(api.notes.add, 'smoke.seed')({ text: `seed ${provider}` }),
			)
			stopPages = frame.run(() => pages.results.subscribe(() => {}))
			await waitFor(() => pages.status() === 'CanLoadMore' || pages.status() === 'Exhausted')
			check(
				frame.run(() => pages.loadMore(1)),
				`native ${provider} starts a second page`,
			)
			await waitFor(() => pages.results().length === 2)
			const text = `native ${provider}`
			await frame.run(() => convex.mutation(api.notes.add, 'smoke.add')({ text }))
			await waitFor(() => pages.results().some((note) => note.text === text))
			check(true, `native ${provider} mutation is visible in a live page`)
			stopPages()
			frame.run(() => convex.clearAuth())
			await waitFor(() => viewer.data() === null)
		}
		// Use a native websocket action to obtain another real token.
		const signedIn = await frame.run(() =>
			convex.action(
				api.auth.signIn,
				'smoke.signIn',
			)({
				provider: 'password',
				params: { email: `ca-native-${stamp}@example.com`, password, flow: 'signUp' },
			}),
		)
		check(signedIn.tokens?.token, 'native websocket action returns a real JWT')
	} finally {
		stopPages()
		unsubscribe()
		await frame.run(() => client.close())
	}
	console.log('native smoke: all checks passed')
}
