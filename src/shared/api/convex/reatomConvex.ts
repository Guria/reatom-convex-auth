import type {
	AuthTokenFetcher,
	BaseConvexClient,
	ConnectionState,
	ConvexClient,
	OptimisticUpdate,
	PaginationStatus,
} from 'convex/browser'
// Types only: the binding has no React runtime dependency.
import type {
	PaginatedQueryArgs,
	PaginatedQueryItem,
	PaginatedQueryReference,
	Preloaded,
} from 'convex/react'
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server'

import {
	action,
	atom,
	computed,
	effect,
	noop,
	withAsync,
	withConnectHook,
	wrap,
	type Atom,
} from '@reatom/core'
import { getFunctionName, makeFunctionReference } from 'convex/server'
import { convexToJson, jsonToConvex, type Value } from 'convex/values'

type QueryState<T> =
	| { status: 'skipped' }
	| { status: 'loading' }
	| { status: 'success'; data: T }
	| { status: 'error'; error: Error }

type PaginatedState<Item> = {
	status: PaginationStatus | 'Skipped'
	results: Item[]
	error?: Error
	loadMore: (numItems: number) => boolean
}

// What `onPaginatedUpdate_experimental` delivers; its declared callback type
// is the server's page shape instead.
type PaginatedQueryResult<Item> = Pick<PaginatedState<Item>, 'results' | 'loadMore'> & {
	status: PaginationStatus
}

type Unsubscribe<T> = { (): void; getCurrentValue(): T | undefined }

type Subscribe<Args, T> = (
	client: ConvexClient,
	args: Args,
	onResult: (result: T) => void,
	onError: (error: Error) => void,
) => Unsubscribe<T>

type Listeners = Map<string, Set<() => void>>
const listenersByClient = new WeakMap<BaseConvexClient, Listeners>()

// One transition handler per client dispatching by query token, as
// ConvexReactClient does. `ConvexClient.onUpdate` checks every listener on
// every transition instead: quadratic in the number of subscriptions.
const listenersOf = (base: BaseConvexClient) => {
	let listeners = listenersByClient.get(base)
	if (!listeners) {
		const created: Listeners = new Map()
		base.addOnTransitionHandler(({ queries }) => {
			for (const { token } of queries) created.get(token)?.forEach((listener) => listener())
		})
		listenersByClient.set(base, created)
		listeners = created
	}
	return listeners
}

const watchQuery = <Query extends FunctionReference<'query'>>(
	client: ConvexClient,
	ref: Query,
	args: FunctionArgs<Query>,
	onResult: (result: FunctionReturnType<Query>) => void,
	onError: (error: Error) => void,
): Unsubscribe<FunctionReturnType<Query>> => {
	const base = client.client
	const name = getFunctionName(ref)
	const { queryToken, unsubscribe } = base.subscribe(name, args)
	const getCurrentValue = () =>
		base.localQueryResult(name, args) as FunctionReturnType<Query> | undefined
	const listener = () => {
		let result: FunctionReturnType<Query> | undefined
		try {
			result = getCurrentValue()
		} catch (error) {
			return onError(error as Error)
		}
		// A removed result reads as undefined.
		if (result !== undefined) onResult(result)
	}
	const listeners = listenersOf(base)
	const tokenListeners = listeners.get(queryToken) ?? new Set()
	listeners.set(queryToken, tokenListeners.add(listener))
	const stop = () => {
		if (!tokenListeners.delete(listener)) return
		if (tokenListeners.size === 0 && listeners.get(queryToken) === tokenListeners)
			listeners.delete(queryToken)
		unsubscribe()
	}
	return Object.assign(stop, { getCurrentValue })
}

// Convex's own args identity: `useQuery` compares the same serialization.
const argsKey = (args: object) => JSON.stringify(convexToJson(args as Value))

/**
 * Keeps one Convex subscription per distinct `args()` while `target` is
 * connected. Args that serialize the same keep the subscription, and a result
 * the client already holds (another subscriber, or optimistic) shows at once.
 */
const withSubscription = <Args extends object, T>(
	client: Atom<ConvexClient>,
	args: () => Args | 'skip',
	subscribe: Subscribe<Args, T>,
	handlers: {
		skipped: () => void
		pending: () => void
		result: (result: T) => void
		error: (error: Error) => void
	},
	name: string,
) => {
	// A computed rather than an effect: subscribing is synchronous and needs no
	// abort scope, which costs an AbortController per subscription.
	const source = computed(() => {
		const nextArgs = args()
		const key = nextArgs === 'skip' ? 'skip' : argsKey(nextArgs)
		return { client: client(), args: nextArgs, key }
	}, `${name}.source`)
	return withConnectHook(() => {
		let current: { client: ConvexClient; key: string; unsubscribe: () => void } | null = null
		const unsubscribeSource = source.subscribe(({ client: nextClient, args: nextArgs, key }) => {
			if (current?.client === nextClient && current.key === key) return
			current?.unsubscribe()
			if (nextArgs === 'skip') {
				current = { client: nextClient, key, unsubscribe: noop }
				handlers.skipped()
				return
			}
			// Convex calls these from its websocket handlers, outside any frame.
			const unsubscribe = subscribe(
				nextClient,
				nextArgs,
				wrap(handlers.result),
				wrap(handlers.error),
			)
			current = { client: nextClient, key, unsubscribe }
			let cached: T | undefined
			try {
				cached = unsubscribe.getCurrentValue()
			} catch (error) {
				return handlers.error(error as Error)
			}
			if (cached === undefined) handlers.pending()
			else handlers.result(cached)
		})
		// Convex subscriptions live outside Reatom's graph: drop them on disconnect.
		return () => {
			unsubscribeSource()
			current?.unsubscribe()
			current = null
		}
	})
}

/**
 * Reatom binding for a Convex deployment. `client` is read lazily, so a test
 * frame can set its own before anything subscribes.
 */
export const reatomConvex = (createClient: () => ConvexClient, name: string) => {
	const client = atom(createClient, `${name}.client`)

	/**
	 * Server side of Convex's two-phase auth: `null` until the backend answers
	 * for the current auth state, then whether it accepted the token.
	 */
	const serverAuthenticated = atom<boolean | null>(null, `${name}.serverAuthenticated`)

	/** The server rejected an expired token and the client is fetching a new one. */
	const isRefreshingAuth = atom(false, `${name}.isRefreshingAuth`)

	const connectionState = atom(() => client().connectionState(), `${name}.connectionState`).extend(
		withConnectHook((target) => {
			let unsubscribe = noop
			const sync = effect(() => {
				unsubscribe()
				const current = client()
				target.set(current.connectionState())
				unsubscribe = current.subscribeToConnectionState(
					wrap((state: ConnectionState) => target.set(state)),
				)
			}, `${name}.connectionState.sync`)
			return () => {
				sync.unsubscribe()
				unsubscribe()
			}
		}),
	)

	// `ConvexClient.setAuth` drops the refresh callback; the base client takes it.
	const setAuth = action((fetchToken: AuthTokenFetcher) => {
		serverAuthenticated.set(null)
		isRefreshingAuth.set(false)
		client().client.setAuth(
			wrap(fetchToken),
			wrap((isAuthenticated: boolean) => serverAuthenticated.set(isAuthenticated)),
			wrap((isRefreshing: boolean) => isRefreshingAuth.set(isRefreshing)),
		)
	}, `${name}.setAuth`)

	const clearAuth = action(() => {
		client().client.clearAuth()
		serverAuthenticated.set(false)
		isRefreshingAuth.set(false)
	}, `${name}.clearAuth`)

	/**
	 * Subscribes while connected; `'skip'` args hold no subscription. Errors
	 * land in `.error()` instead of throwing: a subscription can outlive the
	 * session that started it. `initialData` shows until the first result.
	 */
	const query = <Query extends FunctionReference<'query'>>(
		ref: Query,
		args: () => FunctionArgs<Query> | 'skip',
		queryName: string,
		{ initialData }: { initialData?: FunctionReturnType<Query> } = {},
	) => {
		type Data = FunctionReturnType<Query>
		let received = false
		const state = atom<QueryState<Data>>(
			initialData === undefined ? { status: 'loading' } : { status: 'success', data: initialData },
			`${queryName}.state`,
		)
		state.extend(
			withSubscription<FunctionArgs<Query>, Data>(
				client,
				args,
				(current, nextArgs, onResult, onError) =>
					watchQuery(current, ref, nextArgs, onResult, onError),
				{
					skipped: () => state.set({ status: 'skipped' }),
					pending: () => {
						if (received || initialData === undefined) state.set({ status: 'loading' })
					},
					result: (data) => {
						received = true
						const previous = state()
						// The client re-delivers a cached result to new listeners.
						if (previous.status === 'success' && previous.data === data) return
						state.set({ status: 'success', data })
					},
					error: (error) => {
						received = true
						state.set({ status: 'error', error })
					},
				},
				queryName,
			),
		)
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

	/**
	 * Convex's reactive pagination (the core client's paginated query set, as
	 * in `usePaginatedQuery_experimental`): loaded pages stay live and keep
	 * their boundaries as items are added.
	 */
	const paginatedQuery = <Query extends PaginatedQueryReference>(
		ref: Query,
		args: () => PaginatedQueryArgs<Query> | 'skip',
		{ initialNumItems }: { initialNumItems: number },
		queryName: string,
	) => {
		type Item = PaginatedQueryItem<Query>
		const empty = (status: PaginatedState<Item>['status']): PaginatedState<Item> => ({
			status,
			results: [],
			loadMore: () => false,
		})
		const state = atom(empty('LoadingFirstPage'), `${queryName}.state`)
		state.extend(
			withSubscription<PaginatedQueryArgs<Query>, PaginatedQueryResult<Item>>(
				client,
				args,
				(current, nextArgs, onResult, onError) =>
					current.onPaginatedUpdate_experimental(
						ref,
						nextArgs as unknown as FunctionArgs<Query>,
						{ initialNumItems },
						onResult as never,
						onError,
					) as unknown as Unsubscribe<PaginatedQueryResult<Item>>,
				{
					skipped: () => state.set(empty('Skipped')),
					pending: () => state.set(empty('LoadingFirstPage')),
					result: ({ results, status, loadMore }) => state.set({ results, status, loadMore }),
					error: (error) => state.set({ ...empty('LoadingFirstPage'), error }),
				},
				queryName,
			),
		)
		return {
			results: computed(() => state().results, `${queryName}.results`),
			status: computed(() => state().status, `${queryName}.status`),
			error: computed(() => state().error, `${queryName}.error`),
			isLoading: computed(() => {
				const { status, error } = state()
				return !error && (status === 'LoadingFirstPage' || status === 'LoadingMore')
			}, `${queryName}.isLoading`),
			/** Returns whether a page load started. */
			loadMore: action((numItems: number) => state().loadMore(numItems), `${queryName}.loadMore`),
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
				await wrap(client().mutation(ref, args, { optimisticUpdate })),
			mutationName,
		).extend(withAsync())

	const convexAction = <Action extends FunctionReference<'action'>>(
		ref: Action,
		actionName: string,
	) =>
		action(
			async (args: FunctionArgs<Action>): Promise<FunctionReturnType<Action>> =>
				await wrap(client().action(ref, args)),
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
