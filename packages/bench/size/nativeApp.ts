// The size apps' models over the client whose state lives in atoms.
import { clearStack, context } from '@reatom/core'
import { reatomConvex, reatomConvexClient } from 'reatom-convex-client'

import { sizeApp } from './app'

clearStack()
export const frame = context.start()
export const { onClick, summary } = sizeApp(
	reatomConvex(
		() => reatomConvexClient('https://bench.convex.cloud', {}, 'convexClient'),
		'convex',
	),
	frame,
)
