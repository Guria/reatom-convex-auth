import { Fragment } from 'react'

import { protectedRoute } from '#entities/session'

import { NotesPage } from '../ui/NotesPage'
import { reatomNotesPage } from './notesPage'

// The Convex subscriptions connect when NotesPage renders them, which only
// happens under the authenticated protectedRoute.
export const notesRoute = protectedRoute.reatomRoute(
	{
		path: 'notes',
		async loader() {
			return reatomNotesPage()
		},
		render(self) {
			const { isFulfilled, data } = self.loader.status()
			return isFulfilled ? <NotesPage key="notes" model={data} /> : <Fragment key="loading" />
		},
	},
	'notes',
)
