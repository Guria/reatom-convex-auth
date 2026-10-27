import type { Computed, Frame } from '@reatom/core'
import type { reatomConvex as reatomBinding } from 'reatom-convex'

import { context } from '@reatom/core'
import {
	ConvexClient as AtomsClient,
	reatomConvexClient as reatomAtomsClient,
} from 'convex-artifact-atoms/browser'
import { ConvexClient as BatchedClient } from 'convex-artifact-batched/browser'
import { ConvexClient as RewrittenClient } from 'convex-artifact-rewrite/browser'
import { ConvexClient as PatchedConvexClient } from 'convex-patched/browser'
import { ConvexClient } from 'convex/browser'
import { reatomConvex } from 'reatom-convex'
import { reatomConvex as reatomNative, reatomConvexClient } from 'reatom-convex-client'

import {
	addNoteFirst,
	api,
	CLIENT_URL,
	type BenchServer,
	type Handle,
	type ModelOptions,
} from './fixture'

export type ItemModel = { data: Computed<{ id: number; v: number } | undefined> }

/** What the views render, whichever client is underneath. */
export type ReatomModels = {
	frame: Frame
	connected(): boolean
	item(id: number): ItemModel
	list(handle: Handle): () => Array<{ _id: string; text: string }>
	pages(initialNumItems: number, handle: Handle): () => Array<{ _id: string; text: string }>
	close(): Promise<void>
}

type Convex = Pick<ReturnType<typeof reatomBinding>, 'query' | 'mutation' | 'paginatedQuery'>

const views = (convex: Convex, frame: Frame) => ({
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
})

const sdkModels =
	(Client: typeof ConvexClient) =>
	({ server }: BenchServer): ReatomModels => {
		const client = new Client(CLIENT_URL, {
			webSocketConstructor: server.WebSocket,
			skipConvexDeploymentUrlCheck: true,
			unsavedChangesWarning: false,
		})
		const frame = context.start()
		return {
			frame,
			connected: () => client.connectionState().isWebSocketConnected,
			...views(
				reatomConvex(() => client, 'bench'),
				frame,
			),
			close: () => client.close(),
		}
	}

/** The binding over `convex/browser`'s `ConvexClient`. */
export const reatomModels = sdkModels(ConvexClient)
/** The binding over `ConvexClient` with packages/convex-patched applied. */
export const patchedModels = sdkModels(PatchedConvexClient)
/** The binding over the fork tarballs in artifacts.lock.json. */
export const batchedModels = sdkModels(BatchedClient)
export const rewrittenModels = sdkModels(RewrittenClient)
export const atomsModels = sdkModels(AtomsClient)

/** The same API straight over the Atoms SDK's Reatom client, no binding. */
export function atomsApiModels({ server }: BenchServer): ReatomModels {
	const convex = reatomAtomsClient(CLIENT_URL, {
		webSocketConstructor: server.WebSocket,
		skipConvexDeploymentUrlCheck: true,
		unsavedChangesWarning: false,
	})
	const frame = context.start()
	// Connects now, as `new ConvexClient` does.
	const unsubscribe = frame.run(() => convex.connectionState.subscribe(() => {}))
	return {
		frame,
		connected: () => frame.run(() => convex.connectionState().isWebSocketConnected),
		item: (id) => frame.run(() => convex.query(api.item, { id })) as ItemModel,
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

/** The same API over the client whose state lives in atoms. */
export function nativeModels({ server }: BenchServer, options: ModelOptions): ReatomModels {
	const client = reatomConvexClient(
		CLIENT_URL,
		{
			webSocketConstructor: server.WebSocket,
			skipConvexDeploymentUrlCheck: true,
			unsavedChangesWarning: false,
			batchQuerySet: options.batchQuerySet,
		},
		'bench.client',
	)
	const frame = context.start()
	// Connects now, as `new ConvexClient` does.
	const unsubscribe = frame.run(() => client.connectionState.subscribe(() => {}))
	return {
		frame,
		connected: () => frame.run(() => client.connectionState().isWebSocketConnected),
		...views(
			reatomNative(() => client, 'bench'),
			frame,
		),
		close: () =>
			frame.run(() => {
				unsubscribe()
				return client.close()
			}),
	}
}
