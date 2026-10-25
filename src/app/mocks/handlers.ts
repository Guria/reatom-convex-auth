import type { RequestHandler } from 'msw'

import { dashboardStats } from '#entities/dashboard/mocks/handlers'

export const handlers = {
	dashboardStats: dashboardStats.default,
} satisfies Record<string, RequestHandler | RequestHandler[]>

export const handlersArray = Object.values(handlers).flat() satisfies RequestHandler[]
