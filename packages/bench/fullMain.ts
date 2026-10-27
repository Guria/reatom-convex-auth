import type { MutationOptions } from 'convex/browser'

// The focused suite reuses the existing views and DOM completion observer.
import { atom, computed, context, VERSION } from '@reatom/core'
import { BaseConvexClient as Rewritten, reatomConvexClient } from 'convex-artifact-atoms/browser'
import { BaseConvexClient as Patched } from 'convex-artifact-batched/browser'
import { createFakeConvexServer } from 'convex-fake-server'
import { makeFunctionReference } from 'convex/server'

import { CLIENT_URL, createBenchServer, until, type Binding } from './fixture'
import { allBindings, bench, measure, session } from './main'
import { checkPlainClient } from './plainChecks'
import { createPlainNativeClient } from './plainClient'
import { createPlainPrClient } from './plainPrClient'

const modes = [
	{
		id: 'pr-react',
		label: 'PR #211 · convex/react',
		binding: 'convex/react TS patch',
		pair: 'React API',
	},
	{
		id: 'native-react',
		label: 'Reatom rewrite · convex/react',
		binding: 'convex/react Atoms SDK',
		pair: 'React API',
	},
	{
		id: 'pr-reatom',
		label: 'PR #211 · Reatom binding + React',
		binding: '@reatom/react TS patch',
		pair: 'Reatom + React',
	},
	{
		id: 'native-reatom',
		label: 'Reatom rewrite · direct atoms + React',
		binding: '@reatom/react Atoms SDK API',
		pair: 'Reatom + React',
	},
	{
		id: 'pr-jsx',
		label: 'PR #211 · Reatom binding + JSX',
		binding: '@reatom/jsx TS patch',
		pair: 'Reatom + JSX',
	},
	{
		id: 'native-jsx',
		label: 'Reatom rewrite · direct atoms + JSX',
		binding: '@reatom/jsx Atoms SDK API',
		pair: 'Reatom + JSX',
	},
] as const
export const plainModes = [
	...modes.slice(0, 2),
	{
		id: 'pr-plain',
		label: 'PR #211 · plain React store',
		binding: 'PR #211 plain React',
		pair: 'Plain React',
	},
	{
		id: 'native-plain',
		label: 'Native atoms · plain React store',
		binding: 'Native plain React',
		pair: 'Plain React',
	},
] as const
export type FullMode = (typeof modes)[number] | (typeof plainModes)[number]
export type FullConfig = {
	items: number
	queryResponses: 'per-message' | 'coalesced'
	batchQuerySet: boolean
}
const findBinding = (id: string): Binding => {
	const mode = [...modes, ...plainModes].find((entry) => entry.id === id)
	const binding = allBindings.find((entry) => entry.label === mode?.binding)
	if (!binding) throw new Error(`Unknown mode ${id}`)
	return binding
}

async function extraViews(id: string, config: FullConfig) {
	return session(findBinding(id), config, async ({ server, instance, container }) => {
		const ids = Array.from({ length: config.items }, (_, i) => i)
		instance.items(ids)
		await until(container, { selector: '[data-v="0"]', count: config.items })
		const changed = Math.max(1, Math.floor(config.items / 100))
		const sparse = await measure(container, () => server.bump(ids.slice(0, changed)), {
			selector: '[data-v="1"]',
			count: changed,
		})
		const count = Math.max(1, Math.floor(config.items / 10))
		const next = [...ids.slice(count), ...ids.slice(0, count).map((i) => i + config.items)]
		const churn = await measure(container, () => instance.items(next), {
			selector: '[data-v="0"]',
			count: config.items,
		})
		// Check every new query, not only the first DOM node used for timing.
		await until(container, { selector: `[data-v="0"]`, count: config.items })
		const active = server.server.subscriptionCount('bench:item')
		if (active !== config.items) throw new Error(`Churn leaked subscriptions: ${active}`)
		return { 'update 1%': sparse, 'replace 10%': churn }
	})
}

const item = makeFunctionReference<'query', { id: number }, number>('bench:scalar')
const write = makeFunctionReference<'mutation', { id: number }, number>('bench:write')
const echo = makeFunctionReference<'action', { id: number }, number>('bench:echo')
type ClientKind = 'pr-base' | 'native-base' | 'native-atoms' | 'pr-plain' | 'native-plain'
type Watcher = {
	connected(): boolean
	watch(id: number, receive: (value: number) => void): () => void
	mutation(id: number, optimistic?: boolean): Promise<unknown>
	action(id: number): Promise<unknown>
	close(): Promise<void>
}

const clientOptions = (WebSocket: typeof globalThis.WebSocket) => ({
	webSocketConstructor: WebSocket,
	unsavedChangesWarning: false,
	logger: false as const,
})
const optimisticOptions = (
	id: number,
	enabled: boolean | undefined,
): MutationOptions | undefined =>
	enabled
		? {
				optimisticUpdate: (store) =>
					store.setQuery(item, { id }, (store.getQuery(item, { id }) ?? 0) + 1),
			}
		: undefined

function plainWatcher(
	factory: typeof createPlainNativeClient | typeof createPlainPrClient,
	WebSocket: typeof globalThis.WebSocket,
): Watcher {
	const client = factory(CLIENT_URL, clientOptions(WebSocket))
	return {
		connected: () => client.connection.getSnapshot().isWebSocketConnected,
		watch: (id, receive) =>
			client.onUpdate(item, { id }, receive, (error) => {
				throw error
			}),
		mutation: (id, optimistic) => client.mutation(write, { id }, optimisticOptions(id, optimistic)),
		action: (id) => client.action(echo, { id }),
		close: client.close,
	}
}
function nativeWatcher(WebSocket: typeof globalThis.WebSocket): Watcher {
	const frame = context.start()
	const client = reatomConvexClient(CLIENT_URL, clientOptions(WebSocket))
	const disconnect = frame.run(() => client.connectionState.subscribe(() => {}))
	return {
		connected: () => frame.run(() => client.connectionState().isWebSocketConnected),
		watch: (id, receive) =>
			frame.run(() =>
				client.query(item, { id }).data.subscribe((value: number | undefined) => {
					if (value !== undefined) receive(value)
				}),
			),
		mutation: (id, optimistic) =>
			frame.run(() => client.mutation(write, { id }, optimisticOptions(id, optimistic))),
		action: (id) => frame.run(() => client.action(echo, { id })),
		close: () =>
			frame.run(() => {
				disconnect()
				return client.close()
			}),
	}
}
function sdkWatcher(Constructor: typeof Patched, WebSocket: typeof globalThis.WebSocket): Watcher {
	const listeners = new Map<string, { id: number; callbacks: Set<(value: number) => void> }>()
	const deliver = (entry: { id: number; callbacks: Set<(value: number) => void> }) => {
		const value = client.localQueryResult('bench:scalar', { id: entry.id })
		if (typeof value !== 'number') return
		for (const receive of entry.callbacks) receive(value)
	}
	const client = new Constructor(
		CLIENT_URL,
		(tokens) => {
			for (const token of tokens) {
				const entry = listeners.get(token)
				if (!entry) continue
				deliver(entry)
			}
		},
		clientOptions(WebSocket),
	)
	return {
		connected: () => client.connectionState().isWebSocketConnected,
		watch(id, receive) {
			const subscription = client.subscribe('bench:scalar', { id })
			let entry = listeners.get(subscription.queryToken)
			if (!entry) listeners.set(subscription.queryToken, (entry = { id, callbacks: new Set() }))
			const set = entry.callbacks
			set.add(receive)
			const cached = client.localQueryResult('bench:scalar', { id })
			if (typeof cached === 'number') receive(cached)
			return () => {
				set.delete(receive)
				if (!set.size) listeners.delete(subscription.queryToken)
				subscription.unsubscribe()
			}
		},
		mutation: (id, optimistic) =>
			client.mutation('bench:write', { id }, optimisticOptions(id, optimistic)),
		action: (id) => client.action('bench:echo', { id }),
		close: () => client.close(),
	}
}

const watcherFactories: Record<ClientKind, (WebSocket: typeof globalThis.WebSocket) => Watcher> = {
	'pr-base': (ws) => sdkWatcher(Patched, ws),
	'native-base': (ws) => sdkWatcher(Rewritten, ws),
	'native-atoms': nativeWatcher,
	'pr-plain': (ws) => plainWatcher(createPlainPrClient, ws),
	'native-plain': (ws) => plainWatcher(createPlainNativeClient, ws),
}
const createWatcher = (kind: ClientKind, WebSocket: typeof globalThis.WebSocket) =>
	watcherFactories[kind](WebSocket)

export type FullSample = {
	ms: number
	renders?: number
	commits?: number
	transitions?: number
	adds?: number
	querySetMessages?: number
	callbacks?: number
}
const expectNumber = (actual: number | undefined, expected: number, message: string) => {
	if (actual !== expected) throw new Error(message)
}
const clients: ClientKind[] = ['pr-base', 'native-base', 'native-atoms']
async function clientRun(kind: ClientKind, config: FullConfig) {
	const values = new Map<number, number>()
	const server = createFakeConvexServer({
		queryResponses: config.queryResponses,
		queries: { 'bench:scalar': (_ctx, { id }) => values.get(Number(id)) ?? 0 },
		mutations: {
			'bench:write': (_ctx, { id }) => {
				const next = (values.get(Number(id)) ?? 0) + 1
				values.set(Number(id), next)
				return next
			},
		},
		actions: { 'bench:echo': (_ctx, { id }) => id },
	})
	const client = createWatcher(kind, server.WebSocket)
	const wait = async (condition: () => boolean) => {
		const deadline = performance.now() + 20_000
		while (!condition()) {
			if (performance.now() > deadline) throw new Error(`${kind}: client condition timed out`)
			await server.settled()
		}
	}
	const samples: Record<string, FullSample> = {}
	let callbacks = 0
	const time = async (name: string, run: () => void | Promise<unknown>, done: () => boolean) => {
		const before = server.traffic()
		const priorCallbacks = callbacks
		const start = performance.now()
		await run()
		await wait(done)
		const ms = performance.now() - start
		const after = server.traffic()
		samples[name] = {
			ms,
			callbacks: callbacks - priorCallbacks,
			transitions: after.transitions - before.transitions,
			querySetMessages: after.querySetMessages - before.querySetMessages,
			adds: after.adds - before.adds,
		}
	}
	let stops: Array<() => void> = []
	try {
		await wait(client.connected)
		await server.settled()
		const seen = new Map<number, number>()
		const watch = (id: number) =>
			client.watch(id, (v) => {
				callbacks++
				seen.set(id, v)
			})
		const ids = Array.from({ length: config.items }, (_, i) => i)
		await time(
			'subscribe distinct',
			() => {
				stops = ids.map(watch)
			},
			() => seen.size === config.items,
		)
		for (const [name, changed] of [
			['update all', ids],
			['update 1%', ids.slice(0, Math.max(1, Math.floor(config.items / 100)))],
			['update one', [Math.floor(config.items / 2)]],
		] as const) {
			await time(
				name,
				() => {
					for (const id of changed) values.set(id, (values.get(id) ?? 0) + 1)
					server.invalidate()
				},
				() => changed.every((id) => seen.get(id) === values.get(id)),
			)
		}
		const burstValue = (values.get(0) ?? 0) + 20
		await time(
			'20 separate transitions',
			() => {
				for (let i = 0; i < 20; i++) {
					values.set(0, (values.get(0) ?? 0) + 1)
					server.invalidate()
				}
			},
			() => seen.get(0) === burstValue,
		)
		// Ten overlapping optimistic layers, with N unrelated live queries.
		const confirmedValue = (values.get(0) ?? 0) + 10
		await time(
			'10 optimistic mutations',
			() => Promise.all(Array.from({ length: 10 }, () => client.mutation(0, true))),
			() => seen.get(0) === values.get(0),
		)
		expectNumber(seen.get(0), confirmedValue, 'Optimistic confirmation mismatch')
		await time(
			'unsubscribe distinct',
			() => stops.splice(0).forEach((stop) => stop()),
			() => server.subscriptionCount('bench:scalar') === 0,
		)
		let sharedCallbacks = 0
		await time(
			'subscribe shared',
			() => {
				stops = ids.map(() =>
					client.watch(999999, () => {
						callbacks++
						sharedCallbacks++
					}),
				)
			},
			() => sharedCallbacks === config.items,
		)
		expectNumber(server.subscriptionCount('bench:scalar'), 1, 'Shared query did not dedupe')
		await time(
			'update shared',
			() => {
				values.set(999999, 42)
				server.invalidate()
			},
			() => sharedCallbacks === config.items * 2,
		)
		stops.splice(0).forEach((stop) => stop())
		await wait(() => server.subscriptionCount('bench:scalar') === 0)
		await time(
			'100 mutations',
			() => Promise.all(Array.from({ length: 100 }, (_, i) => client.mutation(i))),
			() => true,
		)
		await time(
			'100 actions',
			() =>
				Promise.all(Array.from({ length: 100 }, (_, i) => client.action(i))).then((results) => {
					if (results.some((v, i) => v !== i)) throw new Error('Action result mismatch')
				}),
			() => true,
		)
		return samples
	} finally {
		stops.forEach((stop) => stop())
		await client.close()
		server.close()
	}
}

// Memory probes use explicit GC outside timing. Hold exactly the live view, not prior samples.
let retained: (() => Promise<void>) | undefined
async function memoryMount(id: string, config: FullConfig) {
	const server = createBenchServer(config.queryResponses)
	const container = document.createElement('div')
	document.body.append(container)
	const instance = findBinding(id).create(server, container, { batchQuerySet: true })
	instance.items(Array.from({ length: config.items }, (_, i) => i))
	await until(container, { selector: '[data-v="0"]', count: config.items })
	await server.server.settled()
	retained = async () => {
		await instance.close()
		container.remove()
		server.server.close()
	}
}

// Reactive arguments are exercised directly rather than pretending they are available in BaseConvexClient.
async function reactiveArgs(config: FullConfig) {
	const server = createFakeConvexServer({
		queryResponses: config.queryResponses,
		queries: { 'bench:scalar': (_ctx, { id }) => id },
	})
	const frame = context.start()
	const client = reatomConvexClient(CLIENT_URL, clientOptions(server.WebSocket))
	const id = atom(0, 'bench.id')
	const model = computed(() => client.query(item, { id: id() }).data(), 'bench.reactiveArgs')
	let value: unknown
	const stop = frame.run(() =>
		model.subscribe((next) => {
			value = next
		}),
	)
	try {
		for (let next = 0; next < 10; next++) {
			frame.run(() => id.set(next))
			const deadline = performance.now() + 10_000
			// The external websocket callback updates value.
			// oxlint-disable-next-line no-unmodified-loop-condition
			while (value !== next) {
				if (performance.now() > deadline) throw new Error('Reactive args failed')
				await server.settled()
			}
		}
	} finally {
		stop()
		await frame.run(client.close)
		server.close()
	}
}

const fullBench = {
	checkPlainClient,
	version: VERSION,
	modes,
	plainModes,
	plainClients: ['pr-base', 'native-base', 'pr-plain', 'native-plain'] satisfies ClientKind[],
	clients,
	runView: (id: string, scenario: string, config: FullConfig) =>
		scenario === 'extra'
			? extraViews(id, config)
			: bench.run(findBinding(id).label, scenario, config),
	clientRun,
	reactiveArgs,
	memoryMount,
	memoryClear: async () => {
		await retained?.()
		retained = undefined
	},
}
export type FullBench = typeof fullBench
Object.assign(window, { fullBench })
