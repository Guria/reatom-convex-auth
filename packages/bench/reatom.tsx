import { reatomComponent, reatomContext } from '@reatom/react'

import { counters, type Binding, type Note } from './fixture'
import { reactView } from './reactView'
import { reatomModels, type ItemModel } from './reatomModels'

const Item = reatomComponent(({ id, model }: { id: number; model: ItemModel }) => {
	counters.renders++
	const item = model.data() as { v: number } | undefined
	return <i data-id={id} data-v={item?.v ?? -1} />
}, 'Item')

const Notes = reatomComponent(
	({ notes }: { notes: () => Note[] }) => (
		<ul>
			{notes().map((note) => (
				<li key={note._id}>{note.text}</li>
			))}
		</ul>
	),
	'Notes',
)

export const reatom: Binding = {
	label: '@reatom/react',
	commits: true,
	create(server, container) {
		const models = reatomModels(server)
		const view = reactView(container)
		const provide = (node: React.ReactNode) =>
			view.show(<reatomContext.Provider value={models.frame}>{node}</reatomContext.Provider>)
		return {
			connected: models.connected,
			items: (ids) => provide(ids.map((id) => <Item key={id} id={id} model={models.item(id)} />)),
			shared: (count) => {
				const model = models.item(0)
				provide(
					Array.from({ length: count }, (_, index) => <Item key={index} id={0} model={model} />),
				)
			},
			list: (handle) => provide(<Notes notes={models.list(handle)} />),
			pages: (initialNumItems, handle) =>
				provide(<Notes notes={models.pages(initialNumItems, handle)} />),
			clear: view.clear,
			close: () => {
				view.dispose()
				return models.close()
			},
		}
	},
}
