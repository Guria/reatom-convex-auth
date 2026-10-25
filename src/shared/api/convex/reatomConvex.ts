import type { ConvexTransport } from './transport'
import type { AuthTokenFetcher } from 'convex/browser'
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
} from '@reatom/core'

type QueryState<T> = { data?: T; error?: Error }

/**
 * Reatom binding for a Convex deployment. `transport` is read lazily, so a
 * test frame can set its own before anything subscribes.
 */
export const reatomConvex = (createTransport: () => ConvexTransport, name: string) => {
	const transport = atom(createTransport, `${name}.transport`)

	/**
	 * Server side of Convex's two-phase auth: `null` until the backend answers
	 * for the current auth state, then whether it accepted the token.
	 */
	const serverAuthenticated = atom<boolean | null>(null, `${name}.serverAuthenticated`)

	const setAuth = action((fetchToken: AuthTokenFetcher) => {
		serverAuthenticated.set(null)
		transport().setAuth(
			fetchToken,
			wrap((isAuthenticated: boolean) => serverAuthenticated.set(isAuthenticated)),
		)
	}, `${name}.setAuth`)

	const clearAuth = action(() => {
		transport().clearAuth()
		serverAuthenticated.set(false)
	}, `${name}.clearAuth`)

	/**
	 * Subscribes while connected and re-subscribes when `args` change. Errors
	 * land in `.error()` instead of throwing: a subscription can outlive the
	 * session that started it.
	 */
	const query = <Query extends FunctionReference<'query'>>(
		ref: Query,
		args: () => FunctionArgs<Query>,
		queryName: string,
	) => {
		const state = atom<QueryState<FunctionReturnType<Query>>>({}, `${queryName}.state`).extend(
			withConnectHook((target) => {
				let unsubscribe = noop
				const subscription = effect(() => {
					unsubscribe()
					target.set({})
					unsubscribe = transport().onUpdate(
						ref,
						args(),
						wrap((data: FunctionReturnType<Query>) => target.set({ data })),
						wrap((error: Error) => target.set({ error })),
					)
				}, `${queryName}.subscription`)
				// Convex subscriptions live outside Reatom's graph: drop them on disconnect.
				return () => {
					subscription.unsubscribe()
					unsubscribe()
				}
			}),
		)
		return {
			data: computed(() => state().data, `${queryName}.data`),
			error: computed(() => state().error, `${queryName}.error`),
			isLoading: computed(() => {
				const { data, error } = state()
				return data === undefined && error === undefined
			}, `${queryName}.isLoading`),
		}
	}

	const mutation = <Mutation extends FunctionReference<'mutation'>>(
		ref: Mutation,
		mutationName: string,
	) =>
		action(
			async (args: FunctionArgs<Mutation>): Promise<FunctionReturnType<Mutation>> =>
				await wrap(transport().mutation(ref, args)),
			mutationName,
		).extend(withAsync())

	return { transport, serverAuthenticated, setAuth, clearAuth, query, mutation }
}
