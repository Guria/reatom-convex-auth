import { assert, atom } from '@reatom/core'
import { reatomConvexClient } from 'convex/browser'

import { createBetterAuthClient } from './auth/betterAuth'
import { createConvexAuthTransport } from './auth/convexAuth'

// Read lazily: stories and tests set fakes into these atoms before first use.
const env = (key: 'VITE_CONVEX_URL' | 'VITE_CONVEX_SITE_URL') => {
	const value: unknown = import.meta.env[key]
	assert(typeof value === 'string' && value, `${key} is not set; run \`mise run convex:dev\``)
	return value
}

/** The Convex client; its connection and query state are atoms of the current context. */
export const convex = atom(() => reatomConvexClient(env('VITE_CONVEX_URL')), 'convex')

export const convexAuthTransport = atom(
	() => createConvexAuthTransport(env('VITE_CONVEX_URL')),
	'convexAuthTransport',
)

export const betterAuthClient = atom(
	() => createBetterAuthClient(env('VITE_CONVEX_SITE_URL')),
	'betterAuthClient',
)
