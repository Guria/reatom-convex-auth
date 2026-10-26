// The binding side of the size apps: the same models whatever renders them.
import { clearStack, context } from '@reatom/core'
import { ConvexClient } from 'convex/browser'
import { reatomConvex } from 'reatom-convex'

import { sizeApp } from './app'

clearStack()
export const frame = context.start()
export const { onClick, summary } = sizeApp(
	reatomConvex(() => new ConvexClient('https://bench.convex.cloud'), 'convex'),
	frame,
)
