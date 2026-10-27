import betterAuth from '@convex-dev/better-auth/convex.config'
import { defineApp } from 'convex/server'
import { v } from 'convex/values'

// Set by scripts/convex-env.ts (`mise run convex:env`), except the GitHub OAuth
// app's AUTH_GITHUB_*. The auth libraries read their own variables
// (JWT_PRIVATE_KEY, JWKS, BETTER_AUTH_SECRET) directly.
const app = defineApp({
	env: {
		SITE_URL: v.optional(v.string()),
		BETTER_AUTH_JWKS: v.optional(v.string()),
		AUTH_GITHUB_ID: v.optional(v.string()),
		AUTH_GITHUB_SECRET: v.optional(v.string()),
	},
})
app.use(betterAuth)

export default app
