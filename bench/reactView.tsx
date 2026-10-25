import { Profiler } from 'react'
import { createRoot } from 'react-dom/client'

import { counters } from './fixture'

/** A React root in `container` that counts commits. */
export function reactView(container: HTMLElement) {
	const root = createRoot(container)
	return {
		show: (node: React.ReactNode) =>
			root.render(
				<Profiler id="bench" onRender={() => counters.commits++}>
					{node}
				</Profiler>,
			),
		clear: () => root.render(null),
		dispose: () => root.unmount(),
	}
}
