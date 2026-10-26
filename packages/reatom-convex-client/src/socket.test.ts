// Protocol paths the fake server never takes, driven by a hand-played socket.
import { context } from '@reatom/core'
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'

import { reatomConvexClient, type ConvexClientOptions } from './client'
import { encodeTs } from './protocol'

type Message = { type: string } & Record<string, unknown>

class ScriptedSocket {
	static instances: ScriptedSocket[] = []
	readyState = 0
	sent: Message[] = []
	onopen: ((event: object) => void) | null = null
	onmessage: ((event: { data: string }) => void) | null = null
	onclose: ((event: { code: number; reason: string }) => void) | null = null
	onerror: ((event: { message?: string }) => void) | null = null

	readonly url: string

	constructor(url: string) {
		this.url = url
		ScriptedSocket.instances.push(this)
	}
	send(data: string) {
		this.sent.push(JSON.parse(data) as Message)
	}
	close() {
		this.readyState = 3
		queueMicrotask(() => this.onclose?.({ code: 1000, reason: '' }))
	}
	open() {
		this.readyState = 1
		this.onopen?.({})
	}
	receive(message: unknown) {
		this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) })
	}
}

const latest = () => ScriptedSocket.instances.at(-1)!

const logger = () => ({
	logVerbose: vi.fn(),
	log: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
})

const version = (querySet: number, ts: number, identity = 0) => ({
	querySet,
	identity,
	ts: encodeTs(BigInt(ts)),
})

const create = (options: ConvexClientOptions = {}) =>
	reatomConvexClient(
		'http://127.0.0.1:3210',
		{
			webSocketConstructor: ScriptedSocket as unknown as typeof WebSocket,
			unsavedChangesWarning: false,
			...options,
		},
		'client',
	)

beforeEach(() => {
	context.reset()
	ScriptedSocket.instances = []
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

test('connects to the sync endpoint and assembles chunked transitions', async () => {
	const log = logger()
	const client = create({ logger: log })
	const entry = client.query('test:echo', { value: 'a' })
	const unsubscribe = entry.result.subscribe(() => {})
	await Promise.resolve()
	expect(latest().url).toBe('ws://127.0.0.1:3210/api/1.48.0/sync')
	latest().open()
	await Promise.resolve()
	expect(latest().sent.map(({ type }) => type)).toEqual(['Connect', 'ModifyQuerySet'])

	const transition = JSON.stringify({
		type: 'Transition',
		startVersion: version(0, 0),
		endVersion: version(1, 5),
		modifications: [
			{
				type: 'QueryUpdated',
				queryId: 0,
				value: 'a',
				logLines: ["[LOG] 'hello'", 'unparsable'],
				journal: null,
			},
		],
	})
	const parts = [transition.slice(0, 20), transition.slice(20, 60), transition.slice(60)]
	latest().receive({ type: 'Ping' })
	parts.forEach((chunk, partNumber) => {
		latest().receive({
			type: 'TransitionChunk',
			chunk,
			partNumber,
			totalParts: 3,
			transitionId: 't1',
		})
		if (partNumber < 2) expect(entry.result()).toBeUndefined()
	})
	expect(entry.result()).toEqual({ status: 'success', data: 'a' })
	expect(client.maxObservedTimestamp()).toBe(5n)
	expect(log.log).toHaveBeenCalledWith(
		'%c[CONVEX Q(test:echo)] [LOG]',
		'color:rgb(0, 145, 255)',
		"'hello'",
	)
	expect(log.error).toHaveBeenCalledWith('[CONVEX Q(test:echo)] Could not parse console.log')

	expect(() =>
		latest().receive({
			type: 'TransitionChunk',
			chunk: '{',
			partNumber: 1,
			totalParts: 2,
			transitionId: 't2',
		}),
	).toThrow('TransitionChunk received out of order')
	expect(() =>
		latest().receive({
			type: 'TransitionChunk',
			chunk: '{',
			partNumber: 2,
			totalParts: 2,
			transitionId: 't3',
		}),
	).toThrow('Invalid TransitionChunk')
	unsubscribe()
	await client.close()
})

test('rejects a transition from an unexpected version and stops on a fatal error', async () => {
	const log = logger()
	const client = create({ logger: log })
	const unsubscribe = client.connectionState.subscribe(() => {})
	await Promise.resolve()
	latest().open()
	expect(() =>
		latest().receive({
			type: 'Transition',
			startVersion: version(3, 0),
			endVersion: version(4, 1),
			modifications: [],
		}),
	).toThrow('Invalid start version')
	expect(() => latest().receive({ type: 'FatalError', error: 'boom' })).toThrow(
		'[CONVEX FATAL ERROR] boom',
	)
	expect(log.error).toHaveBeenCalledWith('[CONVEX FATAL ERROR] boom')
	expect(client.socket.state().state).toBe('terminated')
	unsubscribe()
})

test('backs off after a server error and reconnects after inactivity', async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	const onServerDisconnectError = vi.fn()
	const log = logger()
	const client = create({ logger: log, onServerDisconnectError })
	const unsubscribe = client.connectionState.subscribe(() => {})
	await Promise.resolve()
	latest().open()
	latest().onerror?.({ message: 'broken pipe' })
	expect(log.log).toHaveBeenCalledWith('WebSocket error message: broken pipe')
	latest().onclose?.({ code: 1011, reason: 'TooManyConcurrentRequests' })
	expect(onServerDisconnectError).toHaveBeenCalledWith(
		'WebSocket closed with code 1011: TooManyConcurrentRequests',
	)
	expect(client.connectionState().isWebSocketConnected).toBe(false)
	expect(client.connectionState().connectionRetries).toBe(1)

	// The first backoff for an overloaded server is 3s ± 50%.
	vi.advanceTimersByTime(1400)
	expect(ScriptedSocket.instances).toHaveLength(1)
	vi.advanceTimersByTime(3200)
	expect(ScriptedSocket.instances).toHaveLength(2)
	latest().open()
	expect(latest().sent[0]).toMatchObject({
		type: 'Connect',
		connectionCount: 1,
		lastCloseReason: 'TooManyConcurrentRequests',
	})

	// No frame for a minute counts as a dead connection.
	vi.advanceTimersByTime(60_000)
	vi.advanceTimersByTime(1000)
	expect(ScriptedSocket.instances).toHaveLength(3)
	latest().open()
	expect(latest().sent[0]).toMatchObject({ lastCloseReason: 'InactiveServer' })
	unsubscribe()
	const closed = client.close()
	await vi.runAllTimersAsync()
	await closed
})

test('reconnects at once when the browser comes back online and warns about unsent changes', async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	vi.stubGlobal('window', new EventTarget())
	const client = create({ logger: false, unsavedChangesWarning: true })
	const unsubscribe = client.connectionState.subscribe(() => {})
	await Promise.resolve()
	latest().open()
	void client.mutation('test:add', { text: 'x' })
	const leaving = new Event('beforeunload', { cancelable: true })
	window.dispatchEvent(leaving)
	expect(leaving.defaultPrevented).toBe(true)

	latest().onclose?.({ code: 1006, reason: '' })
	expect(ScriptedSocket.instances).toHaveLength(1)
	window.dispatchEvent(new Event('online'))
	expect(ScriptedSocket.instances).toHaveLength(2)
	latest().open()
	expect(latest().sent.map(({ type }) => type)).toEqual([
		'Connect',
		'ModifyQuerySet',
		'Mutation',
		'Event',
	])
	unsubscribe()
	const closed = client.close()
	await vi.runAllTimersAsync()
	await closed
})

test('stops resending a token the server keeps rejecting', async () => {
	const log = logger()
	const client = create({ logger: log })
	const onChange = vi.fn()
	let issued = 0
	const token = () => `e30.${btoa(JSON.stringify({ iat: 1, exp: 4_000_000_000, n: ++issued }))}.sig`
	client.setAuth(async () => token(), onChange)
	await vi.waitFor(() => expect(ScriptedSocket.instances).toHaveLength(1))
	latest().open()
	await vi.waitFor(() =>
		expect(latest().sent.some(({ type }) => type === 'Authenticate')).toBe(true),
	)

	// The server rejects the cached token, then every fresh one.
	const reject = (baseVersion: number) =>
		latest().receive({ type: 'AuthError', error: 'bad', baseVersion, authUpdateAttempted: true })
	reject(0)
	for (let attempt = 0; attempt < 3; attempt++) {
		await vi.waitFor(() => expect(client.socket.state().state).toBe('connecting'))
		latest().open()
		reject(0)
	}
	await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(false))
	expect(log.error).toHaveBeenCalledWith(
		'Failed to authenticate: "bad", check your server auth config',
	)
	expect(client.auth().state).toBe('noAuth')
	await client.close()
})
