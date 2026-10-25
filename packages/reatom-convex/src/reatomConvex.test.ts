import type { PaginationResult } from 'convex/server'

import { atom, context, wrap } from '@reatom/core'
import {
	createFakeConvexServer,
	fakeJwt,
	paginate,
	readFakeJwt,
	type FakeConvexServer,
} from 'convex-fake-server'
import { ConvexClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'

import { reatomConvex } from './reatomConvex'

type Item = { _id: string; text: string }

const api = {
	echo: makeFunctionReference<'query', { value: string }, string>('test:echo'),
	whoami: makeFunctionReference<'query', Record<string, never>, string | null>('test:whoami'),
	fails: makeFunctionReference<'query', Record<string, never>, string>('test:fails'),
	items: makeFunctionReference<
		'query',
		{ paginationOpts: { numItems: number; cursor: string | null } },
		PaginationResult<Item>
	>('test:items'),
	count: makeFunctionReference<'query', Record<string, never>, number>('test:count'),
	add: makeFunctionReference<'mutation', { text: string }, string>('test:add'),
	shout: makeFunctionReference<'action', { text: string }, string>('test:shout'),
}

let server: FakeConvexServer
let client: ConvexClient
let items: Item[]

const createConvex = () => reatomConvex(() => client, 'convex')

beforeEach(() => {
	context.reset()
	items = []
	server = createFakeConvexServer({
		queries: {
			'test:echo': (_ctx, { value }) => value,
			'test:whoami': (ctx) => ctx.identity?.subject ?? null,
			'test:fails': () => {
				throw new ConvexError('Nope')
			},
			'test:items': (ctx, { paginationOpts }) => paginate(ctx, items, paginationOpts!),
			'test:count': () => items.length,
		},
		mutations: {
			'test:add': (_ctx, { text }) => {
				const item = { _id: `item${items.length}`, text: String(text) }
				items.unshift(item)
				return item._id
			},
		},
		actions: { 'test:shout': (_ctx, { text }) => String(text).toUpperCase() },
		authenticate: (token) => {
			const { sub } = readFakeJwt(token)
			return sub === 'ada' ? { subject: 'ada' } : 'Unknown user'
		},
	})
	client = new ConvexClient('https://fake.convex.cloud', {
		webSocketConstructor: server.WebSocket,
		skipConvexDeploymentUrlCheck: true,
	})
})

afterEach(async () => {
	await client.close()
	server.close()
})

const eventually = (assertion: () => void) => vi.waitFor(assertion, { timeout: 5000 })

test('subscribes while connected, keeps the subscription for equal args, re-subscribes on change', async () => {
	const convex = createConvex()
	const value = atom({ text: 'a' }, 'value')
	const echo = convex.query(api.echo, () => ({ value: value().text }), 'echo')

	expect(server.subscriptionCount('test:echo')).toBe(0)
	const unsubscribe = echo.data.subscribe(() => {})
	expect(echo.isLoading()).toBe(true)
	await eventually(() => expect(echo.data()).toBe('a'))
	expect(server.subscriptionCount('test:echo')).toBe(1)

	// A new args object with the same content keeps the result in place.
	value.set({ text: 'a' })
	await server.settled()
	expect(echo.status()).toBe('success')

	value.set({ text: 'b' })
	await eventually(() => expect(echo.data()).toBe('b'))
	expect(server.subscriptionCount('test:echo')).toBe(1)

	unsubscribe()
	await eventually(() => expect(server.subscriptionCount('test:echo')).toBe(0))
})

test("'skip' holds no subscription", async () => {
	const convex = createConvex()
	const enabled = atom(false, 'enabled')
	const echo = convex.query(api.echo, () => (enabled() ? { value: 'on' } : 'skip'), 'echo')
	const unsubscribe = echo.data.subscribe(() => {})
	await server.settled()
	expect(echo.status()).toBe('skipped')
	expect(echo.isLoading()).toBe(false)
	expect(server.subscriptionCount('test:echo')).toBe(0)

	enabled.set(true)
	await eventually(() => expect(echo.data()).toBe('on'))
	unsubscribe()
})

test('a result the client already holds shows without a loading state', async () => {
	const convex = createConvex()
	const first = convex.query(api.echo, () => ({ value: 'shared' }), 'first')
	const unsubscribeFirst = first.data.subscribe(() => {})
	await eventually(() => expect(first.data()).toBe('shared'))

	const second = convex.query(api.echo, () => ({ value: 'shared' }), 'second')
	const unsubscribeSecond = second.data.subscribe(() => {})
	await Promise.resolve()
	expect(second.data()).toBe('shared')
	expect(server.subscriptionCount('test:echo')).toBe(1)
	unsubscribeFirst()
	unsubscribeSecond()
})

test('stores query errors instead of throwing', async () => {
	const convex = createConvex()
	const fails = convex.query(api.fails, () => ({}), 'fails')
	const unsubscribe = fails.error.subscribe(() => {})
	await eventually(() => expect(fails.status()).toBe('error'))
	expect(fails.error()).toBeInstanceOf(ConvexError)
	expect((fails.error() as ConvexError<string>).data).toBe('Nope')
	expect(fails.data()).toBeUndefined()
	unsubscribe()
})

test('a preloaded payload shows until the live result arrives', async () => {
	const convex = createConvex()
	const echo = convex.preloadedQuery(
		{
			__type: api.echo,
			_name: 'test:echo',
			_argsJSON: { value: 'live' },
			_valueJSON: 'preloaded',
		} as never,
		'echo',
	)
	expect(echo.data()).toBe('preloaded')
	const unsubscribe = echo.data.subscribe(() => {})
	expect(echo.data()).toBe('preloaded')
	await eventually(() => expect(echo.data()).toBe('live'))
	unsubscribe()
})

test('tracks server acknowledgement and refresh of the auth token', async () => {
	const convex = createConvex()
	const fetchToken = vi.fn(async () => fakeJwt({ sub: 'ada' }))
	const whoami = convex.query(api.whoami, () => ({}), 'whoami')
	const unsubscribe = whoami.data.subscribe(() => {})
	const unsubscribeRefreshing = convex.isRefreshingAuth.subscribe(() => {})
	await eventually(() => expect(whoami.data()).toBeNull())

	convex.setAuth(fetchToken)
	expect(convex.serverAuthenticated()).toBeNull()
	await eventually(() => expect(convex.serverAuthenticated()).toBe(true))
	await eventually(() => expect(whoami.data()).toBe('ada'))

	const refreshing: boolean[] = []
	convex.isRefreshingAuth.subscribe((value) => refreshing.push(value))
	fetchToken.mockClear()
	server.expireAuth()
	await eventually(() => expect(refreshing).toEqual([false, true, false]))
	expect(fetchToken).toHaveBeenCalledWith({ forceRefreshToken: true })
	expect(convex.serverAuthenticated()).toBe(true)

	convex.clearAuth()
	expect(convex.serverAuthenticated()).toBe(false)
	await eventually(() => expect(whoami.data()).toBeNull())
	unsubscribe()
	unsubscribeRefreshing()
})

test('reports a rejected token', async () => {
	const convex = createConvex()
	convex.setAuth(async () => fakeJwt({ sub: 'mallory' }))
	await eventually(() => expect(convex.serverAuthenticated()).toBe(false))
})

test('follows the connection state through a network drop', async () => {
	const convex = createConvex()
	const unsubscribe = convex.connectionState.subscribe(() => {})
	await eventually(() => expect(convex.connectionState().isWebSocketConnected).toBe(true))

	server.setOnline(false)
	await eventually(() => expect(convex.connectionState().isWebSocketConnected).toBe(false))
	server.setOnline(true)
	await eventually(() => expect(convex.connectionState().isWebSocketConnected).toBe(true))
	expect(convex.connectionState().connectionCount).toBe(2)
	unsubscribe()
})

test('applies an optimistic update until the server confirms the mutation', async () => {
	const convex = createConvex()
	const count = convex.query(api.count, () => ({}), 'count')
	const unsubscribe = count.data.subscribe(() => {})
	await eventually(() => expect(count.data()).toBe(0))

	const add = convex.mutation(api.add, 'add', {
		optimisticUpdate: (store) => {
			const current = store.getQuery(api.count, {})
			if (current !== undefined) store.setQuery(api.count, {}, current + 10)
		},
	})
	const done = wrap(add({ text: 'first' }))
	expect(count.data()).toBe(10)
	await expect(done).resolves.toBe('item0')
	expect(count.data()).toBe(1)
	expect(add.ready()).toBe(true)
	unsubscribe()
})

test('paginates and keeps loaded pages live', async () => {
	items = Array.from({ length: 5 }, (_, index) => ({ _id: `seed${index}`, text: `seed ${index}` }))
	const convex = createConvex()
	const list = convex.paginatedQuery(api.items, () => ({}), { initialNumItems: 2 }, 'list')
	const unsubscribe = list.results.subscribe(() => {})
	expect(list.status()).toBe('LoadingFirstPage')
	await eventually(() => expect(list.status()).toBe('CanLoadMore'))
	expect(list.results().map((item) => item.text)).toEqual(['seed 0', 'seed 1'])

	expect(list.loadMore(2)).toBe(true)
	expect(list.status()).toBe('LoadingMore')
	await eventually(() => expect(list.results()).toHaveLength(4))

	await wrap(convex.mutation(api.add, 'add')({ text: 'new' }))
	await eventually(() => expect(list.results()).toHaveLength(5))
	expect(list.results()[0]?.text).toBe('new')

	list.loadMore(10)
	await eventually(() => expect(list.status()).toBe('Exhausted'))
	expect(list.results()).toHaveLength(6)
	unsubscribe()
})

test('runs actions', async () => {
	const convex = createConvex()
	await expect(wrap(convex.action(api.shout, 'shout')({ text: 'hi' }))).resolves.toBe('HI')
})
