import { createFakeConvexServer, paginate } from 'convex-fake-server'

import { DATASET_SIZE, LIST_SIZE, type Note } from './api'

export { addNoteFirst, api, LIST_SIZE } from './api'
export type { Note } from './api'

export function createBenchServer() {
	const values = new Map<number, number>()
	let nextId = DATASET_SIZE
	const notes: Note[] = Array.from({ length: DATASET_SIZE }, (_, index) => ({
		_id: `n${index}`,
		text: `note ${index}`,
	}))
	const server = createFakeConvexServer({
		queries: {
			'bench:item': (_ctx, { id }) => ({ id: Number(id), v: values.get(Number(id)) ?? 0 }),
			'bench:list': () => notes.slice(0, LIST_SIZE),
			'bench:page': (ctx, { paginationOpts }) => paginate(ctx, notes, paginationOpts!),
		},
		mutations: {
			'bench:add': (_ctx, { text }) => {
				const note = { _id: `n${nextId++}`, text: String(text) }
				notes.unshift(note)
				return note._id
			},
		},
	})
	return {
		server,
		/** Changes the values of `ids` and pushes the new results. */
		bump(ids: number[]) {
			for (const id of ids) values.set(id, (values.get(id) ?? 0) + 1)
			server.invalidate()
		},
	}
}

export type BenchServer = ReturnType<typeof createBenchServer>

export const CLIENT_URL = 'https://bench.convex.cloud'

/** Resolves with the time `done()` first holds after a DOM change under `root`. */
export const until = (root: Element, done: () => boolean, timeout = 20_000) =>
	new Promise<number>((resolve, reject) => {
		if (done()) return resolve(performance.now())
		const timer = setTimeout(() => {
			observer.disconnect()
			reject(new Error('Benchmark condition timed out'))
		}, timeout)
		const observer = new MutationObserver(() => {
			if (!done()) return
			const now = performance.now()
			clearTimeout(timer)
			observer.disconnect()
			resolve(now)
		})
		observer.observe(root, {
			subtree: true,
			childList: true,
			attributes: true,
			characterData: true,
		})
	})

/**
 * Item component renders (for @reatom/jsx, recomputes of an item's bound
 * value) and React commits counted across a scenario.
 */
export const counters = { renders: 0, commits: 0 }

export type Handle = { add?: (text: string) => Promise<unknown>; loadMore?: (n: number) => void }

/**
 * One binding under test, bound to one server, client and container. Each
 * view method builds its models and renders them into the container.
 */
export type BenchInstance = {
	connected(): boolean
	items(ids: number[]): void
	shared(count: number): void
	list(handle: Handle): void
	pages(initialNumItems: number, handle: Handle): void
	/** Removes the rendered view. */
	clear(): void
	close(): Promise<void>
}

export type Binding = {
	label: string
	/** Whether React commits are counted. */
	commits: boolean
	create(server: BenchServer, container: HTMLElement): BenchInstance
}
