/** @jsxImportSource @reatom/jsx */
// @reatom/jsx has no keyed reconciliation: `key` would be an unused prop.
// oxlint-disable react/jsx-key
// The same models rendered by @reatom/jsx: real DOM nodes, no virtual DOM.
// Components run once; bound values update the DOM directly.
import { mount } from '@reatom/jsx'

import { counters, type Binding, type Note } from './fixture'
import { reatomModels, type ItemModel } from './reatomModels'

const Item = ({ id, model }: { id: number; model: ItemModel }) => (
	<i
		attr:data-id={id}
		attr:data-v={() => {
			counters.renders++
			return (model.data() as { v: number } | undefined)?.v ?? -1
		}}
	/>
)

// Reactive array children rebuild the list on each change; upstream suggests
// this for short lists.
const Notes = ({ notes }: { notes: () => Note[] }) => (
	<ul>{() => notes().map((note) => <li>{note.text}</li>)}</ul>
)

export const reatomJsx: Binding = {
	label: '@reatom/jsx',
	commits: false,
	create(server, container) {
		const models = reatomModels(server)
		let unmount: (() => void) | undefined
		const show = (build: () => Element) =>
			models.frame.run(() => {
				unmount?.()
				unmount = mount(container, <div>{build()}</div>).unmount
			})
		const clear = () => {
			unmount?.()
			unmount = undefined
		}
		return {
			connected: models.connected,
			items: (ids) =>
				show(() => (
					<>
						{ids.map((id) => (
							<Item id={id} model={models.item(id)} />
						))}
					</>
				)),
			shared: (count) => {
				const model = models.item(0)
				show(() => (
					<>
						{Array.from({ length: count }, () => (
							<Item id={0} model={model} />
						))}
					</>
				))
			},
			list: (handle) => show(() => <Notes notes={models.list(handle)} />),
			pages: (initialNumItems, handle) =>
				show(() => <Notes notes={models.pages(initialNumItems, handle)} />),
			clear,
			close: () => {
				clear()
				return models.close()
			},
		}
	},
}
