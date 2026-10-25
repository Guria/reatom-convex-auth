import {
	ConvexProvider,
	ConvexReactClient,
	useMutation,
	usePaginatedQuery,
	useQuery,
} from 'convex/react'

import { addNoteFirst, api, CLIENT_URL, counters, type Binding, type Handle } from './fixture'

const Item = ({ id }: { id: number }) => {
	counters.renders++
	const item = useQuery(api.item, { id })
	return <i data-id={id} data-v={item?.v ?? -1} />
}

const List = ({ handle }: { handle: Handle }) => {
	const notes = useQuery(api.list, {})
	const add = useMutation(api.add).withOptimisticUpdate(addNoteFirst)
	handle.add = (text) => add({ text })
	return (
		<ul>
			{notes?.map((note) => (
				<li key={note._id}>{note.text}</li>
			))}
		</ul>
	)
}

const Pages = ({ initialNumItems, handle }: { initialNumItems: number; handle: Handle }) => {
	const { results, loadMore } = usePaginatedQuery(api.page, {}, { initialNumItems })
	handle.loadMore = loadMore
	return (
		<ul>
			{results.map((note) => (
				<li key={note._id}>{note.text}</li>
			))}
		</ul>
	)
}

export const official: Binding = {
	label: 'convex/react',
	create({ server }) {
		const client = new ConvexReactClient(CLIENT_URL, {
			webSocketConstructor: server.WebSocket,
			skipConvexDeploymentUrlCheck: true,
			unsavedChangesWarning: false,
		})
		const provide = (node: React.ReactNode) => (
			<ConvexProvider client={client}>{node}</ConvexProvider>
		)
		return {
			connected: () => client.connectionState().isWebSocketConnected,
			items: (ids) => provide(ids.map((id) => <Item key={id} id={id} />)),
			shared: (count) =>
				provide(Array.from({ length: count }, (_, index) => <Item key={index} id={0} />)),
			list: (handle) => provide(<List handle={handle} />),
			pages: (initialNumItems, handle) =>
				provide(<Pages initialNumItems={initialNumItems} handle={handle} />),
			close: () => client.close(),
		}
	},
}
