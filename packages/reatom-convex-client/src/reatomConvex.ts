import type { AuthTokenFetcher, OptimisticUpdate } from 'convex/browser'
// Types only: the binding has no React runtime dependency.
import type { ReatomConvexClient } from './client'
import type {
	PaginatedQueryArgs,
	PaginatedQueryItem,
	PaginatedQueryReference,
	Preloaded,
} from 'convex/react'
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server'

import { action, atom, computed, withAsync, wrap } from '@reatom/core'
import { getFunctionName, makeFunctionReference } from 'convex/server'
import { convexToJson, jsonToConvex, type Value } from 'convex/values'

import { reatomPaginatedPages, type PaginatedState } from './paginated'

type QueryState<T> =
	| { status: 'skipped' }
	| { status: 'loading' }
	| { status: 'success'; data: T }
	| { status: 'error'; error: Error }

const SKIPPED = { status: 'skipped' } as const
const LOADING = { status: 'loading' } as const

/**
 * The `reatom-convex` API over a client whose state already lives in atoms.
 * `client` is read lazily, so a test frame can set its own before anything
 * subscribes.
 */
export const reatomConvex = (createClient: () => ReatomConvexClient, name: string) => {
	const client = atom(createClient, `${name}.client`)

	/**
	 * Server side of Convex's two-phase auth: `null` until the backend answers
	 * for the current auth state, then whether it accepted the token.
	 */
	const serverAuthenticated = atom<boolean | null>(null, `${name}.serverAuthenticated`)

	/** The server rejected an expired token and the client is fetching a new one. */
	const isRefreshingAuth = atom(false, `${name}.isRefreshingAuth`)

	const connectionState = computed(() => client().connectionState(), `${name}.connectionState`)

	// The client calls back from its own root frame, so these need no `wrap`.
	const setAuth = action((fetchToken: AuthTokenFetcher) => {
		serverAuthenticated.set(null)
		isRefreshingAuth.set(false)
		client().setAuth(
			fetchToken,
			(isAuthenticated) => serverAuthenticated.set(isAuthenticated),
			(isRefreshing) => isRefreshingAuth.set(isRefreshing),
		)
	}, `${name}.setAuth`)

	const clearAuth = action(() => {
		client().clearAuth()
		serverAuthenticated.set(false)
		isRefreshingAuth.set(false)
	}, `${name}.clearAuth`)

	/**
	 * Subscribed while something reads it; `'skip'` args hold no subscription.
	 * Errors land in `.error()` instead of throwing. `initialData` shows until
	 * the first result.
	 */
	const query = <Query extends FunctionReference<'query'>>(
		ref: Query,
		args: () => FunctionArgs<Query> | 'skip',
		queryName: string,
		{ initialData }: { initialData?: FunctionReturnType<Query> } = {},
	) => {
		type Data = FunctionReturnType<Query>
		const udfPath = getFunctionName(ref)
		const initial: QueryState<Data> | undefined =
			initialData === undefined ? undefined : { status: 'success', data: initialData }
		// Equal args resolve to the same client entry, so the subscription stays.
		const entry = computed(() => {
			const next = args()
			return next === 'skip' ? null : client().query(udfPath, next as Record<string, Value>)
		}, `${queryName}.entry`)
		const state = computed((previous?: QueryState<Data>): QueryState<Data> => {
			const current = entry()
			if (!current) return SKIPPED
			const result = current.result()
			if (result) return result as QueryState<Data>
			return initial && (previous === undefined || previous === initial) ? initial : LOADING
		}, `${queryName}.state`)
		return {
			status: computed(() => state().status, `${queryName}.status`),
			data: computed(() => {
				const current = state()
				return current.status === 'success' ? current.data : undefined
			}, `${queryName}.data`),
			error: computed(() => {
				const current = state()
				return current.status === 'error' ? current.error : undefined
			}, `${queryName}.error`),
			isLoading: computed(() => state().status === 'loading', `${queryName}.isLoading`),
		}
	}

	/** A live query seeded with a server-rendered `preloadQuery` payload. */
	const preloadedQuery = <Query extends FunctionReference<'query'>>(
		preloaded: Preloaded<Query>,
		queryName: string,
	) => {
		const args = jsonToConvex(preloaded._argsJSON) as FunctionArgs<Query>
		return query(makeFunctionReference<'query'>(preloaded._name) as Query, () => args, queryName, {
			initialData: jsonToConvex(preloaded._valueJSON) as FunctionReturnType<Query>,
		})
	}

	/** Reactive pagination: loaded pages stay live and keep their boundaries. */
	const paginatedQuery = <Query extends PaginatedQueryReference>(
		ref: Query,
		args: () => PaginatedQueryArgs<Query> | 'skip',
		{ initialNumItems }: { initialNumItems: number },
		queryName: string,
	) => {
		type Item = PaginatedQueryItem<Query>
		// A new page list only when the client or the serialized args change.
		const source = computed(
			(
				previous?: { client: ReatomConvexClient; args: Record<string, Value>; key: string } | null,
			) => {
				const next = args()
				if (next === 'skip') return null
				const current = client()
				const key = JSON.stringify(convexToJson(next as Value))
				if (previous?.client === current && previous.key === key) return previous
				return { client: current, args: next as Record<string, Value>, key }
			},
			`${queryName}.source`,
		)
		const { state, loadMore } = reatomPaginatedPages<Item>(
			getFunctionName(ref),
			source,
			initialNumItems,
			queryName,
		)
		return {
			results: computed(() => state().results, `${queryName}.results`),
			status: computed(() => state().status, `${queryName}.status`),
			error: computed(() => state().error, `${queryName}.error`),
			isLoading: computed(() => {
				const { status, error } = state() as PaginatedState<Item>
				return !error && (status === 'LoadingFirstPage' || status === 'LoadingMore')
			}, `${queryName}.isLoading`),
			loadMore,
		}
	}

	/** `optimisticUpdate` edits the client's local query results until the server answers. */
	const mutation = <Mutation extends FunctionReference<'mutation'>>(
		ref: Mutation,
		mutationName: string,
		{ optimisticUpdate }: { optimisticUpdate?: OptimisticUpdate<FunctionArgs<Mutation>> } = {},
	) =>
		action(
			async (args: FunctionArgs<Mutation>): Promise<FunctionReturnType<Mutation>> =>
				await wrap(
					client().mutation(getFunctionName(ref), args, {
						optimisticUpdate: optimisticUpdate as OptimisticUpdate<never> | undefined,
					}),
				),
			mutationName,
		).extend(withAsync())

	const convexAction = <Action extends FunctionReference<'action'>>(
		ref: Action,
		actionName: string,
	) =>
		action(
			async (args: FunctionArgs<Action>): Promise<FunctionReturnType<Action>> =>
				await wrap(client().action(getFunctionName(ref), args)),
			actionName,
		).extend(withAsync())

	return {
		client,
		serverAuthenticated,
		isRefreshingAuth,
		connectionState,
		setAuth,
		clearAuth,
		query,
		preloadedQuery,
		paginatedQuery,
		mutation,
		action: convexAction,
	}
}
