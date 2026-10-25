import type { DataModel } from './_generated/dataModel'

import { createClient, type GenericCtx } from '@convex-dev/better-auth'
import { convex, crossDomain } from '@convex-dev/better-auth/plugins'
import { betterAuth } from 'better-auth/minimal'

import { components } from './_generated/api'
import { env } from './_generated/server'
import authConfig from './auth.config'
import { BETTER_AUTH_BASE_PATH } from './authPaths'

const siteUrl = env.SITE_URL ?? 'http://localhost:5173'

export const authComponent = createClient<DataModel>(components.betterAuth)

export const createAuth = (ctx: GenericCtx<DataModel>) =>
	betterAuth({
		baseURL: env.CONVEX_SITE_URL,
		basePath: BETTER_AUTH_BASE_PATH,
		trustedOrigins: [siteUrl],
		database: authComponent.adapter(ctx),
		emailAndPassword: { enabled: true, requireEmailVerification: false },
		plugins: [
			crossDomain({ siteUrl }),
			convex({
				authConfig,
				options: { basePath: BETTER_AUTH_BASE_PATH },
				// Static key shared with Convex Auth, so tokens from both libraries
				// verify against the one JWKS Convex Auth serves.
				jwks: env.BETTER_AUTH_JWKS,
				jwt: {
					definePayload: ({ user }) => ({
						provider: 'better-auth',
						email: user.email,
						name: user.name,
					}),
				},
			}),
		],
	})
