// The binding side of the size apps: the same models whatever renders them.
import { clearStack, context, wrap } from '@reatom/core'
import { ConvexClient } from 'convex/browser'

import { reatomConvex } from '../../src/shared/api/convex/reatomConvex'
import { addNoteFirst, api } from '../api'

clearStack()
export const frame = context.start()
const convex = reatomConvex(() => new ConvexClient('https://bench.convex.cloud'), 'convex')
const item = convex.query(
	api.item,
	() => (convex.serverAuthenticated() ? { id: 1 } : 'skip'),
	'item',
)
const add = convex.mutation(api.add, 'add', { optimisticUpdate: addNoteFirst })
const pages = convex.paginatedQuery(api.page, () => ({}), { initialNumItems: 10 }, 'pages')
frame.run(() => convex.setAuth(async () => 'token'))

/** Adds a note, then loads another page. */
export const onClick = () => void add({ text: 'x' }).then(wrap(() => pages.loadMore(10)))

/** Reads every piece of state the app shows. */
export const summary = () =>
	JSON.stringify([
		convex.serverAuthenticated(),
		convex.isRefreshingAuth(),
		convex.connectionState().isWebSocketConnected,
		item.data(),
		pages.results(),
	])
