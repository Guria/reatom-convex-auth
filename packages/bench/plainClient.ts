import type { ExternalStore } from './plainStore'
import type {
	AuthTokenFetcher,
	BaseConvexClientOptions,
	MutationOptions,
	PaginationStatus,
} from 'convex/browser'
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server'

import { context } from '@reatom/core'
import { reatomConvexClient } from 'convex-artifact-atoms/browser'

import { callbackApi, subscriptionScope } from './plainStore'

/** This is a new API over the native public atoms, not the SDK compatibility clients. */
export function createPlainNativeClient(url: string, options: BaseConvexClientOptions = {}) {
	const frame = context.start()
	const native = reatomConvexClient(url, options)
	const scope = subscriptionScope()
	const connection = scope.store(
		() => frame.run(native.connectionState),
		(notify) => frame.run(() => native.connectionState.subscribe(() => notify())),
	)
	// Like the SDK constructor, this facade opens immediately rather than on the first query.
	const disconnect = connection.subscribe(() => {})
	const auth = scope.store(
		() => frame.run(native.isAuthenticated),
		(notify) => frame.run(() => native.isAuthenticated.subscribe(() => notify())),
	)
	const refreshing = scope.store(
		() => frame.run(native.isRefreshingAuth),
		(notify) => frame.run(() => native.isRefreshingAuth.subscribe(() => notify())),
	)
	let closePromise: Promise<void> | undefined
	const query = <Query extends FunctionReference<'query'>>(
		ref: Query,
		args: FunctionArgs<Query>,
	): ExternalStore<FunctionReturnType<Query> | undefined> => {
		scope.assertOpen()
		const model = frame.run(() => native.query(ref, args))
		return scope.store(
			() =>
				frame.run(() => {
					const result = model.result()
					if (result && !result.success) throw model.error()
					return result?.value
				}),
			(notify) => frame.run(() => model.result.subscribe(() => notify())),
		)
	}
	return {
		query,
		connection,
		auth,
		refreshing,
		...callbackApi(query),
		paginatedQuery<Query extends FunctionReference<'query'>>(
			ref: Query,
			args: Omit<FunctionArgs<Query>, 'paginationOpts'>,
			initialNumItems: number,
		) {
			scope.assertOpen()
			const model = frame.run(() => native.paginatedQuery(ref, args, { initialNumItems }))
			return {
				...scope.store(
					() =>
						frame.run(() => {
							const state = model.state()
							if (state.error) throw state.error
							return state.results
						}),
					(notify) => frame.run(() => model.state.subscribe(() => notify())),
				),
				loadMore: (n: number) => {
					scope.assertOpen()
					frame.run(() => model.loadMore(n))
				},
				status: (): PaginationStatus => frame.run(() => model.state().status),
			}
		},
		mutation<Mutation extends FunctionReference<'mutation'>>(
			ref: Mutation,
			args: FunctionArgs<Mutation>,
			mutationOptions?: MutationOptions,
		): Promise<FunctionReturnType<Mutation>> {
			scope.assertOpen()
			return frame.run(() => native.mutation(ref, args, mutationOptions))
		},
		action: <Action extends FunctionReference<'action'>>(
			ref: Action,
			args: FunctionArgs<Action>,
		) => {
			scope.assertOpen()
			return frame.run(() => native.action(ref, args))
		},
		setAuth: (fetch: AuthTokenFetcher, onChange?: (authenticated: boolean) => void) => {
			scope.assertOpen()
			frame.run(() => native.setAuth(fetch, onChange))
		},
		clearAuth: () => {
			scope.assertOpen()
			frame.run(native.clearAuth)
		},
		close() {
			if (!closePromise) {
				disconnect()
				scope.close()
				closePromise = frame.run(native.close)
			}
			return closePromise
		},
	}
}
