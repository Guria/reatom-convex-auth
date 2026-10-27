// Runtime resolution uses verified tarballs; the experiment requires SDK API parity.
declare module 'convex-artifact-batched/browser' {
	export * from 'convex/browser'
}
declare module 'convex-artifact-batched/react' {
	export * from 'convex/react'
}
declare module 'convex-artifact-rewrite/browser' {
	export * from 'convex/browser'
}
declare module 'convex-artifact-rewrite/react' {
	export * from 'convex/react'
}
declare module 'convex-artifact-atoms/browser' {
	export * from 'convex/browser'
	// The Reatom API of the Atoms SDK; the bench uses this much of it.
	export const reatomConvexClient: (
		url: string,
		options?: import('convex/browser').BaseConvexClientOptions,
		name?: string,
	) => AtomsClient
	type Atom<T> = import('@reatom/core').AtomLike<T, []>
	type Ref = import('convex/server').FunctionReference<any>
	type PaginatedItem<Query extends Ref> =
		import('convex/server').FunctionReturnType<Query> extends { page: Array<infer Item> }
			? Item
			: never
	export type AtomsClient = {
		connectionState: Atom<import('convex/browser').ConnectionState>
		isAuthenticated: Atom<boolean | null>
		isRefreshingAuth: Atom<boolean>
		query<Query extends import('convex/server').FunctionReference<'query'>>(
			ref: Query,
			args?: import('convex/server').FunctionArgs<Query>,
		): {
			result: Atom<
				| { success: true; value: import('convex/server').FunctionReturnType<Query> }
				| { success: false; errorMessage: string }
				| undefined
			>
			data: Atom<import('convex/server').FunctionReturnType<Query> | undefined>
			error: Atom<Error | undefined>
		}
		paginatedQuery<Query extends import('convex/server').FunctionReference<'query'>>(
			ref: Query,
			args: Omit<import('convex/server').FunctionArgs<Query>, 'paginationOpts'>,
			options: { initialNumItems: number; id?: number },
		): {
			results: Atom<PaginatedItem<Query>[]>
			state: Atom<{
				results: PaginatedItem<Query>[]
				status: import('convex/browser').PaginationStatus
				error?: Error
			}>
			loadMore: (numItems: number) => boolean
		}
		mutation<Mutation extends import('convex/server').FunctionReference<'mutation'>>(
			ref: Mutation,
			args?: import('convex/server').FunctionArgs<Mutation>,
			options?: import('convex/browser').MutationOptions,
		): Promise<import('convex/server').FunctionReturnType<Mutation>>
		action<Action extends import('convex/server').FunctionReference<'action'>>(
			ref: Action,
			args?: import('convex/server').FunctionArgs<Action>,
		): Promise<import('convex/server').FunctionReturnType<Action>>
		setAuth(
			fetchToken: import('convex/browser').AuthTokenFetcher,
			onChange?: (authenticated: boolean) => void,
		): void
		clearAuth(): void
		close(): Promise<void>
	}
}
declare module 'convex-artifact-atoms/react' {
	export * from 'convex/react'
}
