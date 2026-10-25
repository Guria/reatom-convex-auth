import { context } from '@reatom/core'
import { ConvexClient } from 'convex/browser'
import { reatomConvex } from 'reatom-convex'

import { addNoteFirst, api, CLIENT_URL, type BenchServer, type Handle } from './fixture'

/** The binding's models for one benchmark session, whatever renders them. */
export function reatomModels({ server }: BenchServer) {
	const client = new ConvexClient(CLIENT_URL, {
		webSocketConstructor: server.WebSocket,
		skipConvexDeploymentUrlCheck: true,
		unsavedChangesWarning: false,
	})
	const frame = context.start()
	const convex = reatomConvex(() => client, 'bench')
	return {
		client,
		frame,
		connected: () => client.connectionState().isWebSocketConnected,
		item: (id: number) => convex.query(api.item, () => ({ id }), `item${id}`),
		list(handle: Handle) {
			const notes = convex.query(api.list, () => ({}), 'list')
			const add = convex.mutation(api.add, 'add', { optimisticUpdate: addNoteFirst })
			handle.add = (text) => frame.run(() => add({ text }))
			return () => notes.data() ?? []
		},
		pages(initialNumItems: number, handle: Handle) {
			const pages = convex.paginatedQuery(api.page, () => ({}), { initialNumItems }, 'pages')
			handle.loadMore = (numItems) => frame.run(() => pages.loadMore(numItems))
			return pages.results
		},
	}
}

export type ItemModel = ReturnType<ReturnType<typeof reatomModels>['item']>
