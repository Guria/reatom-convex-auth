import { ConvexClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { expect, test, vi } from 'vite-plus/test'

import { createFakeConvexServer } from './fakeConvexServer'

const item = makeFunctionReference<'query', { id: number }, number>('test:item')

test.each(['per-message', 'coalesced'] as const)(
	'%s delivers all results and unsubscribes',
	async (queryResponses) => {
		const server = createFakeConvexServer({
			queryResponses,
			queries: { 'test:item': (_ctx, { id }) => id },
		})
		const client = new ConvexClient('https://fake.convex.cloud', {
			webSocketConstructor: server.WebSocket,
		})
		const received = new Map<number, number>()
		const unsubs: Array<() => void> = []
		try {
			// Wait for the open socket before starting one synchronous burst.
			await vi.waitFor(() => expect(client.connectionState().isWebSocketConnected).toBe(true))
			const before = server.transitionCount()
			for (let id = 0; id < 10; id++) {
				unsubs.push(client.onUpdate(item, { id }, (value) => received.set(id, value)))
			}
			await vi.waitFor(() => expect(received.size).toBe(10))
			expect([...received]).toEqual(Array.from({ length: 10 }, (_, id) => [id, id]))
			expect(server.transitionCount() - before).toBe(queryResponses === 'per-message' ? 10 : 1)
			for (const unsub of unsubs) unsub()
			await vi.waitFor(() => expect(server.subscriptionCount('test:item')).toBe(0))
		} finally {
			await client.close()
			server.close()
		}
	},
)
