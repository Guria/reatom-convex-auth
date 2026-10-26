// A Convex sync client in Reatom: the protocol of convex/browser's
// BaseConvexClient (convex/src/browser/sync/client.ts and local_state.ts,
// remote_query_set.ts, request_manager.ts) with its state in atoms.
//
// The query set is the set of connected query atoms: reading a query's
// `result` in a subscribed graph subscribes it on the server, losing the last
// reader unsubscribes it. Plain maps index the atoms by token and query id.
import type { AuthTokenFetcher, ConnectionState, OptimisticUpdate } from 'convex/browser'

import { atom, computed, context, noop, peek, wrap, type AtomLike, type Frame } from '@reatom/core'
import { version } from 'convex'
import { convexToJson, type Value } from 'convex/values'

import { reatomConvexAuth, type AuthSync } from './auth'
import { optimisticStore, type Overlay, type ServerResults } from './optimistic'
import {
	canonicalizeUdfPath,
	createLogger,
	encodeTs,
	functionError,
	functionResult,
	logFunctionLines,
	queryToken,
	type AddQuery,
	type Authenticate,
	type FunctionResult,
	type Logger,
	type MutationResponse,
	type ActionResponse,
	type QueryId,
	type QueryJournal,
	type QueryToken,
	type RequestId,
	type RequestMessage,
	type ServerMessage,
	type StateVersion,
	type Transition,
} from './protocol'
import { reatomConvexSocket, type ReconnectMetadata } from './socket'
import { withConnectionHooks } from './withConnectionHooks'

export type ConvexClientOptions = {
	/** Defaults to the global `WebSocket`. */
	webSocketConstructor?: typeof WebSocket
	/** Prompt before leaving the page while requests are unconfirmed. Default `true` in browsers. */
	unsavedChangesWarning?: boolean
	verbose?: boolean
	/** A logger, or `false` for none. Defaults to the console. */
	logger?: Logger | boolean
	skipConvexDeploymentUrlCheck?: boolean
	/** Refetch a token this many seconds before it expires. Default 10. */
	authRefreshTokenLeewaySeconds?: number
	/** Hold queries and requests until the first token is sent. */
	expectAuth?: boolean
	/** Keep the initial cached token instead of fetching a fresh one at once. */
	initialAuthTokenReuse?: boolean
	onServerDisconnectError?: (message: string) => void
	/**
	 * Send the query set changes made in one microtask as one message. Default
	 * `true`; `false` sends one message per change, as `convex/browser` does.
	 */
	batchQuerySet?: boolean
}

export type QueryResult = { status: 'success'; data: Value } | { status: 'error'; error: Error }

export type QueryEntry = {
	readonly token: QueryToken
	readonly udfPath: string
	readonly args: Record<string, Value>
	/**
	 * The result with optimistic updates applied, `undefined` while loading.
	 * Subscribed on the server while connected.
	 */
	readonly result: AtomLike<QueryResult | undefined, []>
}

type Entry = QueryEntry & {
	readonly result: AtomLike<QueryResult | undefined, []> & {
		set(value: QueryResult | undefined): QueryResult | undefined
	}
	id: QueryId | null
	/** A query set change not yet sent. */
	op: 'Add' | 'Remove' | null
	server: FunctionResult | undefined
	/** The raw result behind `result`. */
	visible: FunctionResult | undefined
	journal: QueryJournal | undefined
}

type Request = {
	message: RequestMessage
	status: 'NotSent' | 'Requested' | 'Completed'
	requestedAt: number
	resolve: (result: FunctionResult) => void
	result?: FunctionResult
	ts?: bigint
}

type OptimisticUpdateAndId = {
	requestId: RequestId
	update: (store: Parameters<OptimisticUpdate<never>>[0]) => void
}

/** Handles and indexes that belong to one context's client. */
type ClientRuntime = {
	root: Frame
	started: boolean
	closed: boolean
	sessionId: string
	/** Live entries by token; an entry nothing references gets collected. */
	entries: Map<QueryToken, WeakRef<Entry>>
	collected: FinalizationRegistry<QueryToken>
	/** Entries the server knows or is about to learn about. */
	byId: Map<QueryId, Entry>
	nextQueryId: number
	pending: Map<QueryId, Entry>
	flushScheduled: boolean
	flush: () => void
	/** Paused for an auth token: query set and identity changes wait. */
	paused: boolean
	/** Queries re-sent on reconnect the server has not answered yet. */
	outstanding: Set<QueryId>
	outstandingAuth: boolean
	overlay: Overlay
	nextRequestId: number
	requestsOlderThanRestart: Set<RequestId>
	onBeforeUnload: ((event: BeforeUnloadEvent) => void) | null
}

const INITIAL_VERSION: StateVersion = { querySet: 0, identity: 0, ts: 0n }

const sessionId = () =>
	'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
		const random = (Math.random() * 16) | 0
		return (char === 'x' ? random : (random & 0x3) | 0x8).toString(16)
	})

const toQueryResult = (
	udfPath: string,
	raw: FunctionResult | undefined,
): QueryResult | undefined => {
	if (raw === undefined) return undefined
	if (raw.success) return { status: 'success', data: raw.value }
	return { status: 'error', error: functionError('query', udfPath, raw) }
}

const validateDeploymentUrl = (url: string) => {
	if (!url.startsWith('http:') && !url.startsWith('https:')) {
		throw new Error(
			`Invalid deployment address: Must start with "https://" or "http://". Found "${url}".`,
		)
	}
	if (!URL.canParse(url)) {
		throw new Error(`Invalid deployment address: "${url}" is not a valid URL.`)
	}
	if (url.endsWith('.convex.site')) {
		throw new Error(
			`Invalid deployment address: "${url}" ends with .convex.site, which is used for HTTP Actions.`,
		)
	}
}

const socketUri = (url: string) => {
	const match = /^(https?):\/\/(.*)$/.exec(url)
	if (!match) throw new Error(`Unknown parent protocol in ${url}`)
	return `${match[1] === 'http' ? 'ws' : 'wss'}://${match[2]}/api/${version}/sync`
}

/**
 * A Convex client for `url` whose state lives in atoms, per context. The
 * socket opens on the first subscription, request, auth change or
 * connection state subscriber.
 */
export const reatomConvexClient = (
	url: string,
	options: ConvexClientOptions = {},
	name = 'convexClient',
) => {
	if (!options.skipConvexDeploymentUrlCheck) validateDeploymentUrl(url)
	const webSocketConstructor = options.webSocketConstructor ?? globalThis.WebSocket
	if (!webSocketConstructor) throw new Error('No WebSocket global variable defined!')
	const logger = createLogger(options.logger, options.verbose ?? false)
	const batchQuerySet = options.batchQuerySet ?? true

	const querySetVersion = atom(0, `${name}.querySetVersion`)
	const identityVersion = atom(0, `${name}.identityVersion`)
	/** Version of the query results received on this connection. */
	const remoteVersion = atom(INITIAL_VERSION, `${name}.remoteVersion`)
	const maxObservedTimestamp = atom<bigint | undefined>(undefined, `${name}.maxObservedTimestamp`)
	const authToken = atom<string | undefined>(undefined, `${name}.authToken`)
	const requests = atom<ReadonlyMap<RequestId, Request>>(new Map(), `${name}.requests`)
	const optimisticUpdates = atom<readonly OptimisticUpdateAndId[]>([], `${name}.optimisticUpdates`)

	const runtime = atom((): ClientRuntime => {
		const entries = new Map<QueryToken, WeakRef<Entry>>()
		const root = context()
		return {
			root,
			started: false,
			closed: false,
			sessionId: sessionId(),
			entries,
			collected: new FinalizationRegistry((token) => {
				if (!entries.get(token)?.deref()) entries.delete(token)
			}),
			byId: new Map(),
			nextQueryId: 0,
			pending: new Map(),
			flushScheduled: false,
			flush: wrap(() => flush(), root),
			paused: false,
			outstanding: new Set(),
			outstandingAuth: false,
			overlay: new Map(),
			nextRequestId: 0,
			requestsOlderThanRestart: new Set(),
			onBeforeUnload: null,
		}
	}, `${name}._runtime`)

	const lookup = (token: QueryToken) => peek(runtime).entries.get(token)?.deref()

	const setVisible = (entry: Entry, raw: FunctionResult | undefined) => {
		if (entry.visible === raw) return
		entry.visible = raw
		entry.result.set(toQueryResult(entry.udfPath, raw))
	}

	const serverResults: ServerResults = {
		get(token) {
			const entry = lookup(token)
			return entry?.id === null ? undefined : entry?.server
		},
		*all() {
			for (const entry of peek(runtime).byId.values()) {
				if (entry.server === undefined) continue
				yield { token: entry.token, udfPath: entry.udfPath, args: entry.args, result: entry.server }
			}
		},
	}

	/** Shows the server results of `changed` under the optimistic updates still pending. */
	const ingest = (changed: Entry[], completed: Set<RequestId>) => {
		const rt = peek(runtime)
		let updates = optimisticUpdates()
		if (completed.size > 0 && updates.length > 0) {
			updates = optimisticUpdates.set(updates.filter(({ requestId }) => !completed.has(requestId)))
		}
		if (updates.length === 0 && rt.overlay.size === 0) {
			for (const entry of changed) setVisible(entry, entry.server)
			return
		}
		const previous = rt.overlay
		const overlay: Overlay = (rt.overlay = new Map())
		const store = optimisticStore(overlay, serverResults, [])
		for (const { update } of updates) update(store)
		const tokens = new Set([...previous.keys(), ...overlay.keys()])
		for (const entry of changed) tokens.add(entry.token)
		for (const token of tokens) {
			const entry = lookup(token)
			const local = overlay.get(token)
			if (entry) setVisible(entry, local ? local.result : entry.server)
		}
	}

	const applyOptimisticUpdate = (update: OptimisticUpdateAndId['update'], requestId: RequestId) => {
		optimisticUpdates.set((list) => [...list, { requestId, update }])
		const { overlay } = peek(runtime)
		const modified: QueryToken[] = []
		update(optimisticStore(overlay, serverResults, modified))
		for (const token of modified) {
			const entry = lookup(token)
			if (entry) setVisible(entry, overlay.get(token)!.result)
		}
	}

	// Query set

	const addOf = (entry: Entry): AddQuery => ({
		type: 'Add',
		queryId: entry.id!,
		udfPath: entry.udfPath,
		args: [convexToJson(entry.args)],
		journal: entry.journal,
	})

	const finalizeRemove = (entry: Entry) => {
		const rt = peek(runtime)
		rt.byId.delete(entry.id!)
		rt.outstanding.delete(entry.id!)
		entry.id = null
		entry.server = undefined
		entry.journal = undefined
		setVisible(entry, rt.overlay.get(entry.token)?.result)
	}

	const takePending = () => {
		const rt = peek(runtime)
		const modifications: Array<AddQuery | { type: 'Remove'; queryId: QueryId }> = []
		for (const entry of rt.pending.values()) {
			if (entry.op === 'Add') {
				modifications.push(addOf(entry))
			} else {
				modifications.push({ type: 'Remove', queryId: entry.id! })
				finalizeRemove(entry)
			}
			entry.op = null
		}
		rt.pending.clear()
		return modifications
	}

	const flush = () => {
		const rt = peek(runtime)
		rt.flushScheduled = false
		if (rt.pending.size === 0 || rt.paused) return
		const baseVersion = querySetVersion()
		const modifications = takePending()
		querySetVersion.set(baseVersion + 1)
		socket.send({ type: 'ModifyQuerySet', baseVersion, newVersion: baseVersion + 1, modifications })
	}

	const scheduleFlush = () => {
		const rt = peek(runtime)
		if (!batchQuerySet) return flush()
		if (rt.flushScheduled) return
		rt.flushScheduled = true
		queueMicrotask(rt.flush)
	}

	const connectEntry = (entry: Entry) => {
		start()
		const rt = peek(runtime)
		if (rt.closed) return
		// Reconnected before its removal went out: the server still has it.
		if (entry.op === 'Remove') {
			entry.op = null
			rt.pending.delete(entry.id!)
			return
		}
		const id = rt.nextQueryId++
		entry.id = id
		entry.op = 'Add'
		rt.byId.set(id, entry)
		rt.pending.set(id, entry)
		scheduleFlush()
	}

	const disconnectEntry = (entry: Entry) => {
		const rt = peek(runtime)
		if (entry.id === null) return
		// Never sent: forget it.
		if (entry.op === 'Add') {
			rt.pending.delete(entry.id)
			rt.byId.delete(entry.id)
			entry.id = null
			entry.op = null
			return
		}
		entry.op = 'Remove'
		rt.pending.set(entry.id, entry)
		scheduleFlush()
	}

	/** The entry for a query, created on first use; read its `result` to subscribe. */
	const query = (udfPath: string, args: Record<string, Value> = {}): QueryEntry => {
		const canonical = canonicalizeUdfPath(udfPath)
		const token = queryToken(canonical, args)
		const existing = lookup(token)
		if (existing) return existing
		const rt = peek(runtime)
		const visible = rt.overlay.get(token)?.result
		const result = atom(toQueryResult(canonical, visible), `${name}.query#${canonical}`)
		const entry: Entry = {
			token,
			udfPath: canonical,
			args,
			result,
			id: null,
			op: null,
			server: undefined,
			visible,
			journal: undefined,
		}
		result.extend(
			withConnectionHooks(
				() => connectEntry(entry),
				() => disconnectEntry(entry),
			),
		)
		rt.entries.set(token, new WeakRef(entry))
		rt.collected.register(entry, token)
		return entry
	}

	// Identity

	const clearToken = (): Authenticate => {
		const rt = peek(runtime)
		authToken.set(undefined)
		rt.outstandingAuth = false
		const baseVersion = identityVersion()
		if (!rt.paused) identityVersion.set(baseVersion + 1)
		return { type: 'Authenticate', tokenType: 'None', baseVersion }
	}

	const sync: AuthSync = {
		isCurrentOrNewerAuthVersion: (identity) => identity >= identityVersion(),
		markAuthCompletion: () => void (peek(runtime).outstandingAuth = false),
		token: () => authToken(),
		authenticate(value) {
			authToken.set(value)
			const baseVersion = identityVersion()
			if (!peek(runtime).paused) identityVersion.set(baseVersion + 1)
			socket.send({ type: 'Authenticate', tokenType: 'User', value, baseVersion })
		},
		dropToken: () => void clearToken(),
		clearAuth: () => void socket.send(clearToken()),
		stopSocket: () => socket.stop(),
		tryRestartSocket: () => socket.tryRestart(),
		pauseSocket() {
			socket.pause()
			peek(runtime).paused = true
		},
		resumeSocket: () => socket.resume(),
	}

	// Requests

	const updateRequests = (update: (requests: Map<RequestId, Request>) => void) =>
		requests.set((current) => {
			const next = new Map(current)
			update(next)
			return next
		})

	const request = (message: RequestMessage) => {
		const sent = socket.send(message)
		return new Promise<FunctionResult>((resolve) =>
			updateRequests((all) =>
				all.set(message.requestId, {
					message,
					status: sent ? 'Requested' : 'NotSent',
					requestedAt: Date.now(),
					resolve,
				}),
			),
		)
	}

	/** Returns the request id when the request is done and its optimistic update can go. */
	const onResponse = (response: MutationResponse | ActionResponse): RequestId | null => {
		const rt = peek(runtime)
		const { requestId } = response
		const current = requests().get(requestId)
		// Unknown, or re-answered after a reconnect.
		if (!current || current.status === 'Completed') return null
		const type = current.message.type === 'Mutation' ? 'mutation' : 'action'
		logFunctionLines(logger, type, current.message.udfPath, response.logLines)
		const result = response.success
			? functionResult({ success: true, value: response.result, logLines: response.logLines })
			: functionResult({
					success: false,
					errorMessage: response.result,
					...(response.errorData === undefined ? {} : { errorData: response.errorData }),
					logLines: response.logLines,
				})
		if (!response.success) {
			logger.error(
				`[CONVEX ${type === 'mutation' ? 'M' : 'A'}(${current.message.udfPath})] ${response.result}`,
			)
		}
		// Failed mutations change nothing; actions are not ordered with queries.
		if (response.type === 'ActionResponse' || !response.success) {
			current.resolve(result)
			updateRequests((all) => all.delete(requestId))
			rt.requestsOlderThanRestart.delete(requestId)
			return requestId
		}
		// Resolves once a transition reaches its timestamp, so the caller reads its own write.
		updateRequests((all) =>
			all.set(requestId, { ...current, status: 'Completed', result, ts: response.ts }),
		)
		return null
	}

	const removeCompleted = (ts: bigint) => {
		const rt = peek(runtime)
		const done = new Set<RequestId>()
		for (const [requestId, current] of requests()) {
			if (current.status !== 'Completed' || current.ts! > ts) continue
			current.resolve(current.result!)
			done.add(requestId)
			rt.requestsOlderThanRestart.delete(requestId)
		}
		if (done.size > 0) updateRequests((all) => done.forEach((requestId) => all.delete(requestId)))
		return done
	}

	/** Mutations are idempotent and resent; in-flight actions fail. */
	const restartRequests = () => {
		const rt = peek(runtime)
		rt.requestsOlderThanRestart = new Set(requests().keys())
		const messages: RequestMessage[] = []
		const lost: Request[] = []
		updateRequests((all) => {
			for (const [requestId, current] of all) {
				if (current.status === 'NotSent') {
					all.set(requestId, { ...current, status: 'Requested' })
					messages.push(current.message)
				} else if (current.message.type === 'Mutation') {
					messages.push(current.message)
				} else {
					all.delete(requestId)
					rt.requestsOlderThanRestart.delete(requestId)
					lost.push(current)
				}
			}
		})
		for (const { resolve } of lost) {
			resolve({
				success: false,
				errorMessage: 'Connection lost while action was in flight',
				logLines: [],
			})
		}
		return messages
	}

	const resumeRequests = () => {
		const messages: RequestMessage[] = []
		updateRequests((all) => {
			for (const [requestId, current] of all) {
				if (current.status !== 'NotSent') continue
				all.set(requestId, { ...current, status: 'Requested' })
				messages.push(current.message)
			}
		})
		return messages
	}

	// Socket

	const observe = (ts: bigint) => {
		const max = maxObservedTimestamp()
		if (max === undefined || max <= ts) maxObservedTimestamp.set(ts)
	}

	const onOpen = (metadata: ReconnectMetadata) => {
		const rt = peek(runtime)
		const max = maxObservedTimestamp()
		socket.send({
			type: 'Connect',
			sessionId: rt.sessionId,
			...metadata,
			maxObservedTimestamp: max === undefined ? undefined : encodeTs(max),
		})
		// A new connection starts from an empty query set and no identity.
		remoteVersion.set(INITIAL_VERSION)
		rt.paused = false
		for (const entry of rt.pending.values()) {
			if (entry.op === 'Remove') finalizeRemove(entry)
			entry.op = null
		}
		rt.pending.clear()
		rt.outstanding = new Set(rt.byId.keys())
		const modifications = [...rt.byId.values()].map(addOf)
		querySetVersion.set(1)
		const value = authToken()
		if (value === undefined) {
			identityVersion.set(0)
		} else {
			rt.outstandingAuth = true
			identityVersion.set(1)
			socket.send({ type: 'Authenticate', tokenType: 'User', value, baseVersion: 0 })
		}
		socket.send({ type: 'ModifyQuerySet', baseVersion: 0, newVersion: 1, modifications })
		for (const message of restartRequests()) socket.send(message)
	}

	const onResume = () => {
		const rt = peek(runtime)
		let querySet: Parameters<typeof socket.send>[0] | undefined
		if (rt.pending.size > 0) {
			const baseVersion = querySetVersion()
			querySet = {
				type: 'ModifyQuerySet',
				baseVersion,
				newVersion: baseVersion + 1,
				modifications: takePending(),
			}
			querySetVersion.set(baseVersion + 1)
		}
		const value = authToken()
		rt.paused = false
		if (value !== undefined) {
			const baseVersion = identityVersion()
			identityVersion.set(baseVersion + 1)
			socket.send({ type: 'Authenticate', tokenType: 'User', value, baseVersion })
		}
		if (querySet) socket.send(querySet)
		for (const message of resumeRequests()) socket.send(message)
	}

	const onTransition = (message: Transition) => {
		const rt = peek(runtime)
		const { startVersion: start, endVersion: end } = message
		observe(end.ts)
		auth.onTransition(message)
		const current = remoteVersion()
		if (
			current.querySet !== start.querySet ||
			current.ts !== start.ts ||
			current.identity !== start.identity
		) {
			throw new Error(
				`Invalid start version: ${start.ts}:${start.querySet}:${start.identity}, transitioning from ${current.ts}:${current.querySet}:${current.identity}`,
			)
		}
		const changed: Entry[] = []
		for (const modification of message.modifications) {
			rt.outstanding.delete(modification.queryId)
			// Results for queries already unsubscribed are dropped.
			const entry = rt.byId.get(modification.queryId)
			if (!entry) continue
			if (modification.type === 'QueryRemoved') {
				entry.server = undefined
			} else {
				const { logLines, journal } = modification
				logFunctionLines(logger, 'query', entry.udfPath, logLines)
				entry.server =
					modification.type === 'QueryUpdated'
						? functionResult({ success: true, value: modification.value, logLines })
						: functionResult({
								success: false,
								errorMessage: modification.errorMessage,
								errorData: modification.errorData,
								logLines,
							})
				if (journal !== undefined) entry.journal = journal
			}
			changed.push(entry)
		}
		remoteVersion.set(end)
		ingest(changed, removeCompleted(end.ts))
	}

	const onMessage = (message: ServerMessage) => {
		switch (message.type) {
			case 'Transition':
				onTransition(message)
				break
			case 'MutationResponse': {
				if (message.success) observe(message.ts)
				const done = onResponse(message)
				if (done !== null) ingest([], new Set([done]))
				break
			}
			case 'ActionResponse':
				onResponse(message)
				break
			case 'AuthError':
				auth.onAuthError(message)
				break
			case 'FatalError': {
				const error = new Error(`[CONVEX FATAL ERROR] ${message.error}`)
				logger.error(error.message)
				void socket.terminate()
				throw error
			}
		}
		const rt = peek(runtime)
		return (
			rt.requestsOlderThanRestart.size === 0 && rt.outstanding.size === 0 && !rt.outstandingAuth
		)
	}

	const socket = reatomConvexSocket(
		socketUri(url),
		{ webSocketConstructor, logger },
		{ onOpen, onResume, onMessage, onServerDisconnectError: options.onServerDisconnectError },
		`${name}.socket`,
	)

	const auth = reatomConvexAuth(
		sync,
		{
			logger,
			refreshTokenLeewaySeconds: options.authRefreshTokenLeewaySeconds ?? 10,
			initialAuthTokenReuse: options.initialAuthTokenReuse ?? false,
		},
		`${name}.auth`,
	)

	const start = () => {
		const rt = peek(runtime)
		if (rt.started || rt.closed) return
		rt.started = true
		if (
			options.unsavedChangesWarning !== false &&
			typeof window !== 'undefined' &&
			typeof window.addEventListener === 'function'
		) {
			rt.onBeforeUnload = wrap((event: BeforeUnloadEvent) => {
				if (![...requests().values()].some(({ status }) => status === 'Requested')) return
				event.preventDefault()
				event.returnValue = 'Are you sure you want to leave? Your changes may not be saved.'
			}, rt.root)
			window.addEventListener('beforeunload', rt.onBeforeUnload)
		}
		socket.start()
		if (options.expectAuth) sync.pauseSocket()
	}

	const connectionState = computed((): ConnectionState => {
		const pending = requests()
		let oldest = Number.POSITIVE_INFINITY
		let inflightMutations = 0
		for (const current of pending.values()) {
			if (current.message.type === 'Mutation') inflightMutations++
			if (current.status !== 'Completed') oldest = Math.min(oldest, current.requestedAt)
		}
		return {
			hasInflightRequests: pending.size > 0,
			isWebSocketConnected: socket.state().state === 'ready',
			timeOfOldestInflightRequest:
				pending.size === 0 ? null : new Date(Number.isFinite(oldest) ? oldest : Date.now()),
			hasEverConnected: socket.hasEverConnected(),
			connectionCount: socket.connectionCount(),
			connectionRetries: socket.retries(),
			inflightMutations,
			inflightActions: pending.size - inflightMutations,
		}
	}, `${name}.connectionState`).extend(withConnectionHooks(() => start(), noop))

	return {
		name,
		url,
		connectionState,
		socket,
		auth: auth.state,
		querySetVersion,
		identityVersion,
		remoteVersion,
		maxObservedTimestamp,
		authToken,
		requests,
		optimisticUpdates,
		query,
		/** A result held locally, with optimistic updates applied; throws a failed query's error. */
		localQueryResult(udfPath: string, args: Record<string, Value> = {}): Value | undefined {
			const token = queryToken(canonicalizeUdfPath(udfPath), args)
			const raw = lookup(token)?.visible ?? peek(runtime).overlay.get(token)?.result
			const result = toQueryResult(canonicalizeUdfPath(udfPath), raw)
			if (result?.status === 'error') throw result.error
			return result?.data
		},
		async mutation(
			udfPath: string,
			args: Record<string, Value> = {},
			mutationOptions: { optimisticUpdate?: OptimisticUpdate<never> | undefined } = {},
		): Promise<Value> {
			start()
			const rt = peek(runtime)
			const requestId = rt.nextRequestId++
			const { optimisticUpdate } = mutationOptions
			if (optimisticUpdate) {
				applyOptimisticUpdate((store) => {
					const returned: unknown = optimisticUpdate(store, args as never)
					if (returned instanceof Promise) {
						logger.warn(
							'Optimistic update handler returned a Promise. Optimistic updates should be synchronous.',
						)
					}
				}, requestId)
			}
			const result = await request({
				type: 'Mutation',
				requestId,
				udfPath,
				args: [convexToJson(args)],
			})
			if (!result.success) throw functionError('mutation', udfPath, result)
			return result.value
		},
		async action(udfPath: string, args: Record<string, Value> = {}): Promise<Value> {
			start()
			const requestId = peek(runtime).nextRequestId++
			const result = await request({
				type: 'Action',
				requestId,
				udfPath,
				args: [convexToJson(args)],
			})
			if (!result.success) throw functionError('action', udfPath, result)
			return result.value
		},
		/**
		 * Fetches a token, sends it, and refetches it before it expires or when
		 * the server rejects it. The flow runs in the context's root frame, so
		 * aborting the caller does not stop it.
		 */
		setAuth(
			fetchToken: AuthTokenFetcher,
			onChange: (isAuthenticated: boolean) => void,
			onRefreshChange?: (isRefreshing: boolean) => void,
		) {
			start()
			wrap(() => void auth.setConfig(fetchToken, onChange, onRefreshChange), peek(runtime).root)()
		},
		/** Drops the token and any scheduled refetch. */
		clearAuth() {
			start()
			auth.stop()
			sync.clearAuth()
		},
		/** Closes the socket for good and stops auth. */
		close(): Promise<void> {
			const rt = peek(runtime)
			rt.closed = true
			auth.stop()
			if (rt.onBeforeUnload) window.removeEventListener('beforeunload', rt.onBeforeUnload)
			return socket.terminate()
		},
	}
}

export type ReatomConvexClient = ReturnType<typeof reatomConvexClient>
