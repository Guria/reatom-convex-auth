import type { ConvexTransport } from './transport'
import type { FunctionReference } from 'convex/server'

import { atom, context, wrap } from '@reatom/core'
import { makeFunctionReference } from 'convex/server'
import { beforeEach, expect, test } from 'vite-plus/test'

import { reatomConvex } from './reatomConvex'

type Subscription = {
	args: unknown
	onResult: (value: unknown) => void
	onError: (e: Error) => void
}

const createFakeTransport = () => {
	const subscriptions = new Set<Subscription>()
	let authListener: ((ok: boolean) => void) | undefined
	const transport: ConvexTransport = {
		onUpdate: (_query, args, onResult, onError) => {
			const subscription: Subscription = {
				args,
				onResult: onResult as Subscription['onResult'],
				onError,
			}
			subscriptions.add(subscription)
			return () => subscriptions.delete(subscription)
		},
		mutation: async (_mutation, args) => ({ echoed: args }) as never,
		setAuth: (_fetchToken, onChange) => {
			authListener = onChange
		},
		clearAuth: () => {
			authListener = undefined
		},
	}
	return { transport, subscriptions, answerAuth: (ok: boolean) => authListener?.(ok) }
}

const listQuery = makeFunctionReference<'query', { owner: string }, string[]>(
	'notes:list',
) satisfies FunctionReference<'query'>

// Reatom runs connect/disconnect hooks in a microtask after (un)subscribe.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
	context.reset()
})

test('subscribes on connect, re-subscribes on args change, unsubscribes on disconnect', async () => {
	const fake = createFakeTransport()
	const convex = reatomConvex(() => fake.transport, 'convex')
	const owner = atom('ada', 'owner')
	const list = convex.query(listQuery, () => ({ owner: owner() }), 'list')

	expect(fake.subscriptions.size).toBe(0)
	const unsubscribe = list.data.subscribe(() => {})
	await flush()
	expect(fake.subscriptions.size).toBe(1)
	expect([...fake.subscriptions][0]?.args).toEqual({ owner: 'ada' })
	expect(list.isLoading()).toBe(true)

	owner.set('grace')
	await flush()
	expect(fake.subscriptions.size).toBe(1)
	expect([...fake.subscriptions][0]?.args).toEqual({ owner: 'grace' })

	unsubscribe()
	await flush()
	expect(fake.subscriptions.size).toBe(0)
})

test('stores results and errors instead of throwing', async () => {
	const fake = createFakeTransport()
	const convex = reatomConvex(() => fake.transport, 'convex')
	const list = convex.query(listQuery, () => ({ owner: 'ada' }), 'list')
	const unsubscribe = list.error.subscribe(() => {})
	await flush()
	const [subscription] = fake.subscriptions

	subscription?.onResult(['first'])
	expect(list.data()).toEqual(['first'])
	expect(list.isLoading()).toBe(false)

	subscription?.onError(new Error('Not authenticated'))
	expect(list.error()?.message).toBe('Not authenticated')
	expect(list.data()).toBeUndefined()
	unsubscribe()
})

test('tracks server acknowledgement of the auth token', () => {
	const fake = createFakeTransport()
	const convex = reatomConvex(() => fake.transport, 'convex')
	expect(convex.serverAuthenticated()).toBeNull()

	convex.setAuth(async () => 'token')
	expect(convex.serverAuthenticated()).toBeNull()
	fake.answerAuth(true)
	expect(convex.serverAuthenticated()).toBe(true)

	convex.clearAuth()
	expect(convex.serverAuthenticated()).toBe(false)
})

test('runs mutations through the transport', async () => {
	const fake = createFakeTransport()
	const convex = reatomConvex(() => fake.transport, 'convex')
	const add = convex.mutation(
		makeFunctionReference<'mutation', { text: string }, unknown>('notes:add'),
		'add',
	)
	await expect(wrap(add({ text: 'hi' }))).resolves.toEqual({ echoed: { text: 'hi' } })
})
