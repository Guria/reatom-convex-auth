import { reatomForm, wrap } from '@reatom/core'

import { api } from '#convex/_generated/api.js'
import { convex } from '#shared/api'

export const reatomNotesPage = () => {
	const addNote = convex.mutation(api.notes.add, 'notesPage.addNote')
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
		notes: convex.query(api.notes.list, () => ({}), 'notesPage.notes'),
		// The backend's view of the caller, independent of the client-side session.
		viewer: convex.query(api.viewer.current, () => ({}), 'notesPage.viewer'),
		form,
	}
}

export type NotesPageModel = ReturnType<typeof reatomNotesPage>
