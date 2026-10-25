import {
	action,
	context,
	noop,
	withAbort,
	withCallHook,
	type AtomLike,
	type Ext,
} from '@reatom/core'

/**
 * `withConnectHook` for a synchronous connect that returns its cleanup. It
 * uses the same `__reatom.onConnect` action, so `connect` still runs in an
 * abortable frame. The cleanup runs from a call hook on `onConnect.abort`,
 * outside the aborted scope: `withConnectHook` subscribes to the abort signal
 * and spawns a frame instead, which builds two AbortErrors per disconnect.
 */
export const withSyncConnectHook =
	<Target extends AtomLike>(connect: () => () => void): Ext<Target> =>
	(target) => {
		const onConnect = (target.__reatom.onConnect ??= action(
			noop,
			`${target.name}.withConnectHook`,
		).extend(withAbort()))
		// One connection per context.
		const cleanups = new WeakMap<object, () => void>()
		onConnect.extend(withCallHook(() => void cleanups.set(context(), connect())))
		onConnect.abort.extend(
			withCallHook(() => {
				const cleanup = cleanups.get(context())
				cleanups.delete(context())
				cleanup?.()
			}),
		)
		return target
	}
