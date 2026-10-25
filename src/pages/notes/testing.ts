import type { BaseActor, Canvas } from 'kahraman'

import { button, heading, role, text } from '#shared/test'

const field = (label: string) => (canvas: Canvas) => canvas.getByLabelText(label)

export const notesLoc = {
	heading: heading('Notes'),
	newNote: field('New note'),
	list: role('list', 'Notes'),
}

// List items take no accessible name from their content. `within` resolves its
// scope immediately, so the list is awaited first.
const seeNote = async (I: Pick<BaseActor, 'see'>, content: string) => {
	const list = await I.see(notesLoc.list.wait())
	await I.see(text(content).within(list).wait())
}

export const withNotesPage = (I: Pick<BaseActor, 'click' | 'fill' | 'see' | 'waitExit'>) => ({
	addNote: async (content: string) => {
		await I.fill(notesLoc.newNote, content)
		await I.click(button('Add note'))
		await I.waitExit(button('Adding note'))
		await seeNote(I, content)
	},
	seeNote: (content: string) => seeNote(I, content),
	signOut: async (email: string) => {
		await I.click(button(new RegExp(email)))
		await I.click(role('menuitem', /Sign out/).wait())
	},
})
