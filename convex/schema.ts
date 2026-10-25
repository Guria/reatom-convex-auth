import { authTables } from '@convex-dev/auth/server'
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
	...authTables,
	notes: defineTable({
		owner: v.string(),
		text: v.string(),
	}).index('by_owner', ['owner']),
})
