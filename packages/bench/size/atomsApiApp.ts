// The size apps' models straight over the Atoms SDK's Reatom client.
import { clearStack, computed, context, wrap } from '@reatom/core'
import { reatomConvexClient } from 'convex-artifact-atoms/browser'

import { addNoteFirst, api } from '../api'

clearStack()
export const frame = context.start()
const convex = reatomConvexClient('https://bench.convex.cloud', {}, 'convexClient')
const item = computed(
	() => (convex.isAuthenticated() ? convex.query(api.item, { id: 1 }).data() : undefined),
	'item',
)
const pages = frame.run(() => convex.paginatedQuery(api.page, {}, { initialNumItems: 10 }))
frame.run(() => convex.setAuth(async () => 'token'))

/** Adds a note, then loads another page. */
export const onClick = () =>
	void frame
		.run(() => convex.mutation(api.add, { text: 'x' }, { optimisticUpdate: addNoteFirst }))
		.then(wrap(() => pages.loadMore(10), frame))

/** Reads every piece of state the app shows. */
export const summary = () =>
	JSON.stringify([
		convex.isAuthenticated(),
		convex.isRefreshingAuth(),
		convex.connectionState().isWebSocketConnected,
		item(),
		pages.results(),
	])
