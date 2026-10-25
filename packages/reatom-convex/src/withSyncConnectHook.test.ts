import { abortVar, action, atom, context, withAbort, wrap } from '@reatom/core'
import { beforeEach, expect, test, vi } from 'vite-plus/test'

import { withSyncConnectHook } from './withSyncConnectHook'

// Connect and disconnect run from Reatom's queue on a later microtask.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
	context.reset()
})

test('connects on the first subscriber and cleans up after the last, repeatedly', async () => {
	const cleanup = vi.fn()
	const connect = vi.fn(() => cleanup)
	const target = atom(0, 'target').extend(withSyncConnectHook(connect))

	const first = target.subscribe(() => {})
	const second = target.subscribe(() => {})
	await flush()
	expect(connect).toHaveBeenCalledTimes(1)

	first()
	await flush()
	expect(cleanup).not.toHaveBeenCalled()
	second()
	await flush()
	expect(cleanup).toHaveBeenCalledTimes(1)

	const again = target.subscribe(() => {})
	await flush()
	again()
	await flush()
	expect(connect).toHaveBeenCalledTimes(2)
	expect(cleanup).toHaveBeenCalledTimes(2)
})

test('connect runs in an abortable frame, the cleanup outside the aborted one', async () => {
	const abortable = action(async () => {
		await wrap(Promise.resolve())
		return 'done'
	}, 'abortable').extend(withAbort())
	let connectSignal: AbortSignal | undefined
	let cleanupAborted: boolean | undefined
	let cleanupCall: Promise<string> | undefined
	const target = atom(0, 'target').extend(
		withSyncConnectHook(() => {
			connectSignal = abortVar.get()?.signal
			return () => {
				cleanupAborted = abortVar.get()?.signal.aborted ?? false
				cleanupCall = abortable()
			}
		}),
	)

	const unsubscribe = target.subscribe(() => {})
	await flush()
	expect(connectSignal?.aborted).toBe(false)
	unsubscribe()
	await flush()
	expect(connectSignal?.aborted).toBe(true)
	expect(cleanupAborted).toBe(false)
	await expect(cleanupCall).resolves.toBe('done')
})

test('keeps a connection per context', async () => {
	const cleanups: number[] = []
	let connections = 0
	const target = atom(0, 'target').extend(
		withSyncConnectHook(() => {
			const connection = ++connections
			return () => cleanups.push(connection)
		}),
	)
	const first = context.start(() => target.subscribe(() => {}))
	const second = context.start(() => target.subscribe(() => {}))
	await flush()
	expect(connections).toBe(2)
	first()
	await flush()
	expect(cleanups).toEqual([1])
	second()
	await flush()
	expect(cleanups).toEqual([1, 2])
})
