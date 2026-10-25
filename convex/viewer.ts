import type { Infer } from 'convex/values'

import { ConvexError, v } from 'convex/values'

import { query, type QueryCtx } from './_generated/server'

const viewer = v.object({
	owner: v.string(),
	provider: v.union(v.literal('convex-auth'), v.literal('better-auth')),
	email: v.string(),
})

export type Viewer = Infer<typeof viewer>

const isProvider = (value: unknown): value is Viewer['provider'] =>
	value === 'convex-auth' || value === 'better-auth'

// Both auth libraries share an issuer, so the `provider` claim (set in auth.ts
// and betterAuth.ts) tells them apart. `tokenIdentifier` is no stable owner
// here: Convex Auth's subject is `userId|sessionId`, so only its user part is.
export async function getViewer(ctx: QueryCtx): Promise<Viewer | null> {
	const identity = await ctx.auth.getUserIdentity()
	if (!identity) return null
	const { provider, email } = identity
	if (!isProvider(provider) || typeof email !== 'string') {
		throw new ConvexError('Token is missing provider/email claims')
	}
	const userId = provider === 'convex-auth' ? identity.subject.split('|')[0] : identity.subject
	return { owner: `${provider}:${userId}`, provider, email }
}

export async function requireViewer(ctx: QueryCtx): Promise<Viewer> {
	const current = await getViewer(ctx)
	if (!current) throw new ConvexError('Not authenticated')
	return current
}

export const current = query({
	args: {},
	returns: v.union(viewer, v.null()),
	handler: (ctx) => getViewer(ctx),
})
