// An in-process Convex deployment speaking Convex's websocket sync protocol
// (convex/dist/esm-types/browser/sync/protocol.d.ts). Pass `server.WebSocket`
// as `webSocketConstructor` and the real `ConvexClient` / `ConvexReactClient`
// run unmodified: query set versions, auth confirmation and refresh,
// optimistic updates, pagination, reconnects.
import { ConvexError, convexToJson, jsonToConvex, type JSONValue, type Value } from 'convex/values'

export type FakeIdentity = { subject: string } & Record<string, unknown>

export type FakeFunctionContext = {
	identity: FakeIdentity | null
	/** Per-subscription scratch space, e.g. a page's pinned end cursor. */
	memo: Record<string, unknown>
}

type FakeFunction = (ctx: FakeFunctionContext, args: Record<string, Value>) => unknown

export type FakeConvexServerOptions = {
	/** Query-set responses per client message, or one response after the queued burst. */
	queryResponses?: 'per-message' | 'coalesced'
	queries?: Record<string, FakeFunction>
	mutations?: Record<string, FakeFunction>
	actions?: Record<string, FakeFunction>
	/** Identity for a user JWT, or the reason the server rejects it. */
	authenticate?: (token: string) => FakeIdentity | string
}

type Version = { querySet: number; identity: number; ts: number }

type Subscription = {
	udfPath: string
	args: Record<string, Value>
	memo: Record<string, unknown>
	/** Last result sent, to send only changes. */
	sent?: string
}

type SocketEnd = {
	readyState: number
	deliver(data: string): void
	closed(code: number, reason: string): void
}

type Connection = {
	socket: SocketEnd
	queries: Map<number, Subscription>
	identity: FakeIdentity | null
	querySetVersion: number
	identityVersion: number
	sentVersion: Version
}

type ClientMessage = { type: string } & Record<string, unknown>
type EventHandler = ((event: never) => void) | null

// Timestamps travel as little-endian u64 in base64.
const encodeTs = (ts: number) => {
	const bytes = new Uint8Array(8)
	let rest = ts
	for (let index = 0; index < 8; index++) {
		bytes[index] = rest % 256
		rest = Math.floor(rest / 256)
	}
	return btoa(String.fromCharCode(...bytes))
}

const encodeVersion = (version: Version) => ({ ...version, ts: encodeTs(version.ts) })

// Convex marks its errors with a global symbol, so a ConvexError thrown from
// another copy of the package still counts.
const isConvexError = (error: unknown): error is ConvexError<Value> =>
	error instanceof Error && Symbol.for('ConvexError') in error

const failure = (error: unknown) => ({
	message: error instanceof Error ? error.message : String(error),
	errorData: isConvexError(error) ? convexToJson(error.data) : null,
})

const base64url = (value: unknown) =>
	btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * An unsigned JWT. The client reads `iat`/`exp` to schedule token refetches;
 * a lifetime under 10s (the client's leeway) triggers an immediate refetch.
 */
let jwtCount = 0
export const fakeJwt = (claims: Record<string, unknown>, lifetimeSeconds = 3600) => {
	const iat = Math.floor(Date.now() / 1000)
	// The client only re-authenticates with a token that differs from the last.
	const payload = { iat, exp: iat + lifetimeSeconds, jti: String(++jwtCount), ...claims }
	return `${base64url({ alg: 'none' })}.${base64url(payload)}.fake`
}

export const readFakeJwt = (token: string): Record<string, unknown> => {
	const payload = token.split('.')[1] ?? ''
	return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>
}

/** `paginate()`'s page: Convex's `PaginationResult`. */
type Page<T> = { page: T[]; isDone: boolean; continueCursor: string }

/**
 * Cursor pagination over `items` with ids. Like the real backend, a page
 * pins its end once loaded, so items inserted later grow the page instead of
 * shifting later pages.
 */
export function paginate<T extends { _id: string }>(
	ctx: FakeFunctionContext,
	items: T[],
	options: Value,
): Page<T> {
	const { numItems, cursor } = options as { numItems: number; cursor: string | null }
	const start = cursor === null ? 0 : items.findIndex((item) => item._id === cursor) + 1
	const pinned = ctx.memo['endCursor']
	const pinnedEnd = typeof pinned === 'string' ? items.findIndex((item) => item._id === pinned) : -1
	const end = pinnedEnd >= 0 ? pinnedEnd + 1 : start + numItems
	const page = items.slice(start, end)
	const isDone = end >= items.length
	const continueCursor = page.at(-1)?._id ?? cursor ?? ''
	if (!isDone) ctx.memo['endCursor'] = continueCursor
	return { page, isDone, continueCursor }
}

export function createFakeConvexServer(options: FakeConvexServerOptions) {
	const { queries = {}, mutations = {}, actions = {}, authenticate } = options
	const connections = new Set<Connection>()
	let ts = 1
	let online = true
	let queryTransitions = 0
	const traffic = {
		clientMessages: 0,
		querySetMessages: 0,
		adds: 0,
		removes: 0,
		serverMessages: 0,
		evaluations: 0,
	}
	// Connection attempts made offline hang, as in a network partition.
	const pendingOpens = new Set<() => void>()

	// One FIFO of macrotasks, like frames on a socket: message order holds and
	// every delivery lands on a later task.
	const tasks: Array<() => void> = []
	const channel = new MessageChannel()
	channel.port1.onmessage = () => tasks.shift()?.()
	;(channel.port1 as { unref?: () => void }).unref?.()
	const later = (task: () => void) => {
		tasks.push(task)
		channel.port2.postMessage(null)
	}

	const send = (connection: Connection, message: Record<string, unknown>) => {
		if (message['type'] === 'Transition') queryTransitions++
		traffic.serverMessages++
		const data = JSON.stringify(message)
		later(() => connection.socket.deliver(data))
	}

	const evaluate = (connection: Connection, subscription: Subscription) => {
		traffic.evaluations++
		const handler = queries[subscription.udfPath]
		const ctx = { identity: connection.identity, memo: subscription.memo }
		try {
			if (!handler) throw new Error(`Fake server has no query ${subscription.udfPath}`)
			const value = convexToJson((handler(ctx, subscription.args) ?? null) as Value)
			return { sent: JSON.stringify(value), modification: { type: 'QueryUpdated', value } }
		} catch (error) {
			const { message, errorData } = failure(error)
			return {
				sent: `error:${message}`,
				modification: { type: 'QueryFailed', errorMessage: message, errorData },
			}
		}
	}

	/** Re-runs subscribed queries and sends the changes in one transition. */
	const transition = (
		connection: Connection,
		{
			force = false,
			only,
			removed = [],
		}: { force?: boolean; only?: Set<number>; removed?: number[] } = {},
	) => {
		const modifications: Array<Record<string, unknown>> = removed.map((queryId) => ({
			type: 'QueryRemoved',
			queryId,
		}))
		for (const [queryId, subscription] of connection.queries) {
			if (only && !only.has(queryId)) continue
			const { sent, modification } = evaluate(connection, subscription)
			if (sent === subscription.sent) continue
			subscription.sent = sent
			modifications.push({ ...modification, queryId, logLines: [], journal: null })
		}
		const version = {
			querySet: connection.querySetVersion,
			identity: connection.identityVersion,
			ts,
		}
		const { sentVersion } = connection
		const versionChanged =
			version.querySet !== sentVersion.querySet ||
			version.identity !== sentVersion.identity ||
			version.ts !== sentVersion.ts
		if (!force && !versionChanged && modifications.length === 0) return
		send(connection, {
			type: 'Transition',
			startVersion: encodeVersion(sentVersion),
			endVersion: encodeVersion(version),
			modifications,
		})
		connection.sentVersion = version
	}

	const broadcast = () => connections.forEach((connection) => transition(connection))

	const pendingTransitions = new Map<Connection, number[]>()
	const respondToQuerySet = (connection: Connection, added: Set<number>, removed: number[]) => {
		if (options.queryResponses !== 'coalesced') {
			transition(connection, { force: true, only: added, removed })
			return
		}
		const pending = pendingTransitions.get(connection)
		if (pending) {
			pending.push(...removed)
			return
		}
		pendingTransitions.set(connection, removed)
		later(() => {
			pendingTransitions.delete(connection)
			if (connections.has(connection)) transition(connection, { force: true, removed })
		})
	}

	const modifyQuerySet = (connection: Connection, message: ClientMessage) => {
		const added = new Set<number>()
		const removed: number[] = []
		for (const modification of message['modifications'] as ClientMessage[]) {
			const queryId = modification['queryId'] as number
			if (modification.type === 'Add') {
				const [args] = modification['args'] as JSONValue[]
				connection.queries.set(queryId, {
					udfPath: modification['udfPath'] as string,
					args: jsonToConvex(args ?? {}) as Record<string, Value>,
					memo: {},
				})
				added.add(queryId)
			} else {
				connection.queries.delete(queryId)
				removed.push(queryId)
			}
		}
		connection.querySetVersion = message['newVersion'] as number
		respondToQuerySet(connection, added, removed)
	}

	const authenticateConnection = (connection: Connection, message: ClientMessage) => {
		const baseVersion = message['baseVersion'] as number
		if (message['tokenType'] === 'User') {
			const result = authenticate?.(message['value'] as string) ?? 'Authentication is not set up'
			if (typeof result === 'string') {
				send(connection, {
					type: 'AuthError',
					error: result,
					baseVersion,
					authUpdateAttempted: true,
				})
				return
			}
			connection.identity = result
		} else {
			connection.identity = null
		}
		connection.identityVersion = baseVersion + 1
		transition(connection, { force: true })
	}

	const runMutation = (connection: Connection, message: ClientMessage) => {
		const requestId = message['requestId']
		const udfPath = message['udfPath'] as string
		const [args] = message['args'] as JSONValue[]
		const handler = mutations[udfPath]
		try {
			if (!handler) throw new Error(`Fake server has no mutation ${udfPath}`)
			const result = handler(
				{ identity: connection.identity, memo: {} },
				jsonToConvex(args ?? {}) as Record<string, Value>,
			)
			ts += 1
			send(connection, {
				type: 'MutationResponse',
				requestId,
				success: true,
				result: convexToJson((result ?? null) as Value),
				ts: encodeTs(ts),
				logLines: [],
			})
			broadcast()
		} catch (error) {
			const { message: text, errorData } = failure(error)
			send(connection, {
				type: 'MutationResponse',
				requestId,
				success: false,
				result: text,
				errorData,
				logLines: [],
			})
		}
	}

	const runAction = async (connection: Connection, message: ClientMessage) => {
		const requestId = message['requestId']
		const udfPath = message['udfPath'] as string
		const [args] = message['args'] as JSONValue[]
		const handler = actions[udfPath]
		try {
			if (!handler) throw new Error(`Fake server has no action ${udfPath}`)
			const result = await handler(
				{ identity: connection.identity, memo: {} },
				jsonToConvex(args ?? {}) as Record<string, Value>,
			)
			send(connection, {
				type: 'ActionResponse',
				requestId,
				success: true,
				result: convexToJson((result ?? null) as Value),
				logLines: [],
			})
		} catch (error) {
			const { message: text, errorData } = failure(error)
			send(connection, {
				type: 'ActionResponse',
				requestId,
				success: false,
				result: text,
				errorData,
				logLines: [],
			})
		}
	}

	const receive = (connection: Connection, message: ClientMessage) => {
		traffic.clientMessages++
		if (message.type === 'ModifyQuerySet') {
			traffic.querySetMessages++
			for (const edit of message['modifications'] as ClientMessage[]) {
				if (edit.type === 'Add') traffic.adds++
				else traffic.removes++
			}
		}
		switch (message.type) {
			case 'ModifyQuerySet':
				return modifyQuerySet(connection, message)
			case 'Authenticate':
				return authenticateConnection(connection, message)
			case 'Mutation':
				return runMutation(connection, message)
			case 'Action':
				return void runAction(connection, message)
			default:
				// Connect and Event need no answer.
				return undefined
		}
	}

	class FakeSocket {
		static readonly CONNECTING = 0
		static readonly OPEN = 1
		static readonly CLOSING = 2
		static readonly CLOSED = 3
		readyState = FakeSocket.CONNECTING
		onopen: EventHandler = null
		onmessage: EventHandler = null
		onclose: EventHandler = null
		onerror: EventHandler = null
		readonly connection: Connection

		constructor(_url: string) {
			this.connection = {
				socket: this,
				queries: new Map(),
				identity: null,
				querySetVersion: 0,
				identityVersion: 0,
				sentVersion: { querySet: 0, identity: 0, ts: 0 },
			}
			const open = () => {
				if (this.readyState !== FakeSocket.CONNECTING) return
				if (!online) return void pendingOpens.add(open)
				this.readyState = FakeSocket.OPEN
				connections.add(this.connection)
				this.onopen?.({} as never)
			}
			later(open)
		}

		send(data: string) {
			if (this.readyState !== FakeSocket.OPEN) return
			const message = JSON.parse(data) as ClientMessage
			later(() => {
				if (this.readyState === FakeSocket.OPEN) receive(this.connection, message)
			})
		}

		close(code = 1000, reason = '') {
			if (this.readyState >= FakeSocket.CLOSING) return
			this.readyState = FakeSocket.CLOSING
			connections.delete(this.connection)
			later(() => this.closed(code, reason))
		}

		deliver(data: string) {
			if (this.readyState === FakeSocket.OPEN) this.onmessage?.({ data } as never)
		}

		closed(code: number, reason: string) {
			this.readyState = FakeSocket.CLOSED
			connections.delete(this.connection)
			this.onclose?.({ code, reason, wasClean: code === 1000 } as never)
		}
	}

	return {
		/** Pass as `webSocketConstructor`. */
		WebSocket: FakeSocket as unknown as typeof WebSocket,
		/** Pushes results of queries whose data changed outside a mutation. */
		invalidate: () => {
			ts += 1
			broadcast()
		},
		/** Server-side token expiry: the client refetches a token and re-authenticates. */
		expireAuth: () =>
			connections.forEach((connection) => {
				if (!connection.identity) return
				send(connection, {
					type: 'AuthError',
					error: 'Token expired',
					baseVersion: connection.identityVersion - 1,
					authUpdateAttempted: false,
				})
			}),
		/** Offline drops every socket; new ones connect once back online. */
		setOnline(next: boolean) {
			online = next
			if (next) {
				pendingOpens.forEach(later)
				pendingOpens.clear()
				return
			}
			connections.forEach((connection) => {
				connection.socket.readyState = FakeSocket.CLOSING
				later(() => connection.socket.closed(1006, 'Fake network drop'))
			})
			connections.clear()
		},
		/** Connection attempts waiting for the server to come back online. */
		pendingConnections: () => pendingOpens.size,
		/** Cumulative wire traffic and query evaluations. Returns a snapshot. */
		traffic: () => ({ ...traffic, transitions: queryTransitions }),
		/** Number of transitions scheduled for delivery. */
		transitionCount: () => queryTransitions,
		/** Server-side subscriptions to `udfPath` across connections. */
		subscriptionCount: (udfPath: string) =>
			[...connections].reduce(
				(count, connection) =>
					count +
					[...connection.queries.values()].filter((query) => query.udfPath === udfPath).length,
				0,
			),
		/** Resolves once every queued delivery so far has run. */
		settled: () => new Promise<void>((resolve) => later(resolve)),
		close() {
			connections.clear()
			channel.port1.close()
		},
	}
}

export type FakeConvexServer = ReturnType<typeof createFakeConvexServer>
