// These integration checks execute on the exact tarballs and preview used in the timed page.
import { createFakeConvexServer, fakeJwt, readFakeJwt, paginate } from 'convex-fake-server'
import { makeFunctionReference } from 'convex/server'
import { ConvexError } from 'convex/values'

import { CLIENT_URL } from './fixture'
import { createPlainNativeClient } from './plainClient'

const scalar = makeFunctionReference<'query', { id: number }, number>('check:scalar')
const failure = makeFunctionReference<'query', Record<string, never>, number>('check:failure')
const change = makeFunctionReference<'mutation', Record<string, never>, number>('check:change')
const echo = makeFunctionReference<'action', { value: number }, number>('check:echo')
const who = makeFunctionReference<'query', Record<string, never>, string | null>('check:who')
const page = makeFunctionReference<
	'query',
	{ paginationOpts: { cursor: string | null; numItems: number } },
	{ page: Array<{ _id: string }>; continueCursor: string; isDone: boolean }
>('check:page')
const check = (condition: boolean, message: string) => {
	if (!condition) throw new Error(message)
}

const checkClosed = (read: () => unknown) => {
	let closed = false
	try {
		read()
	} catch {
		closed = true
	}
	check(closed, 'Closed client accepted a query')
}

export async function checkPlainClient() {
	const checked: string[] = []
	for (const queryResponses of ['per-message', 'coalesced'] as const) {
		let value = 0
		const notes = Array.from({ length: 10 }, (_, i) => ({ _id: `n${i}` }))
		const server = createFakeConvexServer({
			queryResponses,
			queries: {
				'check:scalar': () => value,
				'check:failure': () => {
					throw new ConvexError({ reason: 'refused' })
				},
				'check:who': (ctx) => ctx.identity?.subject ?? null,
				'check:page': (ctx, { paginationOpts }) => paginate(ctx, notes, paginationOpts!),
			},
			mutations: { 'check:change': () => ++value },
			actions: { 'check:echo': (_ctx, { value }) => value },
			authenticate: (token) => ({ subject: String(readFakeJwt(token)['sub']) }),
		})
		const client = createPlainNativeClient(CLIENT_URL, {
			webSocketConstructor: server.WebSocket,
			unsavedChangesWarning: false,
			logger: false,
		})
		const wait = async (condition: () => boolean) => {
			const deadline = performance.now() + 10_000
			while (!condition()) {
				if (performance.now() > deadline) throw new Error('Plain client check timed out')
				await server.settled()
			}
		}
		try {
			const store = client.query(scalar, { id: 1 })
			check(store.getSnapshot() === undefined, 'Initial snapshot must be loading')
			check(server.subscriptionCount('check:scalar') === 0, 'Reading subscribed eagerly')
			const first: number[] = [],
				second: number[] = [],
				errors: unknown[] = []
			const stop = client.onUpdate(
				scalar,
				{ id: 1 },
				(v) => first.push(v),
				(e) => errors.push(e),
			)
			const subscribeSecond = () =>
				client.onUpdate(
					scalar,
					{ id: 1 },
					(v) => second.push(v),
					(e) => errors.push(e),
				)
			const stop2 = subscribeSecond()
			await wait(() => first.length === 1 && second.length === 1)
			check(server.subscriptionCount('check:scalar') === 1, 'Equal queries did not dedupe')
			check(Object.is(store.getSnapshot(), store.getSnapshot()), 'Unstable getSnapshot')
			stop()
			stop()
			value++
			server.invalidate()
			await wait(() => second.at(-1) === 1)
			check(first.length === 1, 'Unsubscribed callback fired')
			stop2()
			await wait(() => server.subscriptionCount('check:scalar') === 0)
			checked.push(`${queryResponses}: loading, subscribe, dedupe, update, idempotent unsubscribe`)
			const stop3 = subscribeSecond()
			await wait(() => store.getSnapshot() === value)
			const pending = client.mutation(
				change,
				{},
				{ optimisticUpdate: (store) => store.setQuery(scalar, { id: 1 }, 99) },
			)
			check(store.getSnapshot() === 99, 'Optimistic write was not immediately visible')
			await pending
			await wait(() => store.getSnapshot() === value)
			check((await client.action(echo, { value: 7 })) === 7, 'Action result mismatch')
			stop3()
			checked.push(`${queryResponses}: resubscribe, optimistic rollback, mutation, action`)
			const stopError = client.onUpdate(
				failure,
				{},
				() => {
					throw new Error('Failure delivered as data')
				},
				(e) => errors.push(e),
			)
			await wait(() => errors.length > 0)
			check(errors[0] instanceof Error, 'Query error missing')
			check(
				typeof errors[0] === 'object' && errors[0] !== null && 'data' in errors[0],
				'ConvexError data was lost',
			)
			stopError()
			checked.push(`${queryResponses}: query error callback`)
			const pages = client.paginatedQuery(page, {}, 3)
			const stopPages = pages.subscribe(() => {})
			await wait(() => pages.getSnapshot().length === 3)
			pages.loadMore(3)
			await wait(() => pages.getSnapshot().length === 6)
			stopPages()
			await wait(() => server.subscriptionCount('check:page') === 0)
			checked.push(`${queryResponses}: live pagination and cleanup`)
			let identity: string | null | undefined
			client.onUpdate(
				who,
				{},
				(v) => {
					identity = v
				},
				(e) => {
					throw e
				},
			)
			client.setAuth(async () => fakeJwt({ sub: 'alice' }))
			await wait(() => identity === 'alice' && client.auth.getSnapshot() === true)
			client.clearAuth()
			await wait(() => identity === null)
			await client.close()
			await client.close()
			check(server.subscriptionCount('check:who') === 0, 'Close leaked a query')
			checkClosed(() => client.query(scalar, { id: 1 }))
			checked.push(`${queryResponses}: auth, clear, close, closed access`)
		} finally {
			await client.close()
			server.close()
		}
	}
	return checked
}
