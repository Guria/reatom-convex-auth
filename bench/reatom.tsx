import { context } from '@reatom/core'
import { reatomComponent, reatomContext } from '@reatom/react'
import { ConvexClient } from 'convex/browser'

import { reatomConvex } from '../src/shared/api/convex/reatomConvex'
import { addNoteFirst, api, CLIENT_URL, counters, type Binding } from './fixture'

type Convex = ReturnType<typeof reatomConvex>
type ItemModel = ReturnType<Convex['query']>

const Item = reatomComponent(({ id, model }: { id: number; model: ItemModel }) => {
	counters.renders++
	const item = model.data() as { v: number } | undefined
	return <i data-id={id} data-v={item?.v ?? -1} />
}, 'Item')

const Notes = reatomComponent(
	({ notes }: { notes: () => Array<{ _id: string; text: string }> }) => (
		<ul>
			{notes().map((note) => (
				<li key={note._id}>{note.text}</li>
			))}
		</ul>
	),
	'Notes',
)

export const reatom: Binding = {
	label: 'reatom',
	create({ server }) {
		const client = new ConvexClient(CLIENT_URL, {
			webSocketConstructor: server.WebSocket,
			skipConvexDeploymentUrlCheck: true,
			unsavedChangesWarning: false,
		})
		const frame = context.start()
		const convex = reatomConvex(() => client, 'bench')
		const provide = (node: React.ReactNode) => (
			<reatomContext.Provider value={frame}>{node}</reatomContext.Provider>
		)
		const itemQuery = (id: number) => convex.query(api.item, () => ({ id }), `item${id}`)
		return {
			connected: () => client.connectionState().isWebSocketConnected,
			items: (ids) => provide(ids.map((id) => <Item key={id} id={id} model={itemQuery(id)} />)),
			shared: (count) => {
				const model = itemQuery(0)
				return provide(
					Array.from({ length: count }, (_, index) => <Item key={index} id={0} model={model} />),
				)
			},
			list: (handle) => {
				const notes = convex.query(api.list, () => ({}), 'list')
				const add = convex.mutation(api.add, 'add', { optimisticUpdate: addNoteFirst })
				handle.add = (text) => frame.run(() => add({ text }))
				return provide(<Notes notes={() => notes.data() ?? []} />)
			},
			pages: (initialNumItems, handle) => {
				const pages = convex.paginatedQuery(api.page, () => ({}), { initialNumItems }, 'pages')
				handle.loadMore = (numItems) => frame.run(() => pages.loadMore(numItems))
				return provide(<Notes notes={pages.results} />)
			},
			close: () => client.close(),
		}
	},
}
