import { expect, waitFor } from 'storybook/test'

import preview from '#.storybook/preview'
import { App } from '#app/App'
import { notesLoc, withNotesPage } from '#pages/notes/testing'
import { fakeConvexBackend } from '#shared/mocks/convexBackend'
import { button, createActor, role, text } from '#shared/test'

const I = createActor().extend(withNotesPage)

// Seeded oldest first; the list shows newest first.
const seedNotes = Array.from({ length: 12 }, (_, index) => `Seeded note ${index + 1}`)

const meta = preview.meta({
	title: 'Integration/Sync',
	component: App,
	parameters: { layout: 'fullscreen', authenticated: true, initialPath: 'notes', seedNotes },
	loaders: [(ctx) => I.init(ctx)],
})

export default meta

export const PaginatesNotes = meta.story({ name: 'Paginates Notes' })

PaginatesNotes.test('loads ten notes, then the rest on demand', async () => {
	await I.seeNote('Seeded note 12')
	await I.see(text('Seeded note 3'))
	await I.dontSee(text('Seeded note 2'))

	await I.click(button('Load more'))
	await I.seeNote('Seeded note 1')
	await I.waitExit(button('Load more'))
})

export const AddsNotesOffline = meta.story({ name: 'Adds Notes Offline' })

AddsNotesOffline.test(
	'shows a note added offline at once and confirms it after reconnecting',
	async () => {
		await I.seeNote('Seeded note 12')
		fakeConvexBackend.current.server.setOnline(false)
		await I.see(role('status', /Connection lost/).wait())

		await I.fill(notesLoc.newNote, 'Written offline')
		await I.click(button('Add note'))
		// The optimistic update renders it while the mutation waits for the socket.
		await I.seeNote('Written offline')
		await I.see(button('Adding note'))

		// Back online once the client retries, not during its reconnect backoff.
		const { server } = fakeConvexBackend.current
		await waitFor(() => expect(server.pendingConnections()).toBe(1), { timeout: 5000 })
		server.setOnline(true)
		await I.waitExit(button('Adding note'))
		await I.waitExit(role('status', /Connection lost/))
		await I.seeNote('Written offline')
	},
)

export const RefreshesExpiredToken = meta.story({ name: 'Refreshes Expired Token' })

RefreshesExpiredToken.test('keeps the session when the server expires the token', async () => {
	await I.seeNote('Seeded note 12')
	const backend = fakeConvexBackend.current
	// The restored token, then the fresh one the client trades it for. An
	// expiry while the fresh one is on its way is ignored.
	await waitFor(() => expect(backend.authentications()).toBe(2))
	backend.server.expireAuth()
	await waitFor(() => expect(backend.subscriptionCount('notes:list')).toBe(0))
	// The client fetched a fresh token and re-subscribed with it.
	await waitFor(() => expect(backend.subscriptionCount('notes:list')).toBe(1))
	await I.waitExit(role('status', 'Refreshing session'))
	await I.seeNote('Seeded note 12')
	await I.dontSee(text('The backend rejected this session'))
})
