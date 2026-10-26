import type * as Browser from 'convex/browser'

import {
	createFakeConvexServer,
	fakeJwt,
	type FakeConvexServer,
	type FakeConvexServerOptions,
} from 'convex-fake-server'
import { makeFunctionReference } from 'convex/server'
import { afterEach, beforeAll, expect, test, vi } from 'vite-plus/test'

import { patchedConvex, patchedConvexFile } from './patchedConvex'

const api = {
	echo: makeFunctionReference<'query', { value: string }, string>('test:echo'),
	count: makeFunctionReference<'query', Record<string, never>, number>('test:count'),
	whoami: makeFunctionReference<'query', Record<string, never>, string | null>('test:whoami'),
	add: makeFunctionReference<'mutation', { text: string }, null>('test:add'),
}

type Sent = { type: string; baseVersion?: number; newVersion?: number; modifications?: unknown[] }
type Internals = {
	hasLocalQueryResultByToken(token: string): boolean
	optimisticQueryResults: {
		rawQueryResult(token: string): unknown
		ingestQueryResultsFromServer(...args: unknown[]): string[]
	}
}

let convex: typeof Browser
let server: FakeConvexServer
let client: Browser.ConvexClient
let base: Browser.BaseConvexClient
let sent: Sent[]
let items: string[]

beforeAll(async () => {
	convex = (await import(patchedConvexFile(patchedConvex(), 'browser/index.js'))) as typeof Browser
})

const recordingSocket = (socket: typeof WebSocket) =>
	class extends (socket as unknown as new (url: string) => WebSocket) {
		override send(data: string) {
			sent.push(JSON.parse(data) as Sent)
			super.send(data)
		}
	} as unknown as typeof WebSocket

async function connect(queryResponses: FakeConvexServerOptions['queryResponses'] = 'per-message') {
	sent = []
	items = []
	server = createFakeConvexServer({
		queryResponses,
		queries: {
			'test:echo': (_ctx, { value }) => value,
			'test:count': () => items.length,
			'test:whoami': (ctx) => ctx.identity?.subject ?? null,
		},
		mutations: {
			'test:add': (_ctx, { text }) => {
				items.push(String(text))
				return null
			},
		},
		authenticate: () => ({ subject: 'ada' }),
	})
	client = new convex.ConvexClient('https://fake.convex.cloud', {
		webSocketConstructor: recordingSocket(server.WebSocket),
		skipConvexDeploymentUrlCheck: true,
		unsavedChangesWarning: false,
	})
	base = client.client
	await eventually(() => expect(client.connectionState().isWebSocketConnected).toBe(true))
	sent = []
}

afterEach(async () => {
	await client.close()
	server.close()
})

const internal = () => base as unknown as Internals
const eventually = (assertion: () => void) => vi.waitFor(assertion, { timeout: 5000 })
const querySetEdits = () => sent.filter((message) => message.type === 'ModifyQuerySet')
const echo = (value: string) => base.subscribe('test:echo', { value })

test.each(['per-message', 'coalesced'] as const)(
	'sends the query set edits of one microtask as one message, %s',
	async (queryResponses) => {
		await connect(queryResponses)
		const subscriptions = ['a', 'b', 'c', 'a'].map(echo)
		await eventually(() =>
			expect(['a', 'b', 'c'].map((value) => base.localQueryResult('test:echo', { value }))).toEqual(
				['a', 'b', 'c'],
			),
		)
		expect(querySetEdits()).toEqual([
			expect.objectContaining({ baseVersion: 1, newVersion: 4, modifications: expect.any(Array) }),
		])
		expect(querySetEdits()[0]!.modifications).toHaveLength(3)

		subscriptions.forEach(({ unsubscribe }) => unsubscribe())
		await eventually(() => expect(server.subscriptionCount('test:echo')).toBe(0))
		expect(querySetEdits()).toHaveLength(2)
		expect(querySetEdits()[1]).toMatchObject({ baseVersion: 4, newVersion: 7 })
	},
)

test('applies a transition or mutation response to the queries it names', async () => {
	await connect()
	const a = echo('a')
	const count = base.subscribe('test:count', {})
	await eventually(() => expect(base.localQueryResult('test:count', {})).toBe(0))
	const before = internal().optimisticQueryResults.rawQueryResult(a.queryToken)
	const changed: string[][] = []
	base.addOnTransitionHandler(({ queries }) => changed.push(queries.map(({ token }) => token)))
	const rebuild = vi.spyOn(internal().optimisticQueryResults, 'ingestQueryResultsFromServer')

	items.push('x')
	server.invalidate()
	await eventually(() => expect(base.localQueryResult('test:count', {})).toBe(1))
	await client.mutation(api.add, { text: 'y' })

	expect(base.localQueryResult('test:count', {})).toBe(2)
	expect(changed.flat()).toEqual([count.queryToken, count.queryToken])
	expect(internal().optimisticQueryResults.rawQueryResult(a.queryToken)).toBe(before)
	expect(rebuild).not.toHaveBeenCalled()
})

test('drops an unsubscribed result on the next transition', async () => {
	await connect()
	const a = echo('a')
	base.subscribe('test:count', {})
	await eventually(() => expect(internal().hasLocalQueryResultByToken(a.queryToken)).toBe(true))

	a.unsubscribe()
	await client.mutation(api.add, { text: 'x' })

	expect(internal().hasLocalQueryResultByToken(a.queryToken)).toBe(false)
})

test('replays optimistic updates over every result until the server confirms', async () => {
	await connect()
	base.subscribe('test:count', {})
	echo('a')
	await eventually(() => expect(base.localQueryResult('test:count', {})).toBe(0))

	const done = client.mutation(
		api.add,
		{ text: 'x' },
		{
			optimisticUpdate: (store) =>
				store.setQuery(api.count, {}, (store.getQuery(api.count, {}) ?? 0) + 10),
		},
	)
	expect(base.localQueryResult('test:count', {})).toBe(10)

	await done
	expect(base.localQueryResult('test:count', {})).toBe(1)
	expect(base.localQueryResult('test:echo', { value: 'a' })).toBe('a')
})

test('replays the query set after a reconnect', async () => {
	await connect()
	const a = echo('a')
	await eventually(() => expect(base.localQueryResult('test:echo', { value: 'a' })).toBe('a'))

	server.setOnline(false)
	await eventually(() => expect(client.connectionState().isWebSocketConnected).toBe(false))
	a.unsubscribe()
	const b = echo('b')
	server.setOnline(true)

	await eventually(() => expect(base.localQueryResult('test:echo', { value: 'b' })).toBe('b'))
	expect(server.subscriptionCount('test:echo')).toBe(1)
	expect(internal().hasLocalQueryResultByToken(a.queryToken)).toBe(false)
	expect(internal().hasLocalQueryResultByToken(b.queryToken)).toBe(true)
})

test('sends queued edits before pausing for auth', async () => {
	await connect()
	base.subscribe('test:whoami', {})
	client.setAuth(async () => fakeJwt({ sub: 'ada' }))

	await eventually(() => expect(base.localQueryResult('test:whoami', {})).toBe('ada'))
	expect(server.subscriptionCount('test:whoami')).toBe(1)
})
