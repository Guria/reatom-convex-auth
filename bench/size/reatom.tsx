// The features the app uses, through the Reatom binding.
import { clearStack, context, wrap } from '@reatom/core'
import { reatomComponent, reatomContext } from '@reatom/react'
import { ConvexClient } from 'convex/browser'
import { createRoot } from 'react-dom/client'

import { reatomConvex } from '../../src/shared/api/convex/reatomConvex'
import { addNoteFirst, api } from '../api'

clearStack()
const frame = context.start()
const convex = reatomConvex(() => new ConvexClient('https://bench.convex.cloud'), 'convex')
const item = convex.query(
	api.item,
	() => (convex.serverAuthenticated() ? { id: 1 } : 'skip'),
	'item',
)
const add = convex.mutation(api.add, 'add', { optimisticUpdate: addNoteFirst })
const pages = convex.paginatedQuery(api.page, () => ({}), { initialNumItems: 10 }, 'pages')
frame.run(() => convex.setAuth(async () => 'token'))

const App = reatomComponent(
	() => (
		<button onClick={wrap(() => void add({ text: 'x' }).then(wrap(() => pages.loadMore(10))))}>
			{JSON.stringify([
				convex.serverAuthenticated(),
				convex.isRefreshingAuth(),
				convex.connectionState().isWebSocketConnected,
				item.data(),
				pages.results(),
			])}
		</button>
	),
	'App',
)

createRoot(document.getElementById('root')!).render(
	<reatomContext.Provider value={frame}>
		<App />
	</reatomContext.Provider>,
)
