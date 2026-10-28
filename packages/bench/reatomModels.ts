import type { Computed, Frame } from '@reatom/core'

import { context } from '@reatom/core'
import { reatomConvexClient } from '@reatomized/convex'

import { addNoteFirst, api, CLIENT_URL, type BenchServer, type Handle } from './fixture'

export type ItemModel = { data: Computed<{ id: number; v: number } | undefined> }

/** What the Reatom views render: @reatomized/convex in a fresh context. */
export type ReatomModels = {
	frame: Frame
	connected(): boolean
	item(id: number): ItemModel
	list(handle: Handle): () => Array<{ _id: string; text: string }>
	pages(initialNumItems: number, handle: Handle): () => Array<{ _id: string; text: string }>
	close(): Promise<void>
}

export function reatomModels({ server }: BenchServer): ReatomModels {
	const convex = reatomConvexClient(CLIENT_URL, {
		webSocketConstructor: server.WebSocket,
		skipConvexDeploymentUrlCheck: true,
		unsavedChangesWarning: false,
	})
	const frame = context.start()
	// Connects now, as `new ConvexReactClient` does.
	const unsubscribe = frame.run(() => convex.connectionState.subscribe(() => {}))
	return {
		frame,
		connected: () => frame.run(() => convex.connectionState().isWebSocketConnected),
		item: (id) => frame.run(() => convex.query(api.item, { id })),
		list(handle) {
			const notes = frame.run(() => convex.query(api.list, {}))
			handle.add = (text) =>
				frame.run(() => convex.mutation(api.add, { text }, { optimisticUpdate: addNoteFirst }))
			return () => notes.data() ?? []
		},
		pages(initialNumItems, handle) {
			const pages = frame.run(() => convex.paginatedQuery(api.page, {}, { initialNumItems }))
			handle.loadMore = (numItems) => frame.run(() => pages.loadMore(numItems))
			return pages.results
		},
		close: () =>
			frame.run(() => {
				unsubscribe()
				return convex.close()
			}),
	}
}
