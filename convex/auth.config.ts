import type { AuthConfig } from 'convex/server'

// One provider serves both libraries: Convex Auth and better-auth sign with
// the same key, issuer and audience (see scripts/convex-env.ts).
export default {
	providers: [{ domain: process.env['CONVEX_SITE_URL'] ?? '', applicationID: 'convex' }],
} satisfies AuthConfig
