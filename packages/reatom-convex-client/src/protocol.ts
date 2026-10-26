// Convex's websocket sync protocol as convex@1.48.0 speaks it
// (convex/src/browser/sync/protocol.ts). Timestamps travel as little-endian
// u64 in base64 and decode to bigint.
import { ConvexError, convexToJson, jsonToConvex, type JSONValue, type Value } from 'convex/values'

export type QueryId = number
export type RequestId = number
export type QueryJournal = string | null
export type QueryToken = string

export type StateVersion = { querySet: number; identity: number; ts: bigint }

export type AddQuery = {
	type: 'Add'
	queryId: QueryId
	udfPath: string
	args: JSONValue[]
	journal?: QueryJournal | undefined
}

export type QuerySetModification = {
	type: 'ModifyQuerySet'
	baseVersion: number
	newVersion: number
	modifications: Array<AddQuery | { type: 'Remove'; queryId: QueryId }>
}

export type Authenticate =
	| { type: 'Authenticate'; tokenType: 'User'; value: string; baseVersion: number }
	| { type: 'Authenticate'; tokenType: 'None'; baseVersion: number }

export type RequestMessage = {
	type: 'Mutation' | 'Action'
	requestId: RequestId
	udfPath: string
	args: JSONValue[]
}

export type ClientMessage =
	| {
			type: 'Connect'
			sessionId: string
			connectionCount: number
			lastCloseReason: string | null
			maxObservedTimestamp?: string | undefined
			clientTs: number
	  }
	| QuerySetModification
	| Authenticate
	| RequestMessage
	| { type: 'Event'; eventType: string; event: unknown }

type StateModification =
	| {
			type: 'QueryUpdated'
			queryId: QueryId
			value: JSONValue
			logLines: string[]
			journal: QueryJournal
	  }
	| {
			type: 'QueryFailed'
			queryId: QueryId
			errorMessage: string
			logLines: string[]
			errorData: JSONValue
			journal: QueryJournal
	  }
	| { type: 'QueryRemoved'; queryId: QueryId }

export type Transition = {
	type: 'Transition'
	startVersion: StateVersion
	endVersion: StateVersion
	modifications: StateModification[]
	clientClockSkew?: number
	serverTs?: number
}

type Response<Type, Success> =
	| ({
			type: Type
			requestId: RequestId
			success: true
			result: JSONValue
			logLines: string[]
	  } & Success)
	| {
			type: Type
			requestId: RequestId
			success: false
			result: string
			logLines: string[]
			errorData?: JSONValue
	  }

export type MutationResponse = Response<'MutationResponse', { ts: bigint }>
export type ActionResponse = Response<'ActionResponse', unknown>

export type AuthError = {
	type: 'AuthError'
	error: string
	baseVersion: number
	authUpdateAttempted: boolean
}

export type ServerMessage =
	| Transition
	| MutationResponse
	| ActionResponse
	| AuthError
	| { type: 'FatalError'; error: string }

export type TransitionChunk = {
	type: 'TransitionChunk'
	chunk: string
	partNumber: number
	totalParts: number
	transitionId: string
}

export type WireMessage = ServerMessage | TransitionChunk | { type: 'Ping' }

const decodeTs = (encoded: string): bigint => {
	const bytes = atob(encoded)
	let value = 0n
	for (let index = bytes.length - 1; index >= 0; index--) {
		value = (value << 8n) | BigInt(bytes.charCodeAt(index))
	}
	return value
}

export const encodeTs = (ts: bigint): string => {
	let bytes = ''
	for (let index = 0n; index < 8n; index++) {
		bytes += String.fromCharCode(Number((ts >> (8n * index)) & 0xffn))
	}
	return btoa(bytes)
}

type EncodedVersion = Omit<StateVersion, 'ts'> & { ts: string }

const decodeVersion = (version: EncodedVersion): StateVersion => ({
	...version,
	ts: decodeTs(version.ts),
})

/** Decodes the timestamps of a parsed server frame. */
export const parseServerMessage = (data: string): WireMessage => {
	const message = JSON.parse(data) as WireMessage
	if (message.type === 'Transition') {
		const encoded = message as unknown as Transition & {
			startVersion: EncodedVersion
			endVersion: EncodedVersion
		}
		return {
			...message,
			startVersion: decodeVersion(encoded.startVersion),
			endVersion: decodeVersion(encoded.endVersion),
		}
	}
	if (message.type === 'MutationResponse' && message.success) {
		return { ...message, ts: decodeTs(message.ts as unknown as string) }
	}
	return message
}

export const canonicalizeUdfPath = (udfPath: string) => {
	const pieces = udfPath.split(':')
	const functionName = pieces.length === 1 ? 'default' : pieces.pop()!
	const moduleName = pieces.join(':')
	return `${moduleName.endsWith('.js') ? moduleName.slice(0, -3) : moduleName}:${functionName}`
}

/** The client-side identity of a query: canonical path and serialized args. */
export const queryToken = (canonicalUdfPath: string, args: Record<string, Value>): QueryToken =>
	JSON.stringify({ udfPath: canonicalUdfPath, args: convexToJson(args) })

export type FunctionResult =
	| { success: true; value: Value; logLines: string[] }
	| { success: false; errorMessage: string; errorData?: Value | undefined; logLines: string[] }

export const functionResult = (
	modification:
		| { success: true; value: JSONValue; logLines: string[] }
		| { success: false; errorMessage: string; errorData?: JSONValue; logLines: string[] },
): FunctionResult =>
	modification.success
		? {
				success: true,
				value: jsonToConvex(modification.value ?? null),
				logLines: modification.logLines,
			}
		: {
				success: false,
				errorMessage: modification.errorMessage,
				errorData:
					modification.errorData === undefined ? undefined : jsonToConvex(modification.errorData),
				logLines: modification.logLines,
			}

export type UdfType = 'query' | 'mutation' | 'action'

const PREFIX = { query: 'Q', mutation: 'M', action: 'A' } as const

/** The error `convex/browser` throws for a failed function: ConvexError when it carries data. */
export const functionError = (
	type: UdfType,
	udfPath: string,
	result: Extract<FunctionResult, { success: false }>,
): Error => {
	const message = `[CONVEX ${PREFIX[type]}(${udfPath})] ${result.errorMessage}\n  Called by client`
	if (result.errorData === undefined) return new Error(message)
	const error = new ConvexError(message)
	;(error as ConvexError<Value>).data = result.errorData
	return error
}

export type Logger = {
	logVerbose(...args: unknown[]): void
	log(...args: unknown[]): void
	warn(...args: unknown[]): void
	error(...args: unknown[]): void
}

const noop = () => {}

export const createLogger = (option: Logger | boolean | undefined, verbose: boolean): Logger => {
	if (typeof option === 'object') return option
	if (option === false) return { logVerbose: noop, log: noop, warn: noop, error: noop }
	return {
		logVerbose: verbose ? (...args) => console.debug(new Date().toISOString(), ...args) : noop,
		log: (...args) => console.log(...args),
		warn: (...args) => console.warn(...args),
		error: (...args) => console.error(...args),
	}
}

/** Prints a function's `console.*` lines the way `convex/browser` does. */
export const logFunctionLines = (
	logger: Logger,
	type: UdfType,
	udfPath: string,
	logLines: string[],
) => {
	for (const line of logLines) {
		const match = /^\[.*?\] /.exec(line)
		if (!match) {
			logger.error(`[CONVEX ${PREFIX[type]}(${udfPath})] Could not parse console.log`)
			continue
		}
		const level = line.slice(1, match[0].length - 2)
		logger.log(
			`%c[CONVEX ${PREFIX[type]}(${udfPath})] [${level}]`,
			'color:rgb(0, 145, 255)',
			line.slice(match[0].length),
		)
	}
}
