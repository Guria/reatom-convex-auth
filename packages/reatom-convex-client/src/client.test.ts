import type { PaginationResult } from 'convex/server'

import { atom, context, wrap } from '@reatom/core'
import {
	createFakeConvexServer,
	fakeJwt,
	paginate,
	readFakeJwt,
	type FakeConvexServer,
	type FakeConvexServerOptions,
} from 'convex-fake-server'
import { makeFunctionReference } from 'convex/server'
import { ConvexError, type Value } from 'convex/values'
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'

import { reatomConvexClient, type ConvexClientOptions, type ReatomConvexClient } from './client'
import { reatomConvex } from './reatomConvex'

type Item = { _id: string; text: string }

const api = {
	echo: makeFunctionReference<'query', { value: string }, string>('test:echo'),
	whoami: makeFunctionReference<'query', Record<string, never>, string | null>('test:whoami'),
	count: makeFunctionReference<'query', Record<string, never>, number>('test:count'),
	items: makeFunctionReference<
		'query',
		{ paginationOpts: { numItems: number; cursor: string | null } },
		PaginationResult<Item>
	>('test:items'),
	add: makeFunctionReference<'mutation', { text: string }, string>('test:add'),
	reject: makeFunctionReference<'mutation', { text: string }, string>('test:reject'),
	shout: makeFunctionReference<'action', { text: string }, string>('test:shout'),
	fail: makeFunctionReference<'action', Record<string, never>, string>('test:fail'),
	hang: makeFunctionReference<'action', Record<string, never>, string>('test:hang'),
}

type Sent = { type: string } & Record<string, unknown>

let server: FakeConvexServer
let client: ReatomConvexClient
let items: Item[]
let sent: Sent[]
const clients: ReatomConvexClient[] = []

/** The fake server's socket, recording what the client sends. */
const recordingSocket = (base: typeof WebSocket) =>
	class extends (base as unknown as new (url: string) => WebSocket) {
		override send(data: string) {
			sent.push(JSON.parse(data) as Sent)
			super.send(data)
		}
	} as unknown as typeof WebSocket

const startServer = (options: Partial<FakeConvexServerOptions> = {}) =>
	createFakeConvexServer({
		queries: {
			'test:echo': (_ctx, { value }) => value,
			'test:whoami': (ctx) => ctx.identity?.subject ?? null,
			'test:count': () => items.length,
			'test:items': (ctx, { paginationOpts }) => paginate(ctx, items, paginationOpts!),
		},
		mutations: {
			'test:add': (_ctx, { text }) => {
				const item = { _id: `item${items.length}`, text: String(text) }
				items.unshift(item)
				return item._id
			},
			'test:reject': () => {
				throw new ConvexError({ code: 'rejected' })
			},
		},
		actions: {
			'test:shout': (_ctx, { text }) => String(text).toUpperCase(),
			'test:fail': () => {
				throw new Error('Action failed')
			},
			'test:hang': () => new Promise(() => {}),
		},
		authenticate: (token) => {
			const { sub } = readFakeJwt(token)
			return sub === 'ada' ? { subject: 'ada' } : 'Unknown user'
		},
		...options,
	})

const createClient = (options: ConvexClientOptions = {}) => {
	const created = reatomConvexClient(
		'https://fake.convex.cloud',
		{
			webSocketConstructor: recordingSocket(server.WebSocket),
			unsavedChangesWarning: false,
			logger: false,
			...options,
		},
		'client',
	)
	clients.push(created)
	return created
}

const querySetMessages = () => sent.filter((message) => message.type === 'ModifyQuerySet')

beforeEach(() => {
	context.reset()
	items = []
	sent = []
	server = startServer()
	client = createClient()
})

afterEach(async () => {
	await Promise.all(clients.splice(0).map((created) => created.close()))
	server.close()
})

const eventually = (assertion: () => void) => vi.waitFor(assertion, { timeout: 5000 })

test('dedupes subscriptions by query token', async () => {
	const convex = reatomConvex(() => client, 'convex')
	const first = convex.query(api.echo, () => ({ value: 'a' }), 'first')
	const second = convex.query(api.echo, () => ({ value: 'a' }), 'second')
	const other = convex.query(api.echo, () => ({ value: 'b' }), 'other')
	const unsubscribes = [first, second, other].map((model) => model.data.subscribe(() => {}))
	await eventually(() =>
		expect([first.data(), second.data(), other.data()]).toEqual(['a', 'a', 'b']),
	)
	expect(server.subscriptionCount('test:echo')).toBe(2)
	// One message for the burst.
	expect(querySetMessages()).toHaveLength(1)

	unsubscribes[0]!()
	await server.settled()
	expect(server.subscriptionCount('test:echo')).toBe(2)
	unsubscribes[1]!()
	unsubscribes[2]!()
	await eventually(() => expect(server.subscriptionCount('test:echo')).toBe(0))
	expect(querySetMessages()).toHaveLength(2)
})

test('keeps the server subscription when a query is resubscribed in the same tick', async () => {
	const convex = reatomConvex(() => client, 'convex')
	const echo = convex.query(api.echo, () => ({ value: 'a' }), 'echo')
	const unsubscribe = echo.data.subscribe(() => {})
	await eventually(() => expect(echo.data()).toBe('a'))
	const before = querySetMessages().length

	unsubscribe()
	const again = echo.data.subscribe(() => {})
	await server.settled()
	expect(querySetMessages()).toHaveLength(before)
	expect(echo.data()).toBe('a')
	expect(server.subscriptionCount('test:echo')).toBe(1)
	again()
})

test.each([
	['per-message', true, 1],
	['coalesced', true, 1],
	['per-message', false, 10],
	['coalesced', false, 1],
] as const)(
	'%s responses with batchQuerySet %s deliver every result in %i transitions',
	async (queryResponses, batchQuerySet, transitions) => {
		server.close()
		server = startServer({ queryResponses })
		const local = createClient({ batchQuerySet })
		const convex = reatomConvex(() => local, 'convex')
		const unsubscribeConnection = convex.connectionState.subscribe(() => {})
		await eventually(() => expect(convex.connectionState().isWebSocketConnected).toBe(true))
		await server.settled()
		const before = server.transitionCount()
		const models = Array.from({ length: 10 }, (_, index) =>
			convex.query(api.echo, () => ({ value: `v${index}` }), `echo${index}`),
		)
		const unsubscribes = models.map((model) => model.data.subscribe(() => {}))
		await eventually(() =>
			expect(models.map((model) => model.data())).toEqual(models.map((_, index) => `v${index}`)),
		)
		expect(server.transitionCount() - before).toBe(transitions)

		unsubscribes.forEach((unsubscribe) => unsubscribe())
		await eventually(() => expect(server.subscriptionCount('test:echo')).toBe(0))
		unsubscribeConnection()
	},
)

test('resolves a mutation once its write is visible to queries', async () => {
	const convex = reatomConvex(() => client, 'convex')
	const count = convex.query(api.count, () => ({}), 'count')
	const unsubscribe = count.data.subscribe(() => {})
	await eventually(() => expect(count.data()).toBe(0))

	const id = await wrap(convex.mutation(api.add, 'add')({ text: 'one' }))
	expect(id).toBe('item0')
	expect(count.data()).toBe(1)
	expect(client.connectionState().inflightMutations).toBe(0)
	unsubscribe()
})

test('rejects failed mutations and actions with their error data', async () => {
	const convex = reatomConvex(() => client, 'convex')
	const reject = convex.mutation(api.reject, 'reject')
	const error = await wrap(reject({ text: 'x' })).catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(ConvexError)
	expect((error as ConvexError<Value>).data).toEqual({ code: 'rejected' })
	expect((error as Error).message).toContain('[CONVEX M(test:reject)]')
	expect(reject.error()).toBe(error)

	await expect(wrap(convex.action(api.shout, 'shout')({ text: 'hi' }))).resolves.toBe('HI')
	await expect(wrap(convex.action(api.fail, 'fail')({}))).rejects.toThrow(
		'[CONVEX A(test:fail)] Action failed',
	)
})

test('drops an optimistic update when its mutation is confirmed or rejected', async () => {
	const convex = reatomConvex(() => client, 'convex')
	const count = convex.query(api.count, () => ({}), 'count')
	const unsubscribe = count.data.subscribe(() => {})
	await eventually(() => expect(count.data()).toBe(0))
	const bump = (
		store: Parameters<
			NonNullable<Parameters<typeof convex.mutation>[2]>['optimisticUpdate'] & {}
		>[0],
	) => {
		const current = store.getQuery(api.count, {})
		if (current !== undefined) store.setQuery(api.count, {}, current + 100)
	}

	const add = convex.mutation(api.add, 'add', { optimisticUpdate: bump })
	const confirmed = wrap(add({ text: 'one' }))
	expect(count.data()).toBe(100)
	expect(client.optimisticUpdates()).toHaveLength(1)
	await confirmed
	expect(count.data()).toBe(1)
	expect(client.optimisticUpdates()).toHaveLength(0)

	const reject = convex.mutation(api.reject, 'reject', { optimisticUpdate: bump })
	const rejected = wrap(reject({ text: 'two' })).catch(() => 'rejected')
	expect(count.data()).toBe(101)
	await expect(rejected).resolves.toBe('rejected')
	expect(count.data()).toBe(1)
	unsubscribe()
})

test('keeps later optimistic updates on top of new server results', async () => {
	const convex = reatomConvex(() => client, 'convex')
	const count = convex.query(api.count, () => ({}), 'count')
	const unsubscribe = count.data.subscribe(() => {})
	await eventually(() => expect(count.data()).toBe(0))
	const add = convex.mutation(api.add, 'add', {
		optimisticUpdate: (store) => {
			const current = store.getQuery(api.count, {})
			const all = store.getAllQueries(api.count)
			expect(all).toHaveLength(1)
			if (current !== undefined) store.setQuery(api.count, {}, current + 10)
		},
	})
	const first = wrap(add({ text: 'one' }))
	const second = wrap(add({ text: 'two' }))
	expect(count.data()).toBe(20)
	await first
	// The second update replays over the first write.
	expect(count.data()).toBeGreaterThanOrEqual(11)
	await second
	expect(count.data()).toBe(2)
	unsubscribe()
})

test('shows an optimistic result for a query subscribed after the update', async () => {
	const convex = reatomConvex(() => client, 'convex')
	const add = convex.mutation(api.add, 'add', {
		optimisticUpdate: (store) => store.setQuery(api.echo, { value: 'later' }, 'optimistic'),
	})
	const done = wrap(add({ text: 'one' }))
	const echo = convex.query(api.echo, () => ({ value: 'later' }), 'echo')
	expect(echo.data()).toBe('optimistic')
	expect(client.localQueryResult('test:echo', { value: 'later' })).toBe('optimistic')
	const unsubscribe = echo.data.subscribe(() => {})
	await done
	await eventually(() => expect(echo.data()).toBe('later'))
	unsubscribe()
})

test('sets, refreshes and clears auth', async () => {
	const convex = reatomConvex(() => client, 'convex')
	const fetchToken = vi.fn(async ({ forceRefreshToken }: { forceRefreshToken: boolean }) =>
		fakeJwt({ sub: 'ada', fresh: forceRefreshToken }),
	)
	const whoami = convex.query(api.whoami, () => ({}), 'whoami')
	const unsubscribe = whoami.data.subscribe(() => {})
	await eventually(() => expect(whoami.data()).toBeNull())

	convex.setAuth(fetchToken)
	await eventually(() => expect(convex.serverAuthenticated()).toBe(true))
	await eventually(() => expect(whoami.data()).toBe('ada'))
	// A cached token first, then a fresh one once the server accepts it.
	await eventually(() => expect(client.auth().state).toBe('waitingForScheduledRefetch'))
	expect(fetchToken.mock.calls.map(([args]) => args.forceRefreshToken)).toEqual([false, true])
	expect(client.identityVersion()).toBe(2)

	fetchToken.mockClear()
	server.expireAuth()
	await eventually(() => expect(fetchToken).toHaveBeenCalledWith({ forceRefreshToken: true }))
	await eventually(() => expect(client.auth().state).toBe('waitingForScheduledRefetch'))
	expect(convex.isRefreshingAuth()).toBe(false)
	expect(whoami.data()).toBe('ada')

	convex.clearAuth()
	expect(client.auth().state).toBe('noAuth')
	await eventually(() => expect(whoami.data()).toBeNull())
	unsubscribe()
})

test('reports a token the server rejects and a fetcher with no token', async () => {
	const convex = reatomConvex(() => client, 'convex')
	convex.setAuth(async () => fakeJwt({ sub: 'mallory' }))
	await eventually(() => expect(convex.serverAuthenticated()).toBe(false))
	expect(client.authToken()).toBeUndefined()

	convex.setAuth(async () => null)
	await eventually(() => expect(convex.serverAuthenticated()).toBe(false))
	expect(client.auth().state).toBe('noAuth')
})

test('holds queries until the first token with expectAuth', async () => {
	const local = createClient({ expectAuth: true })
	const convex = reatomConvex(() => local, 'convex')
	const whoami = convex.query(api.whoami, () => ({}), 'whoami')
	const unsubscribe = whoami.data.subscribe(() => {})
	await server.settled()
	await server.settled()
	expect(server.subscriptionCount('test:whoami')).toBe(0)

	convex.setAuth(async () => fakeJwt({ sub: 'ada' }))
	await eventually(() => expect(whoami.data()).toBe('ada'))
	// The first result already carries the identity.
	expect(whoami.status()).toBe('success')
	unsubscribe()
})

test('replays the query set, auth and pending mutations after a reconnect', async () => {
	const convex = reatomConvex(() => client, 'convex')
	const whoami = convex.query(api.whoami, () => ({}), 'whoami')
	const count = convex.query(api.count, () => ({}), 'count')
	const unsubscribes = [whoami, count].map((model) => model.data.subscribe(() => {}))
	convex.setAuth(async () => fakeJwt({ sub: 'ada' }))
	await eventually(() => expect(whoami.data()).toBe('ada'))
	await eventually(() => expect(count.data()).toBe(0))
	const hanging = wrap(convex.action(api.hang, 'hang')({})).catch((error: Error) => error.message)

	server.setOnline(false)
	await eventually(() => expect(client.connectionState().isWebSocketConnected).toBe(false))
	const added = wrap(convex.mutation(api.add, 'add')({ text: 'offline' }))
	expect(client.requests().get(1)?.status).toBe('NotSent')

	sent = []
	server.setOnline(true)
	// In-flight actions fail on reconnect: they are not idempotent.
	await expect(hanging).resolves.toContain('Connection lost while action was in flight')
	await expect(added).resolves.toBe('item0')
	expect(count.data()).toBe(1)
	expect(whoami.data()).toBe('ada')
	expect(server.subscriptionCount('test:whoami') + server.subscriptionCount('test:count')).toBe(2)
	expect(sent.map(({ type }) => type).slice(0, 4)).toEqual([
		'Connect',
		'Authenticate',
		'ModifyQuerySet',
		'Mutation',
	])
	expect(sent[0]).toMatchObject({ connectionCount: 1, lastCloseReason: 'Fake network drop' })
	expect(sent[2]).toMatchObject({ baseVersion: 0, newVersion: 1 })
	expect(client.connectionState().connectionCount).toBe(2)
	await eventually(() => expect(client.connectionState().connectionRetries).toBe(0))
	unsubscribes.forEach((unsubscribe) => unsubscribe())
})

test('tracks unsubscribes made while offline', async () => {
	const convex = reatomConvex(() => client, 'convex')
	const enabled = atom(true, 'enabled')
	const echo = convex.query(api.echo, () => (enabled() ? { value: 'a' } : 'skip'), 'echo')
	const unsubscribe = echo.status.subscribe(() => {})
	await eventually(() => expect(echo.data()).toBe('a'))

	server.setOnline(false)
	await eventually(() => expect(client.connectionState().isWebSocketConnected).toBe(false))
	enabled.set(false)
	await Promise.resolve()
	expect(echo.status()).toBe('skipped')

	server.setOnline(true)
	await eventually(() => expect(client.connectionState().isWebSocketConnected).toBe(true))
	await server.settled()
	expect(server.subscriptionCount('test:echo')).toBe(0)
	unsubscribe()
})

test('loads pages and keeps them live', async () => {
	items = Array.from({ length: 5 }, (_, index) => ({ _id: `seed${index}`, text: `seed ${index}` }))
	const convex = reatomConvex(() => client, 'convex')
	const list = convex.paginatedQuery(api.items, () => ({}), { initialNumItems: 2 }, 'list')
	const unsubscribe = list.results.subscribe(() => {})
	await eventually(() => expect(list.status()).toBe('CanLoadMore'))
	expect(list.loadMore(2)).toBe(true)
	expect(list.loadMore(2)).toBe(false)
	expect(list.isLoading()).toBe(true)
	await eventually(() => expect(list.results()).toHaveLength(4))

	await wrap(convex.mutation(api.add, 'add')({ text: 'new' }))
	await eventually(() => expect(list.results()[0]?.text).toBe('new'))
	expect(list.results()).toHaveLength(5)
	unsubscribe()
	await eventually(() => expect(server.subscriptionCount('test:items')).toBe(0))
})

test('splits a page the server asks to split', async () => {
	type Opts = { numItems: number; cursor: string | null; endCursor?: string }
	const all = Array.from({ length: 6 }, (_, index) => ({ _id: `i${index}`, text: `item ${index}` }))
	server.close()
	server = startServer({
		queries: {
			'test:items': (_ctx, { paginationOpts }) => {
				const { cursor, endCursor, numItems } = paginationOpts as Opts
				const start = cursor === null ? 0 : all.findIndex(({ _id }) => _id === cursor) + 1
				const end =
					endCursor === undefined
						? Math.min(start + numItems, all.length)
						: all.findIndex(({ _id }) => _id === endCursor) + 1
				const page = all.slice(start, end)
				// The first page comes back too large and asks to be split in half.
				const split = cursor === null && endCursor === undefined
				return {
					page,
					isDone: end >= all.length,
					continueCursor: page.at(-1)!._id,
					...(split ? { splitCursor: page[2]!._id, pageStatus: 'SplitRequired' } : {}),
				}
			},
		},
	})
	const local = createClient()
	const convex = reatomConvex(() => local, 'convex')
	const list = convex.paginatedQuery(api.items, () => ({}), { initialNumItems: 6 }, 'list')
	const unsubscribe = list.results.subscribe(() => {})
	await eventually(() => expect(list.status()).toBe('Exhausted'))
	// Two halves replace the page, then the original page is unsubscribed.
	await eventually(() => expect(server.subscriptionCount('test:items')).toBe(2))
	expect(list.results().map(({ _id }) => _id)).toEqual(all.map(({ _id }) => _id))
	unsubscribe()
})

test('reports page errors and skips', async () => {
	const convex = reatomConvex(() => client, 'convex')
	const enabled = atom(false, 'enabled')
	const list = convex.paginatedQuery(
		makeFunctionReference<'query'>('test:missing') as typeof api.items,
		() => (enabled() ? {} : 'skip'),
		{ initialNumItems: 2 },
		'list',
	)
	const unsubscribe = list.error.subscribe(() => {})
	expect(list.status()).toBe('Skipped')
	enabled.set(true)
	await eventually(() => expect(list.error()?.message).toContain('Fake server has no query'))
	expect(list.isLoading()).toBe(false)
	expect(list.loadMore(2)).toBe(false)
	unsubscribe()
})

test('validates the deployment URL', () => {
	expect(() => reatomConvexClient('ftp://fake', {}, 'bad')).toThrow('Must start with')
	expect(() => reatomConvexClient('https://x.convex.site', {}, 'bad')).toThrow('.convex.site')
	expect(() => reatomConvexClient('https://', {}, 'bad')).toThrow('not a valid URL')
})

test('clearing auth during a fetch resumes queries and ignores the late token', async () => {
	const local = createClient({ expectAuth: true })
	const convex = reatomConvex(() => local, 'convex')
	const whoami = convex.query(api.whoami, () => ({}), 'whoami')
	const unsubscribe = whoami.data.subscribe(() => {})
	let resolveToken!: (token: string) => void
	convex.setAuth(
		() =>
			new Promise((resolve) => {
				resolveToken = resolve
			}),
	)
	await server.settled()
	convex.clearAuth()
	await eventually(() => expect(whoami.data()).toBeNull())
	resolveToken(fakeJwt({ sub: 'ada' }))
	await server.settled()
	expect(local.authToken()).toBeUndefined()
	expect(convex.serverAuthenticated()).toBe(false)
	unsubscribe()
})

test('a rejected token fetch reports unauthenticated and releases queries', async () => {
	const convex = reatomConvex(() => client, 'convex')
	const whoami = convex.query(api.whoami, () => ({}), 'whoami')
	const unsubscribe = whoami.data.subscribe(() => {})
	convex.setAuth(async () => {
		throw new Error('offline token provider')
	})
	await eventually(() => expect(convex.serverAuthenticated()).toBe(false))
	await eventually(() => expect(whoami.data()).toBeNull())
	expect(client.authToken()).toBeUndefined()
	unsubscribe()
})

test('a disconnected paginated query restarts from its first page', async () => {
	items = Array.from({ length: 6 }, (_, index) => ({ _id: `i${index}`, text: `${index}` }))
	const convex = reatomConvex(() => client, 'convex')
	const list = convex.paginatedQuery(api.items, () => ({}), { initialNumItems: 2 }, 'list')
	const unsubscribe = list.results.subscribe(() => {})
	await eventually(() => expect(list.results()).toHaveLength(2))
	list.loadMore(2)
	await eventually(() => expect(list.results()).toHaveLength(4))
	unsubscribe()
	await eventually(() => expect(server.subscriptionCount('test:items')).toBe(0))
	const again = list.results.subscribe(() => {})
	await eventually(() => expect(list.results()).toHaveLength(2))
	expect(server.subscriptionCount('test:items')).toBe(1)
	again()
})

test('replacing an auth fetch ignores the older answer', async () => {
	const convex = reatomConvex(() => client, 'convex')
	const whoami = convex.query(api.whoami, () => ({}), 'whoami')
	const unsubscribe = whoami.data.subscribe(() => {})
	let resolveOld!: (token: string) => void
	convex.setAuth(
		() =>
			new Promise((resolve) => {
				resolveOld = resolve
			}),
	)
	convex.setAuth(async () => fakeJwt({ sub: 'ada' }))
	await eventually(() => expect(whoami.data()).toBe('ada'))
	resolveOld(fakeJwt({ sub: 'mallory' }))
	await server.settled()
	expect(convex.serverAuthenticated()).toBe(true)
	expect(whoami.data()).toBe('ada')
	unsubscribe()
})
