import { convexClient, crossDomainClient } from '@convex-dev/better-auth/client/plugins'
import { assert, atom } from '@reatom/core'
import { reatomConvexClient } from '@reatomized/convex'
import { createAuthClient } from 'better-auth/client'

import { BETTER_AUTH_BASE_PATH } from '#convex/authPaths'

// Read lazily: stories and tests set fakes into these atoms before first use.
const env = (key: 'VITE_CONVEX_URL' | 'VITE_CONVEX_SITE_URL') => {
	const value: unknown = import.meta.env[key]
	assert(typeof value === 'string' && value, `${key} is not set; run \`mise run convex:dev\``)
	return value
}

/** The Convex client; its connection and query state are atoms of the current context. */
export const convex = atom(() => reatomConvexClient(env('VITE_CONVEX_URL')), 'convex')

/**
 * The Convex site is another origin: `crossDomainClient` keeps the session
 * cookie in localStorage and sends it as the `Better-Auth-Cookie` header.
 */
export const createBetterAuthClient = (siteUrl: string) =>
	createAuthClient({
		baseURL: `${siteUrl}${BETTER_AUTH_BASE_PATH}`,
		plugins: [convexClient(), crossDomainClient()],
	})

// Holds a getter: the client is a Proxy that answers every property, `then`
// included, with a request function, so neither Reatom nor its logger may look
// inside it.
export const betterAuthClient = atom(() => {
	const client = createBetterAuthClient(env('VITE_CONVEX_SITE_URL'))
	return () => client
}, 'betterAuthClient')

/** Sends the browser to another site; stories replace it to stay on the page. */
export const assignLocation = atom(
	() => (url: string) => window.location.assign(url),
	'assignLocation',
)
