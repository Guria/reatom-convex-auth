import { ConvexError, v } from 'convex/values'

import { mutation, query } from './_generated/server'
import schema from './schema'
import { requireViewer } from './viewer'

const NOTES_LIMIT = 100

export const list = query({
	args: {},
	returns: v.array(schema.doc('notes')),
	handler: async (ctx) => {
		const { owner } = await requireViewer(ctx)
		return ctx.db
			.query('notes')
			.withIndex('by_owner', (q) => q.eq('owner', owner))
			.order('desc')
			.take(NOTES_LIMIT)
	},
})

export const add = mutation({
	args: { text: v.string() },
	returns: v.id('notes'),
	handler: async (ctx, { text }) => {
		const { owner } = await requireViewer(ctx)
		const trimmed = text.trim()
		if (!trimmed) throw new ConvexError('Note text is required')
		return ctx.db.insert('notes', { owner, text: trimmed })
	},
})
