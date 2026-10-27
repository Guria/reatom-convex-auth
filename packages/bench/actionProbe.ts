// Same action repeatedly within one notification tick. Not a UI workload.
import { action, atom, context, getCalls, noop, withCallHook } from '@reatom/core'

export type ActionProbeKind = 'plain' | 'subscribed' | 'hooked' | 'atom'

export function runActionProbe(size: number, kind: ActionProbeKind) {
	return context.start().run(() => {
		const command = action((value: number) => value, 'probe.command')
		const state = atom(0, 'probe.state')
		if (kind === 'hooked') command.extend(withCallHook(noop))
		const unsubscribe = kind === 'subscribed' ? command.subscribe(noop) : noop
		const start = performance.now()
		if (kind === 'atom') {
			for (let index = 0; index < size; index++) state.set(index)
		} else {
			for (let index = 0; index < size; index++) command(index)
		}
		const ms = performance.now() - start
		const calls = kind === 'atom' ? size : getCalls(command).length
		unsubscribe()
		if (calls !== size) throw new Error(`Action probe lost calls: ${calls}/${size}`)
		return { ms, calls }
	})
}
