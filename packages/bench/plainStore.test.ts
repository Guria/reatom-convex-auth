import { expect, test } from 'vite-plus/test'

import { onStoreUpdate, subscriptionScope } from './plainStore'

test('external stores read without subscribing, detach once and release on close', () => {
	const scope = subscriptionScope()
	let starts = 0,
		stops = 0
	const store = scope.store(
		() => 42,
		() => {
			starts++
			return () => {
				stops++
			}
		},
	)
	expect(store.getSnapshot()).toBe(42)
	expect(starts).toBe(0)
	const stop = store.subscribe(() => {})
	stop()
	stop()
	expect(stops).toBe(1)
	store.subscribe(() => {})
	scope.close()
	scope.close()
	expect(starts).toBe(2)
	expect(stops).toBe(2)
	expect(() => store.getSnapshot()).toThrow('closed')
	expect(() => store.subscribe(() => {})).toThrow('closed')
})

test('callback API skips loading, delivers values and preserves error identity', () => {
	const scope = subscriptionScope()
	let value: number | undefined
	let failure: Error | undefined
	let notify = () => {}
	const values: number[] = [],
		errors: unknown[] = []
	const store = scope.store(
		() => {
			if (failure) throw failure
			return value
		},
		(next) => {
			notify = next
			next()
			return () => {}
		},
	)
	const stop = onStoreUpdate(
		store,
		(v) => values.push(v),
		(e) => errors.push(e),
	)
	expect(values).toEqual([])
	value = 7
	notify()
	expect(values).toEqual([7])
	failure = new Error('query failed')
	notify()
	expect(errors).toEqual([failure])
	stop()
	scope.close()
})
