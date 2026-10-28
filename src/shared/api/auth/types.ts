export const AUTH_PROVIDERS = ['convex-auth', 'better-auth'] as const
export type AuthProviderId = (typeof AUTH_PROVIDERS)[number]

export type Credentials = { email: string; password: string }
