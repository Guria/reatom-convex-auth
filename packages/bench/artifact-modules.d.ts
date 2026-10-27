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
	export type AtomsClient = {
		connectionState: Atom<import('convex/browser').ConnectionState>
		isAuthenticated: Atom<boolean | null>
		isRefreshingAuth: Atom<boolean>
		query(ref: Ref, args?: object): { data: Atom<any> }
		paginatedQuery(
			ref: Ref,
			args: object,
			options: { initialNumItems: number; id?: number },
		): { results: Atom<any[]>; loadMore: (numItems: number) => boolean }
		mutation(
			ref: Ref,
			args?: object,
			options?: import('convex/browser').MutationOptions,
		): Promise<any>
		setAuth(fetchToken: import('convex/browser').AuthTokenFetcher): void
		close(): Promise<void>
	}
}
declare module 'convex-artifact-atoms/react' {
	export * from 'convex/react'
}
