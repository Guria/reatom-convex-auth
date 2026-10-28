import GitHub from '@auth/core/providers/github'
import { Password } from '@convex-dev/auth/providers/Password'
import { convexAuth } from '@convex-dev/auth/server'

// Convex Auth owns this module: its client calls `auth:signIn` / `auth:signOut`.
// GitHub reads AUTH_GITHUB_ID and AUTH_GITHUB_SECRET.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
	providers: [Password, GitHub],
	jwt: {
		customClaims: async (ctx, { userId }) => {
			const user = await ctx.db.get(userId)
			return { provider: 'convex-auth', email: user?.email }
		},
	},
})
