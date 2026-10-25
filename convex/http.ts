import { httpRouter } from 'convex/server'

import { auth } from './auth'
import { authComponent, createAuth } from './betterAuth'

const http = httpRouter()

// Convex Auth registers `/.well-known/*` first; better-auth then skips its own
// openid-configuration redirect.
auth.addHttpRoutes(http)
authComponent.registerRoutes(http, createAuth, { cors: true })

export default http
