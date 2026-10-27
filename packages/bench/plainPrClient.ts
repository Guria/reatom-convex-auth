import type { AuthTokenFetcher, BaseConvexClientOptions, MutationOptions } from 'convex/browser'
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server'

import { ConvexClient } from 'convex-artifact-batched/browser'
import { getFunctionName } from 'convex/server'

import { callbackApi, subscriptionScope } from './plainStore'

/** Same consumer contract as the native facade, dispatching by query token on PR #211. */
export function createPlainPrClient(url: string, options: BaseConvexClientOptions = {}) {
	const client = new ConvexClient(url, options)
	const base = client.client
	const scope = subscriptionScope()
	const listeners = new Map<string, Set<() => void>>()
	const detach = base.addOnTransitionHandler(({ queries }) => {
		for (const { token } of queries) for (const listener of listeners.get(token) ?? []) listener()
	})
	let connectionState = client.connectionState()
	const connection = scope.store(
		() => connectionState,
		(notify) =>
			client.subscribeToConnectionState((next) => {
				connectionState = next
				notify()
			}),
	)
	// Keep the snapshot current and referentially stable even before a UI subscribes.
	connection.subscribe(() => {})
	let authenticated: boolean | null = false
	const authListeners = new Set<() => void>()
	const auth = scope.store(
		() => authenticated,
		(notify) => {
			authListeners.add(notify)
			return () => {
				authListeners.delete(notify)
			}
		},
	)

	let closePromise: Promise<void> | undefined
	const query = <Query extends FunctionReference<'query'>>(
		ref: Query,
		args: FunctionArgs<Query>,
	) => {
		scope.assertOpen()
		const path = getFunctionName(ref)
		const read = (): FunctionReturnType<Query> | undefined =>
			base.localQueryResult(path, args) as FunctionReturnType<Query> | undefined
		return scope.store(read, (notify) => {
			const subscription = base.subscribe(path, args)
			const set = listeners.get(subscription.queryToken) ?? new Set()
			listeners.set(subscription.queryToken, set)
			const listener = () => notify()
			set.add(listener)
			notify()
			return () => {
				set.delete(listener)
				if (!set.size) listeners.delete(subscription.queryToken)
				subscription.unsubscribe()
			}
		})
	}
	return {
		query,
		connection,
		auth,
		setAuth(fetch: AuthTokenFetcher, onChange?: (authenticated: boolean) => void) {
			scope.assertOpen()
			authenticated = null
			for (const listener of authListeners) listener()
			base.setAuth(fetch, (value) => {
				authenticated = value
				for (const listener of authListeners) listener()
				onChange?.(value)
			})
		},
		...callbackApi(query),
		paginatedQuery<Query extends FunctionReference<'query'>>(
			ref: Query,
			args: Omit<FunctionArgs<Query>, 'paginationOpts'>,
			initialNumItems: number,
		) {
			let results:
				| {
						results: Array<
							FunctionReturnType<Query> extends { page: Array<infer Item> } ? Item : never
						>
						loadMore: (n: number) => void
				  }
				| undefined
			return {
				...scope.store(
					() => results?.results ?? EMPTY,
					(notify) => {
						const stop = client.onPaginatedUpdate_experimental(
							ref,
							args as FunctionArgs<Query>,
							{ initialNumItems },
							(result) => {
								results = result as unknown as NonNullable<typeof results>
								notify()
							},
						)
						return stop
					},
				),
				loadMore: (n: number) => {
					results?.loadMore(n)
				},
			}
		},
		mutation<Mutation extends FunctionReference<'mutation'>>(
			ref: Mutation,
			args: FunctionArgs<Mutation>,
			mutationOptions?: MutationOptions,
		): Promise<FunctionReturnType<Mutation>> {
			return base.mutation(getFunctionName(ref), args, mutationOptions) as Promise<
				FunctionReturnType<Mutation>
			>
		},
		action: <Action extends FunctionReference<'action'>>(ref: Action, args: FunctionArgs<Action>) =>
			base.action(getFunctionName(ref), args),
		close() {
			if (!closePromise) {
				detach()
				scope.close()
				closePromise = client.close()
			}
			return closePromise
		},
	}
}
const EMPTY: never[] = []
