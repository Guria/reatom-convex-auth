// The features the app uses, through convex/react.
import {
	ConvexProviderWithAuth,
	ConvexReactClient,
	useConvexAuth,
	useConvexConnectionState,
	useMutation,
	usePaginatedQuery,
	useQuery,
} from 'convex/react'
import { createRoot } from 'react-dom/client'

import { addNoteFirst, api } from '../api'

const client = new ConvexReactClient('https://bench.convex.cloud')
const useAuth = () => ({
	isLoading: false,
	isAuthenticated: true,
	fetchAccessToken: async () => 'token',
})

const App = () => {
	const auth = useConvexAuth()
	const connection = useConvexConnectionState()
	const item = useQuery(api.item, auth.isAuthenticated ? { id: 1 } : 'skip')
	const add = useMutation(api.add).withOptimisticUpdate(addNoteFirst)
	const pages = usePaginatedQuery(api.page, {}, { initialNumItems: 10 })
	return (
		<button onClick={() => void add({ text: 'x' }).then(() => pages.loadMore(10))}>
			{JSON.stringify([auth, connection.isWebSocketConnected, item, pages.results])}
		</button>
	)
}

createRoot(document.getElementById('root')!).render(
	<ConvexProviderWithAuth client={client} useAuth={useAuth}>
		<App />
	</ConvexProviderWithAuth>,
)
