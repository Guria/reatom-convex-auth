// Optimistic updates over server results, as in
// convex/src/browser/sync/optimistic_updates_impl.ts. The overlay holds only
// the results updates set; everything else reads through to the server.
import type { OptimisticLocalStore } from 'convex/browser'
import type { FunctionReference } from 'convex/server'
import type { Value } from 'convex/values'

import { getFunctionName } from 'convex/server'

import { canonicalizeUdfPath, queryToken, type FunctionResult, type QueryToken } from './protocol'

export type OverlayQuery = {
	udfPath: string
	args: Record<string, Value>
	result: FunctionResult | undefined
}

export type Overlay = Map<QueryToken, OverlayQuery>

/** What the store reads under the overlay: subscribed queries and their server results. */
export type ServerResults = {
	get(token: QueryToken): FunctionResult | undefined
	all(): Iterable<OverlayQuery & { token: QueryToken }>
}

// Errors read as loading, so one failed query does not break an update.
const valueOf = (result: FunctionResult | undefined) => (result?.success ? result.value : undefined)

const parseArgs = (args: unknown): Record<string, Value> => {
	if (args === undefined) return {}
	if (typeof args !== 'object' || args === null || Array.isArray(args)) {
		throw new Error(
			`The arguments to a Convex function must be an object. Received: ${String(args)}`,
		)
	}
	return args as Record<string, Value>
}

/** A store writing into `overlay`; `modified` collects the tokens it sets. */
export const optimisticStore = (
	overlay: Overlay,
	server: ServerResults,
	modified: QueryToken[],
): OptimisticLocalStore =>
	({
		getQuery(query: FunctionReference<'query'>, ...args: unknown[]) {
			const token = queryToken(canonicalizeUdfPath(getFunctionName(query)), parseArgs(args[0]))
			const local = overlay.get(token)
			return valueOf(local ? local.result : server.get(token))
		},
		getAllQueries(query: FunctionReference<'query'>) {
			const udfPath = canonicalizeUdfPath(getFunctionName(query))
			const found: Array<{ args: Record<string, Value>; value: Value | undefined }> = []
			for (const subscribed of server.all()) {
				if (subscribed.udfPath !== udfPath || overlay.has(subscribed.token)) continue
				found.push({ args: subscribed.args, value: valueOf(subscribed.result) })
			}
			for (const local of overlay.values()) {
				if (local.udfPath === udfPath)
					found.push({ args: local.args, value: valueOf(local.result) })
			}
			return found
		},
		setQuery(query: FunctionReference<'query'>, args: unknown, value: Value | undefined) {
			const udfPath = canonicalizeUdfPath(getFunctionName(query))
			const queryArgs = parseArgs(args)
			const token = queryToken(udfPath, queryArgs)
			overlay.set(token, {
				udfPath,
				args: queryArgs,
				result: value === undefined ? undefined : { success: true, value, logLines: [] },
			})
			modified.push(token)
		},
	}) as OptimisticLocalStore
