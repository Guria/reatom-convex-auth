import betterAuth from '@convex-dev/better-auth/convex.config'
import { defineApp } from 'convex/server'
import { v } from 'convex/values'

// Set by scripts/convex-env.ts (`mise run convex:env`). The auth libraries
// read their own variables (JWT_PRIVATE_KEY, JWKS, BETTER_AUTH_SECRET) directly.
const app = defineApp({
	env: {
		SITE_URL: v.optional(v.string()),
		BETTER_AUTH_JWKS: v.optional(v.string()),
	},
})
app.use(betterAuth)

export default app
