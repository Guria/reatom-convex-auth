/** Framework-neutral contract. Consumers import neither Reatom nor Convex React. */
export type ExternalStore<T> = {
	getSnapshot(): T
	subscribe(notify: () => void): () => void
}

/** Owns external subscriptions until explicitly stopped or the client closes. */
export function subscriptionScope() {
	const subscriptions = new Set<() => void>()
	let closed = false
	const assertOpen = () => {
		if (closed) throw new Error('Client is closed')
	}
	return {
		assertOpen,
		store<T>(read: () => T, listen: (notify: () => void) => () => void): ExternalStore<T> {
			return {
				getSnapshot: () => {
					assertOpen()
					return read()
				},
				subscribe(notify) {
					assertOpen()
					const release = listen(notify)
					let active = true
					const stop = () => {
						if (!active) return
						active = false
						subscriptions.delete(stop)
						release()
					}
					subscriptions.add(stop)
					return stop
				},
			}
		},
		close() {
			if (closed) return
			closed = true
			for (const stop of subscriptions) stop()
		},
	}
}

/** Callback subscription with query failures delivered separately. */
export function onStoreUpdate<T>(
	store: ExternalStore<T | undefined>,
	receive: (value: T) => void,
	onError: (error: unknown) => void,
) {
	const update = () => {
		let value: T | undefined
		try {
			value = store.getSnapshot()
		} catch (error) {
			onError(error)
			return
		}
		if (value !== undefined) receive(value)
	}
	return store.subscribe(update)
}

type QueryFactory = <Query extends import('convex/server').FunctionReference<'query'>>(
	ref: Query,
	args: import('convex/server').FunctionArgs<Query>,
) => ExternalStore<import('convex/server').FunctionReturnType<Query> | undefined>

/** Both facade implementations use this exact callback delivery path. */
export function callbackApi(query: QueryFactory) {
	return {
		onUpdate<Query extends import('convex/server').FunctionReference<'query'>>(
			ref: Query,
			args: import('convex/server').FunctionArgs<Query>,
			receive: (value: import('convex/server').FunctionReturnType<Query>) => void,
			onError: (error: unknown) => void,
		) {
			return onStoreUpdate(query(ref, args), receive, onError)
		},
	}
}
