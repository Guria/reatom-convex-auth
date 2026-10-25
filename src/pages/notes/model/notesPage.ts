import { reatomForm, wrap } from '@reatom/core'
import { insertAtTop } from 'convex/react'

import { api } from '#convex/_generated/api.js'
import { convex } from '#shared/api'

export const NOTES_PAGE_SIZE = 10

export const reatomNotesPage = () => {
	const viewer = convex.query(api.viewer.current, () => ({}), 'notesPage.viewer')
	const addNote = convex.mutation(api.notes.add, 'notesPage.addNote', {
		// Shows the note first until the server's list includes it.
		optimisticUpdate: (localQueryStore, { text }) => {
			const owner = localQueryStore.getQuery(api.viewer.current, {})?.owner
			if (!owner) return
			insertAtTop({
				paginatedQuery: api.notes.list,
				localQueryStore,
				item: {
					_id: `optimistic:${crypto.randomUUID()}` as never,
					_creationTime: Date.now(),
					owner,
					text: text.trim(),
				},
			})
		},
	})
	const form = reatomForm(
		{ text: '' },
		{
			name: 'notesPage.form',
			onSubmit: async ({ text }) => {
				if (!text.trim()) return
				await wrap(addNote({ text }))
				form.reset()
			},
		},
	)
	return {
		notes: convex.paginatedQuery(
			api.notes.list,
			() => ({}),
			{ initialNumItems: NOTES_PAGE_SIZE },
			'notesPage.notes',
		),
		// The backend's view of the caller, independent of the client-side session.
		viewer,
		form,
	}
}

export type NotesPageModel = ReturnType<typeof reatomNotesPage>
