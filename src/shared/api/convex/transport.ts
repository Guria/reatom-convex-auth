import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server'

import { ConvexClient, type AuthTokenFetcher } from 'convex/browser'

/**
 * The part of Convex's websocket client the app uses. Stories and unit tests
 * substitute an in-memory implementation; Convex's websocket protocol is out
 * of reach for MSW.
 */
export type ConvexTransport = {
	onUpdate<Query extends FunctionReference<'query'>>(
		query: Query,
		args: FunctionArgs<Query>,
		onResult: (result: FunctionReturnType<Query>) => void,
		onError: (error: Error) => void,
	): () => void
	mutation<Mutation extends FunctionReference<'mutation'>>(
		mutation: Mutation,
		args: FunctionArgs<Mutation>,
	): Promise<FunctionReturnType<Mutation>>
	/** `onChange` reports whether the server accepted the token. */
	setAuth(fetchToken: AuthTokenFetcher, onChange: (isAuthenticated: boolean) => void): void
	clearAuth(): void
}

export function createConvexTransport(url: string): ConvexTransport {
	const client = new ConvexClient(url)
	return {
		onUpdate: (query, args, onResult, onError) => client.onUpdate(query, args, onResult, onError),
		mutation: (mutation, args) => client.mutation(mutation, args),
		setAuth: (fetchToken, onChange) => client.setAuth(fetchToken, onChange),
		clearAuth: () => client.client.clearAuth(),
	}
}
