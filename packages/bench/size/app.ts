// The app every Reatom size build renders, over either client's API.
import type { reatomConvex } from 'reatom-convex'

import { wrap, type Frame } from '@reatom/core'

import { addNoteFirst, api } from '../api'

type Convex = Pick<
	ReturnType<typeof reatomConvex>,
	'query' | 'mutation' | 'paginatedQuery' | 'setAuth' | 'serverAuthenticated' | 'isRefreshingAuth'
> & { connectionState: () => { isWebSocketConnected: boolean } }

export function sizeApp(convex: Convex, frame: Frame) {
	const item = convex.query(
		api.item,
		() => (convex.serverAuthenticated() ? { id: 1 } : 'skip'),
		'item',
	)
	const add = convex.mutation(api.add, 'add', { optimisticUpdate: addNoteFirst })
	const pages = convex.paginatedQuery(api.page, () => ({}), { initialNumItems: 10 }, 'pages')
	frame.run(() => convex.setAuth(async () => 'token'))
	return {
		/** Adds a note, then loads another page. */
		onClick: () => void add({ text: 'x' }).then(wrap(() => pages.loadMore(10))),
		/** Reads every piece of state the app shows. */
		summary: () =>
			JSON.stringify([
				convex.serverAuthenticated(),
				convex.isRefreshingAuth(),
				convex.connectionState().isWebSocketConnected,
				item.data(),
				pages.results(),
			]),
	}
}
