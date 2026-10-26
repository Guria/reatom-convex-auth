// The websocket half of the client: connect, reconnect with backoff, pause for
// auth, server inactivity, chunked transitions. Same state machine as
// convex/src/browser/sync/web_socket_manager.ts.
import { atom, context, peek, wrap, type Frame } from '@reatom/core'

import {
	parseServerMessage,
	type ClientMessage,
	type Logger,
	type ServerMessage,
	type Transition,
	type TransitionChunk,
} from './protocol'

export type SocketState =
	| { state: 'disconnected' }
	| { state: 'connecting'; paused: 'yes' | 'no' }
	| { state: 'ready'; paused: 'yes' | 'no' | 'uninitialized' }
	| { state: 'stopped' }
	| { state: 'terminated' }

export type ReconnectMetadata = {
	connectionCount: number
	lastCloseReason: string | null
	clientTs: number
}

type SocketCallbacks = {
	onOpen(metadata: ReconnectMetadata): void
	onResume(): void
	/** Returns whether the client has synced past the last reconnect. */
	onMessage(message: ServerMessage): boolean
	onServerDisconnectError?: ((message: string) => void) | undefined
}

// Close codes that need no log line. 4040 is retried: it can be transient during a push.
const QUIET_CLOSE_CODES = new Set([1000, 1001, 1005, 4040])
const SERVER_INACTIVITY_MS = 60_000
const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 16_000

// Server close reasons that ask for a longer first backoff.
const SERVER_BACKOFF_MS: Record<string, number> = {
	InternalServerError: 1000,
	SubscriptionsWorkerFullError: 3000,
	TooManyConcurrentRequests: 3000,
	CommitterFullError: 3000,
	AwsTooManyRequestsException: 3000,
	ExecuteFullError: 3000,
	SystemTimeoutError: 3000,
	ExpiredInQueue: 3000,
	VectorIndexesUnavailable: 1000,
	SearchIndexesUnavailable: 1000,
	TableSummariesUnavailable: 1000,
	VectorIndexTooLarge: 3000,
	SearchIndexTooLarge: 3000,
	TooManyWritesInTimePeriod: 3000,
}

const initialBackoff = (reason: string | undefined) => {
	if (reason === undefined) return INITIAL_BACKOFF_MS
	const known = Object.keys(SERVER_BACKOFF_MS).find((prefix) => reason.startsWith(prefix))
	return known ? SERVER_BACKOFF_MS[known]! : INITIAL_BACKOFF_MS
}

let firstTime: number | undefined
const monotonicMillis = () => {
	firstTime ??= Date.now()
	return Math.round(firstTime + performance.now())
}

/** Handles and buffers that belong to one context's socket. */
type SocketRuntime = {
	root: Frame
	ws: WebSocket | null
	lastCloseReason: string | null
	chunks: { parts: string[]; totalParts: number; transitionId: string } | null
	inactivity: ReturnType<typeof setTimeout> | null
	reconnect: { timeout: ReturnType<typeof setTimeout>; scheduledAt: number; backoff: number } | null
	onOnline: (() => void) | null
	recoverySavedMs: number | null
}

export const reatomConvexSocket = (
	uri: string,
	{ webSocketConstructor, logger }: { webSocketConstructor: typeof WebSocket; logger: Logger },
	callbacks: SocketCallbacks,
	name: string,
) => {
	const state = atom<SocketState>({ state: 'disconnected' }, `${name}.state`)
	const connectionCount = atom(0, `${name}.connectionCount`)
	/** Consecutive failed connections; reset once the client syncs past a reconnect. */
	const retries = atom(0, `${name}.retries`)
	const hasEverConnected = atom(false, `${name}.hasEverConnected`)
	const runtime = atom(
		(): SocketRuntime => ({
			root: context(),
			ws: null,
			lastCloseReason: 'InitialConnect',
			chunks: null,
			inactivity: null,
			reconnect: null,
			onOnline: null,
			recoverySavedMs: null,
		}),
		`${name}._runtime`,
	)
	// Websocket events and timers run outside any frame.
	const inRoot = <Params extends unknown[]>(fn: (...params: Params) => void) =>
		wrap(fn, peek(runtime).root)

	const resetInactivity = () => {
		const rt = peek(runtime)
		if (state().state === 'terminated') return
		if (rt.inactivity !== null) clearTimeout(rt.inactivity)
		rt.inactivity = setTimeout(
			inRoot(() => closeAndReconnect('InactiveServer')),
			SERVER_INACTIVITY_MS,
		)
	}

	const assembleTransition = (chunk: TransitionChunk): Transition | null => {
		const rt = peek(runtime)
		const buffer = rt.chunks
		if (
			chunk.partNumber < 0 ||
			chunk.partNumber >= chunk.totalParts ||
			chunk.totalParts === 0 ||
			(buffer &&
				(buffer.totalParts !== chunk.totalParts || buffer.transitionId !== chunk.transitionId))
		) {
			rt.chunks = null
			throw new Error('Invalid TransitionChunk')
		}
		const current = (rt.chunks = buffer ?? {
			parts: [],
			totalParts: chunk.totalParts,
			transitionId: chunk.transitionId,
		})
		if (chunk.partNumber !== current.parts.length) {
			rt.chunks = null
			throw new Error(
				`TransitionChunk received out of order: expected part ${current.parts.length}, got ${chunk.partNumber}`,
			)
		}
		current.parts.push(chunk.chunk)
		if (current.parts.length < chunk.totalParts) return null
		rt.chunks = null
		const transition = parseServerMessage(current.parts.join(''))
		if (transition.type !== 'Transition') {
			throw new Error(`Expected Transition, got ${transition.type} after assembling chunks`)
		}
		return transition
	}

	const receive = (data: string) => {
		resetInactivity()
		const rt = peek(runtime)
		let message = parseServerMessage(data)
		if (message.type === 'Ping') return
		if (message.type === 'TransitionChunk') {
			const transition = assembleTransition(message)
			if (!transition) return
			message = transition
		}
		if (rt.chunks !== null) {
			rt.chunks = null
			logger.log(`Received unexpected ${message.type} while buffering TransitionChunks`)
		}
		if (callbacks.onMessage(message)) retries.set(0)
	}

	const open = () => {
		const rt = peek(runtime)
		const current = state()
		if (current.state !== 'connecting') {
			throw new Error('onopen called with socket not in connecting state')
		}
		const paused = current.paused === 'yes' ? 'uninitialized' : 'no'
		state.set({ state: 'ready', paused })
		resetInactivity()
		if (paused === 'no') {
			hasEverConnected.set(true)
			callbacks.onOpen({
				connectionCount: connectionCount(),
				lastCloseReason: rt.lastCloseReason,
				clientTs: monotonicMillis(),
			})
		}
		if (rt.lastCloseReason !== 'InitialConnect') {
			logger.log('WebSocket reconnected after disconnect due to', rt.lastCloseReason)
		}
		connectionCount.set((count) => count + 1)
		rt.lastCloseReason = null
		if (rt.recoverySavedMs !== null) {
			const timeSavedMs = rt.recoverySavedMs
			rt.recoverySavedMs = null
			send({ type: 'Event', eventType: 'NetworkRecoveryReconnect', event: { timeSavedMs } })
		}
	}

	const closed = (event: CloseEvent) => {
		const rt = peek(runtime)
		rt.chunks = null
		if (rt.lastCloseReason === null) {
			rt.lastCloseReason = event.reason || `closed with code ${event.code}`
		}
		if (!QUIET_CLOSE_CODES.has(event.code)) {
			const message = `WebSocket closed with code ${event.code}${event.reason ? `: ${event.reason}` : ''}`
			logger.log(message)
			if (event.reason) callbacks.onServerDisconnectError?.(message)
		}
		scheduleReconnect(event.reason)
	}

	const connect = () => {
		const rt = peek(runtime)
		const current = state().state
		if (current === 'terminated') return
		if (current !== 'disconnected' && current !== 'stopped') {
			throw new Error(`Didn't start connection from disconnected state: ${current}`)
		}
		const ws = new webSocketConstructor(uri)
		rt.ws = ws
		state.set({ state: 'connecting', paused: 'no' })
		// Started before onopen, so a failed handshake times out too.
		resetInactivity()
		ws.onopen = inRoot(open)
		ws.onerror = inRoot((event: Event) => {
			rt.chunks = null
			const { message } = event as ErrorEvent
			if (message) logger.log(`WebSocket error message: ${message}`)
		})
		ws.onmessage = inRoot((event: MessageEvent<string>) => receive(event.data))
		ws.onclose = inRoot(closed)
	}

	const nextBackoff = (reason: string | undefined, client: boolean) => {
		const base = (client ? 100 : initialBackoff(reason)) * 2 ** retries()
		retries.set((count) => count + 1)
		const capped = Math.min(base, MAX_BACKOFF_MS)
		return capped + capped * (Math.random() - 0.5)
	}

	const scheduleReconnect = (reason: string | undefined, client = false) => {
		const rt = peek(runtime)
		if (rt.reconnect) clearTimeout(rt.reconnect.timeout)
		state.set({ state: 'disconnected' })
		const backoff = nextBackoff(reason, client)
		logger.log(`Attempting reconnect in ${Math.round(backoff)}ms`)
		const timeout = setTimeout(
			inRoot(() => {
				if (rt.reconnect?.timeout !== timeout) return
				rt.reconnect = null
				connect()
			}),
			backoff,
		)
		rt.reconnect = { timeout, scheduledAt: monotonicMillis(), backoff }
	}

	/** Detaches the current socket and closes it; the caller sets the next state. */
	const close = (): Promise<void> => {
		const rt = peek(runtime)
		rt.chunks = null
		const current = state().state
		const { ws } = rt
		if (!ws || (current !== 'connecting' && current !== 'ready')) return Promise.resolve()
		rt.ws = null
		ws.onmessage = null
		return new Promise((resolve) => {
			ws.onclose = () => resolve()
			if (current === 'connecting') ws.onopen = () => ws.close()
			else ws.close()
		})
	}

	const closeAndReconnect = (reason: string) => {
		const current = state().state
		if (current !== 'connecting' && current !== 'ready') return
		peek(runtime).lastCloseReason = reason
		void close()
		scheduleReconnect(undefined, true)
	}

	const listenOnline = () => {
		const rt = peek(runtime)
		if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
		if (rt.onOnline) return
		rt.onOnline = inRoot(() => tryReconnectImmediately())
		window.addEventListener('online', rt.onOnline)
	}

	const unlistenOnline = () => {
		const rt = peek(runtime)
		if (!rt.onOnline) return
		window.removeEventListener('online', rt.onOnline)
		rt.onOnline = null
	}

	const tryReconnectImmediately = () => {
		const rt = peek(runtime)
		if (state().state !== 'disconnected') return
		if (rt.reconnect) {
			const elapsed = monotonicMillis() - rt.reconnect.scheduledAt
			rt.recoverySavedMs = Math.max(0, rt.reconnect.backoff - elapsed)
			clearTimeout(rt.reconnect.timeout)
			rt.reconnect = null
		}
		logger.log('Network recovery detected, reconnecting immediately')
		connect()
	}

	/** Sends when open and not paused; returns whether the message might have been sent. */
	const send = (message: ClientMessage): boolean => {
		const current = state()
		const { ws } = peek(runtime)
		if (current.state !== 'ready' || current.paused !== 'no' || !ws) return false
		try {
			ws.send(JSON.stringify(message))
		} catch (error) {
			logger.log(`Failed to send message on WebSocket, reconnecting: ${String(error)}`)
			closeAndReconnect('FailedToSendMessage')
		}
		return true
	}

	return {
		state,
		connectionCount,
		retries,
		hasEverConnected,
		send,
		/** Opens the first socket. */
		start() {
			listenOnline()
			connect()
		},
		/** Closes the socket until `tryRestart`. */
		stop(): Promise<void> {
			if (state().state === 'terminated') return Promise.resolve()
			unlistenOnline()
			const result = close()
			state.set({ state: 'stopped' })
			return result
		},
		tryRestart() {
			if (state().state !== 'stopped') return
			listenOnline()
			connect()
		},
		pause() {
			const current = state()
			if (current.state === 'connecting' || current.state === 'ready') {
				state.set({ ...current, paused: 'yes' })
			}
		},
		resume() {
			const current = state()
			if (current.state === 'connecting') {
				state.set({ state: 'connecting', paused: 'no' })
			} else if (current.state === 'ready' && current.paused === 'uninitialized') {
				state.set({ state: 'ready', paused: 'no' })
				hasEverConnected.set(true)
				const rt = peek(runtime)
				callbacks.onOpen({
					connectionCount: connectionCount(),
					lastCloseReason: rt.lastCloseReason,
					clientTs: monotonicMillis(),
				})
			} else if (current.state === 'ready' && current.paused === 'yes') {
				state.set({ state: 'ready', paused: 'no' })
				callbacks.onResume()
			}
		},
		/** Closes the socket for good. */
		terminate(): Promise<void> {
			const rt = peek(runtime)
			if (rt.inactivity !== null) clearTimeout(rt.inactivity)
			if (rt.reconnect) clearTimeout(rt.reconnect.timeout)
			rt.reconnect = null
			unlistenOnline()
			const result = close()
			state.set({ state: 'terminated' })
			return result
		},
	}
}

export type ConvexSocket = ReturnType<typeof reatomConvexSocket>
