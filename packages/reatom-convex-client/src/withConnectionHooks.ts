import { action, type AbortExt, type Action, type AtomLike, type Ext } from '@reatom/core'

/**
 * Calls `connect` when `target` gains its first subscriber and `disconnect`
 * when it loses the last one. Both are plain actions: unlike
 * `withConnectHook`, a connect makes no AbortController and a disconnect no
 * AbortError. `target` must have no other connect hook.
 */
export const withConnectionHooks =
	<Target extends AtomLike>(connect: () => void, disconnect: () => void): Ext<Target> =>
	(target) => {
		const onConnect: Action & Partial<AbortExt> = action(connect, `${target.name}._connect`)
		onConnect.abort = action(disconnect, `${target.name}._disconnect`)
		target.__reatom.onConnect = onConnect as Action & AbortExt
		return target
	}
