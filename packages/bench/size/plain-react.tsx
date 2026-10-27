// The exact same consumer app is built over each facade, selected by the build resolver.
import { useMemo, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'

import { addNoteFirst, api } from '../api'
import { createPlainNativeClient } from '../plainClient'

const client = createPlainNativeClient('https://bench.convex.cloud')
client.setAuth(async () => 'token')
const App = () => {
	const connection = useSyncExternalStore(
		client.connection.subscribe,
		client.connection.getSnapshot,
	)
	const authenticated = useSyncExternalStore(client.auth.subscribe, client.auth.getSnapshot)
	const itemStore = useMemo(() => client.query(api.item, { id: 1 }), [])
	const pages = useMemo(() => client.paginatedQuery(api.page, {}, 10), [])
	const item = useSyncExternalStore(
		authenticated ? itemStore.subscribe : () => () => {},
		authenticated ? itemStore.getSnapshot : () => undefined,
	)
	const results = useSyncExternalStore(pages.subscribe, pages.getSnapshot)
	return (
		<button
			onClick={() =>
				void client
					.mutation(api.add, { text: 'x' }, { optimisticUpdate: addNoteFirst })
					.then(() => pages.loadMore(10))
			}
		>
			{JSON.stringify([connection, authenticated, item, results])}
		</button>
	)
}
createRoot(document.getElementById('root')!).render(<App />)
