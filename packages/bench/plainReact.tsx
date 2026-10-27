// Both clients use this exact ordinary React component and useSyncExternalStore hook.
import type { Binding, BenchServer, Handle, Note } from './fixture'
import type { ExternalStore } from './plainStore'

import { useMemo, useSyncExternalStore } from 'react'

import { addNoteFirst, api, CLIENT_URL, counters } from './fixture'
import { createPlainNativeClient } from './plainClient'
import { createPlainPrClient } from './plainPrClient'
import { reactView } from './reactView'

const useStore = <T,>(store: ExternalStore<T>): T =>
	useSyncExternalStore(store.subscribe, store.getSnapshot)
type PlainClient =
	| ReturnType<typeof createPlainNativeClient>
	| ReturnType<typeof createPlainPrClient>

const Item = ({ id, client }: { id: number; client: PlainClient }) => {
	counters.renders++
	const store = useMemo(() => client.query(api.item, { id }), [client, id])
	const item = useStore(store)
	return <i data-id={id} data-v={item?.v ?? -1} />
}
const List = ({ client, handle }: { client: PlainClient; handle: Handle }) => {
	const store = useMemo(() => client.query(api.list, {}), [client])
	const notes = useStore(store)
	handle.add = (text) => client.mutation(api.add, { text }, { optimisticUpdate: addNoteFirst })
	return <Notes notes={notes ?? []} />
}
const Notes = ({ notes }: { notes: Note[] }) => (
	<ul>
		{notes.map((note) => (
			<li key={note._id}>{note.text}</li>
		))}
	</ul>
)
const Pages = ({
	client,
	handle,
	initialNumItems,
}: {
	client: PlainClient
	handle: Handle
	initialNumItems: number
}) => {
	const store = useMemo(
		() => client.paginatedQuery(api.page, {}, initialNumItems),
		[client, initialNumItems],
	)
	handle.loadMore = store.loadMore
	return <Notes notes={useStore(store)} />
}

const binding = (
	label: string,
	factory: typeof createPlainNativeClient | typeof createPlainPrClient,
): Binding => ({
	label,
	commits: true,
	create({ server }: BenchServer, container) {
		const client = factory(CLIENT_URL, {
			webSocketConstructor: server.WebSocket,
			unsavedChangesWarning: false,
			logger: false,
		})
		const view = reactView(container)
		return {
			connected: () => client.connection.getSnapshot().isWebSocketConnected,
			items: (ids) => view.show(ids.map((id) => <Item key={id} id={id} client={client} />)),
			shared: (count) =>
				view.show(
					Array.from({ length: count }, (_, index) => <Item key={index} id={0} client={client} />),
				),
			list: (handle) => view.show(<List client={client} handle={handle} />),
			pages: (initialNumItems, handle) =>
				view.show(<Pages client={client} handle={handle} initialNumItems={initialNumItems} />),
			clear: view.clear,
			close: () => {
				view.dispose()
				return client.close()
			},
		}
	},
})
export const plainPr = binding('PR #211 plain React', createPlainPrClient)
export const plainNative = binding('Native plain React', createPlainNativeClient)
