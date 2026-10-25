/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { expect, test } from 'vite-plus/test'

import { api } from './_generated/api'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

const convexAuthUser = (session: string) => ({
	subject: `user1|${session}`,
	provider: 'convex-auth',
	email: 'ada@example.com',
})
const betterAuthUser = { subject: 'user1', provider: 'better-auth', email: 'ada@example.com' }

test('anonymous callers have no viewer and no notes', async () => {
	const t = convexTest(schema, modules)
	expect(await t.query(api.viewer.current, {})).toBeNull()
	await expect(t.query(api.notes.list, {})).rejects.toThrow('Not authenticated')
	await expect(t.mutation(api.notes.add, { text: 'x' })).rejects.toThrow('Not authenticated')
})

test('a Convex Auth user keeps their notes across sessions', async () => {
	const t = convexTest(schema, modules)
	await t.withIdentity(convexAuthUser('session1')).mutation(api.notes.add, { text: ' first ' })

	const nextSession = t.withIdentity(convexAuthUser('session2'))
	expect(await nextSession.query(api.viewer.current, {})).toEqual({
		owner: 'convex-auth:user1',
		provider: 'convex-auth',
		email: 'ada@example.com',
	})
	expect((await nextSession.query(api.notes.list, {})).map((note) => note.text)).toEqual(['first'])
})

test('providers are separate owners even for the same email and subject', async () => {
	const t = convexTest(schema, modules)
	await t.withIdentity(convexAuthUser('session1')).mutation(api.notes.add, { text: 'convex' })
	const betterAuth = t.withIdentity(betterAuthUser)
	await betterAuth.mutation(api.notes.add, { text: 'better' })

	expect((await betterAuth.query(api.notes.list, {})).map((note) => note.text)).toEqual(['better'])
	expect(await betterAuth.query(api.viewer.current, {})).toMatchObject({
		owner: 'better-auth:user1',
	})
})

test('rejects tokens without provider and email claims', async () => {
	const t = convexTest(schema, modules)
	await expect(t.withIdentity({ subject: 'user1' }).query(api.viewer.current, {})).rejects.toThrow(
		'Token is missing provider/email claims',
	)
})

test('rejects blank notes', async () => {
	const t = convexTest(schema, modules)
	await expect(
		t.withIdentity(betterAuthUser).mutation(api.notes.add, { text: '   ' }),
	).rejects.toThrow('Note text is required')
})
