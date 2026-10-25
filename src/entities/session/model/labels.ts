import type { AuthProviderId } from '#shared/api'

import { m } from '#paraglide/messages.js'

export const authProviderLabel = (id: AuthProviderId) =>
	id === 'convex-auth' ? m.auth_provider_convex_auth() : m.auth_provider_better_auth()
