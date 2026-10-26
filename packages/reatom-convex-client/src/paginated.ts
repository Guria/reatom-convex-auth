// Reactive pagination over page queries, as
// convex/src/browser/sync/paginated_query_client.ts does it: loaded pages stay
// subscribed, and a page the server asks to split is replaced by two once both
// halves have loaded.
import type { QueryEntry, ReatomConvexClient } from './client'
import type { PaginationStatus } from 'convex/browser'
import type { Value } from 'convex/values'

import { action, atom, computed, withChangeHook, withComputed, type Atom } from '@reatom/core'

export type PaginatedState<Item> = {
	status: PaginationStatus | 'Skipped'
	results: Item[]
	error?: Error
}

type PageResult = {
	page: Value[]
	isDone: boolean
	continueCursor: string
	splitCursor?: string | null
	pageStatus?: 'SplitRecommended' | 'SplitRequired' | null
}

type Page = { key: number; cursor: string | null; entry: QueryEntry }

type Source = { client: ReatomConvexClient; args: Record<string, Value>; key: string }

type PageList = {
	source: Source
	/** Active pages in result order. */
	pages: Page[]
	/** Pages being split, by the key of the page they replace. */
	splits: ReadonlyMap<number, readonly [Page, Page]>
	nextKey: number
}

const asPageResult = (value: Value): PageResult => {
	const result = value as Partial<PageResult> | null
	if (
		typeof result !== 'object' ||
		result === null ||
		!Array.isArray(result.page) ||
		typeof result.isDone !== 'boolean' ||
		typeof result.continueCursor !== 'string'
	) {
		throw new Error(`Not a valid paginated query result: ${String(value)}`)
	}
	return result as PageResult
}

const SKIPPED: PaginatedState<never> = { status: 'Skipped', results: [] }

/**
 * Pages of `udfPath` for the args `source` yields. Two models with the same
 * args share page subscriptions, not their loaded page lists.
 */
export const reatomPaginatedPages = <Item>(
	udfPath: string,
	source: () => Source | null,
	initialNumItems: number,
	name: string,
) => {
	const page = (
		{ client, args }: Source,
		key: number,
		paginationOpts: Record<string, Value>,
	): Page => ({
		key,
		cursor: paginationOpts['cursor'] as string | null,
		// `id: -1` as in `ConvexClient`: equal page queries are shared.
		entry: client.query(udfPath, { ...args, paginationOpts: { ...paginationOpts, id: -1 } }),
	})

	const pages: Atom<PageList | null> = atom<PageList | null>(null, `${name}.pages`).extend(
		withComputed((current) => {
			const next = source()
			if (!next) return null
			if (current?.source === next) return current
			return {
				source: next,
				pages: [page(next, 0, { cursor: null, numItems: initialNumItems })],
				splits: new Map(),
				nextKey: 1,
			}
		}),
	)

	const loaded = (entry: QueryEntry) => {
		const result = entry.result()
		return result?.status === 'success' ? asPageResult(result.data) : undefined
	}

	const splitPages = action((list: PageList) => {
		const splits = new Map(list.splits)
		let { pages: active, nextKey } = list
		for (const [key, [first, second]] of splits) {
			if (!first.entry.result() || !second.entry.result()) continue
			active = active.flatMap((current) => (current.key === key ? [first, second] : [current]))
			splits.delete(key)
		}
		for (const current of active) {
			if (splits.has(current.key)) continue
			const result = loaded(current.entry)
			const shouldSplit =
				result?.splitCursor &&
				(result.pageStatus === 'SplitRecommended' ||
					result.pageStatus === 'SplitRequired' ||
					result.page.length > initialNumItems * 2)
			if (!result || !shouldSplit) continue
			splits.set(current.key, [
				page(list.source, nextKey++, {
					numItems: initialNumItems,
					cursor: current.cursor,
					endCursor: result.splitCursor!,
				}),
				page(list.source, nextKey++, {
					numItems: initialNumItems,
					cursor: result.splitCursor!,
					endCursor: result.continueCursor,
				}),
			])
		}
		if (active !== list.pages || splits.size !== list.splits.size || nextKey !== list.nextKey) {
			pages.set({ ...list, pages: active, splits, nextKey })
		}
	}, `${name}._splitPages`)

	const state = computed((): PaginatedState<Item> => {
		const list = pages()
		if (!list) return SKIPPED
		// Halves of a split stay subscribed while they load.
		for (const [first, second] of list.splits.values()) {
			first.entry.result()
			second.entry.result()
		}
		let results: Item[] = []
		let loading = false
		let isDone = false
		for (const { entry } of list.pages) {
			const result = entry.result()
			if (result === undefined) {
				loading = true
				isDone = false
				continue
			}
			if (result.status === 'error') {
				return { status: 'LoadingFirstPage', results: [], error: result.error }
			}
			const pageResult = asPageResult(result.data)
			results = results.concat(pageResult.page as Item[])
			isDone = pageResult.isDone
		}
		const status: PaginationStatus = loading
			? results.length === 0
				? 'LoadingFirstPage'
				: 'LoadingMore'
			: isDone
				? 'Exhausted'
				: 'CanLoadMore'
		return { status, results }
	}, `${name}.state`).extend(
		withChangeHook(() => {
			const list = pages()
			if (list) splitPages(list)
		}),
	)

	/** Returns whether a page load started. */
	const loadMore = action((numItems: number) => {
		const list = pages()
		const last = list?.pages.at(-1)
		const result = last && loaded(last.entry)
		if (!list || !result || result.isDone) return false
		pages.set({
			...list,
			pages: [
				...list.pages,
				page(list.source, list.nextKey, { cursor: result.continueCursor, numItems }),
			],
			nextKey: list.nextKey + 1,
		})
		return true
	}, `${name}.loadMore`)

	return { state, loadMore }
}
