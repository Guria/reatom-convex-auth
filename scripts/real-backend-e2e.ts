// Drives the running app (`mise run dev`) against the running local Convex
// backend (`mise run convex:dev`) in Chromium, once per auth provider. Fails on
// any page error or console error.
import { chromium, type Page } from 'playwright'

const APP_URL = process.env['APP_URL'] ?? 'http://localhost:5173'
const stamp = Date.now()
const password = 'correct-horse-battery'

const providers = [
	{ label: 'Convex Auth', email: `ca-e2e-${stamp}@example.com` },
	{ label: 'Better Auth', email: `ba-e2e-${stamp}@example.com` },
]

const step = (message: string) => console.log(`  ${message}`)

// src/pages/notes/model/notesPage.ts
const PAGE_SIZE = 10

async function addNote(page: Page, text: string) {
	await page.getByLabel('New note').fill(text)
	await page.getByRole('button', { name: 'Add note' }).click()
	await page.getByRole('list', { name: 'Notes' }).getByText(text, { exact: true }).waitFor()
	await page.getByRole('button', { name: 'Add note' }).waitFor()
}

async function signOut(page: Page, email: string) {
	await page.getByRole('button', { name: new RegExp(email) }).click()
	await page.getByRole('menuitem', { name: /Sign out/ }).click()
	await page.getByRole('heading', { name: 'Sign in' }).waitFor()
}

async function journey(page: Page, { label, email }: (typeof providers)[number]) {
	console.log(label)
	await page.goto(`${APP_URL}/notes`)
	await page.getByRole('heading', { name: 'Sign in' }).waitFor()
	step('signed out: /notes redirects to sign-in')

	await page.getByRole('radio', { name: label }).check()
	await page.getByRole('button', { name: 'Create an account' }).click()
	await page.getByLabel('Email').fill(email)
	await page.getByLabel('Password').fill(password)
	await page.getByRole('button', { name: 'Create account' }).click()
	await page.getByText(`Signed in with ${label} as ${email}`).waitFor()
	step('signed up; backend identifies the provider')

	const note = `note from ${label} ${stamp}`
	await addNote(page, note)
	step('added a private note')

	await page.reload()
	await page.getByRole('list', { name: 'Notes' }).getByText(note).waitFor()
	step('reload restores the session')

	await signOut(page, email)
	step('signed out')

	await page.getByRole('radio', { name: label }).check()
	await page.getByLabel('Email').fill(email)
	await page.getByLabel('Password').fill(password)
	await page.getByRole('button', { name: 'Sign in', exact: true }).click()
	await page.getByRole('list', { name: 'Notes' }).getByText(note).waitFor()
	step('signed back in and sees the note')

	// A loaded page keeps its end, so it grows instead of pushing the note out.
	for (let index = 1; index <= PAGE_SIZE; index++) await addNote(page, `filler ${index}`)
	const notes = page.getByRole('list', { name: 'Notes' })
	await notes.getByText(note).waitFor()
	step('a loaded page grows as notes are added')

	await page.reload()
	await notes.getByText(`filler ${PAGE_SIZE}`, { exact: true }).waitFor()
	await notes.getByText(note).waitFor({ state: 'detached' })
	await page.getByRole('button', { name: 'Load more' }).click()
	await notes.getByText(note).waitFor()
	step('after a reload the oldest note is on the second page')

	await signOut(page, email)
}

const browser = await chromium.launch()
const errors: string[] = []
try {
	const context = await browser.newContext()
	const page = await context.newPage()
	page.setDefaultTimeout(15_000)
	page.on('pageerror', (error) => errors.push(`pageerror: ${error.stack ?? error.message}`))
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(`console: ${message.text()}`)
	})
	for (const provider of providers) await journey(page, provider)
} finally {
	await browser.close()
}

if (errors.length > 0) {
	console.error(errors.join('\n'))
	throw new Error(`${errors.length} browser error(s)`)
}
console.log('e2e: all journeys passed')
