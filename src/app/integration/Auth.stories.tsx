import { expect, waitFor } from 'storybook/test'

import preview from '#.storybook/preview'
import { App } from '#app/App'
import { loginLoc, withLoginPage } from '#pages/login/testing'
import { notesLoc, withNotesPage } from '#pages/notes/testing'
import { fakeConvexBackend } from '#shared/mocks/convexBackend'
import { createActor, heading, role, text } from '#shared/test'

const I = createActor().extend(withLoginPage).extend(withNotesPage)

// Convex is faked in memory (see src/shared/mocks/convexBackend.ts); these
// counts are its live `onUpdate` subscriptions.
const expectNotesSubscriptions = (count: number) =>
	waitFor(() => expect(fakeConvexBackend.current.subscriptionCount('notes:list')).toBe(count))

const meta = preview.meta({
	title: 'Integration/Auth',
	component: App,
	parameters: { layout: 'fullscreen', authenticated: false, initialPath: 'notes' },
	loaders: [(ctx) => I.init(ctx)],
})

export default meta

// Gate closed

export const SignedOutConvexAuth = meta.story({
	name: 'Signed Out (Convex Auth)',
	parameters: { authProvider: 'convex-auth' },
})

SignedOutConvexAuth.test(
	'redirects private routes to sign-in without subscribing to private data',
	async () => {
		await I.see(loginLoc.signInHeading)
		await I.seeChecked(role('radio', 'Convex Auth'))
		await I.dontSee(notesLoc.heading)
		await expectNotesSubscriptions(0)
	},
)

export const SignedOutBetterAuth = meta.story({
	name: 'Signed Out (Better Auth)',
	parameters: { authProvider: 'better-auth' },
})

SignedOutBetterAuth.test(
	'redirects private routes to sign-in without subscribing to private data',
	async () => {
		await I.see(loginLoc.signInHeading)
		await I.seeChecked(role('radio', 'Better Auth'))
		await I.dontSee(notesLoc.heading)
		await expectNotesSubscriptions(0)
	},
)

// Gate open

export const ConvexAuthJourney = meta.story({ name: 'Convex Auth Journey' })

ConvexAuthJourney.test('signs up, reads private notes, signs out, and signs back in', async () => {
	const ada = { email: 'ada@example.com', password: 'analytical-engine' }
	await I.chooseProvider('Convex Auth')
	await I.signUp(ada)

	await I.see(notesLoc.heading.wait())
	await I.see(text('Signed in with Convex Auth as ada@example.com').wait())
	await I.see(text('No notes yet. Add the first one.').wait())
	await expectNotesSubscriptions(1)
	await I.addNote('Bernoulli numbers')

	await I.signOut(ada.email)
	await I.see(loginLoc.signInHeading.wait())
	await I.dontSee(text('Bernoulli numbers'))
	await expectNotesSubscriptions(0)

	await I.signIn(ada)
	await I.seeNote('Bernoulli numbers')
	await I.signOut(ada.email)
	await I.see(loginLoc.signInHeading.wait())
})

export const BetterAuthJourney = meta.story({ name: 'Better Auth Journey' })

BetterAuthJourney.test('signs up, reads private notes, signs out, and signs back in', async () => {
	const grace = { email: 'grace@example.com', password: 'compiler-a0' }
	await I.chooseProvider('Better Auth')
	await I.signUp(grace)

	await I.see(notesLoc.heading.wait())
	await I.see(text('Signed in with Better Auth as grace@example.com').wait())
	await I.see(text('No notes yet. Add the first one.').wait())
	await expectNotesSubscriptions(1)
	await I.addNote('COBOL draft')

	await I.signOut(grace.email)
	await I.see(loginLoc.signInHeading.wait())
	await I.dontSee(text('COBOL draft'))
	await expectNotesSubscriptions(0)

	await I.signIn(grace)
	await I.seeNote('COBOL draft')
	await I.signOut(grace.email)
	await I.see(loginLoc.signInHeading.wait())
})

export const ProvidersKeepSeparateAccounts = meta.story({
	name: 'Providers Keep Separate Accounts',
})

ProvidersKeepSeparateAccounts.test(
	'an account created with one provider cannot sign in through the other',
	async () => {
		const ada = { email: 'ada@example.com', password: 'analytical-engine' }
		await I.chooseProvider('Convex Auth')
		await I.signUp(ada)
		await I.see(notesLoc.heading.wait())
		await I.signOut(ada.email)

		await I.see(loginLoc.signInHeading.wait())
		await I.chooseProvider('Better Auth')
		await I.signIn(ada)
		await I.see(role('alert'))
		await I.see(text('Check your email and password, then try again.'))
		await I.dontSee(notesLoc.heading)
	},
)

export const RestoresSession = meta.story({
	name: 'Restores Session',
	parameters: { authenticated: true },
})

RestoresSession.test('waits for the backend to accept a stored session', async () => {
	await I.waitExit(role('status', 'Checking session'))
	await I.see(heading('Notes'))
	await I.see(text('Signed in with Convex Auth as alex@example.com').wait())
})
