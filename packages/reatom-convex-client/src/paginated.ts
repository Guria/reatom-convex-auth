// Reactive pagination over page queries, as
// convex/src/browser/sync/paginated_query_client.ts does it: loaded pages stay
// subscribed, and a page the server asks to split is replaced by two once both
// halves have loaded.
import type { QueryEntry, ReatomConvexClient } from './client'
import type { PaginationStatus } from 'convex/browser'
import type { Value } from 'convex/values'

import { action, atom, computed, noop, withComputed, type Atom } from '@reatom/core'

import { withConnectionHooks } from './withConnectionHooks'

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

const splitCursorOf = (result: PageResult, initialNumItems: number): string | null => {
	if (!result.splitCursor) return null
	return result.pageStatus === 'SplitRecommended' ||
		result.pageStatus === 'SplitRequired' ||
		result.page.length > initialNumItems * 2
		? result.splitCursor
		: null
}

const replaceSplitPage = (pages: Page[], key: number, halves: readonly [Page, Page]) =>
	pages.flatMap((current) => (current.key === key ? halves.slice() : [current]))

type PageFactory = (source: Source, key: number, paginationOpts: Record<string, Value>) => Page

const loaded = (entry: QueryEntry) => {
	const result = entry.result()
	return result?.status === 'success' ? asPageResult(result.data) : undefined
}

/** Swaps in the halves of each split once both have loaded; reads every half. */
const completeSplits = (pages: Page[], splits: Map<number, readonly [Page, Page]>) => {
	let active = pages
	for (const [key, halves] of splits) {
		const done = halves.map(({ entry }) => entry.result() !== undefined)
		if (!done.every(Boolean)) continue
		active = replaceSplitPage(active, key, halves)
		splits.delete(key)
	}
	return active
}

/** Starts splitting each page the server asks to split; returns the next page key. */
const startSplits = (
	list: PageList,
	active: Page[],
	splits: Map<number, readonly [Page, Page]>,
	page: PageFactory,
	initialNumItems: number,
) => {
	let { nextKey } = list
	for (const current of active) {
		const result = splits.has(current.key) ? undefined : loaded(current.entry)
		const splitCursor = result && splitCursorOf(result, initialNumItems)
		if (!result || !splitCursor) continue
		const halves = [
			page(list.source, nextKey++, {
				numItems: initialNumItems,
				cursor: current.cursor,
				endCursor: splitCursor,
			}),
			page(list.source, nextKey++, {
				numItems: initialNumItems,
				cursor: splitCursor,
				endCursor: result.continueCursor,
			}),
		] as const
		// Read now, so the halves loading re-runs the derivation.
		halves.forEach(({ entry }) => entry.result())
		splits.set(current.key, halves)
	}
	return nextKey
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
			const list: PageList =
				current?.source === next
					? current
					: {
							source: next,
							pages: [page(next, 0, { cursor: null, numItems: initialNumItems })],
							splits: new Map(),
							nextKey: 1,
						}
			const splits = new Map(list.splits)
			const active = completeSplits(list.pages, splits)
			const nextKey = startSplits(list, active, splits, page, initialNumItems)
			return active !== list.pages || splits.size !== list.splits.size || nextKey !== list.nextKey
				? { ...list, pages: active, splits, nextKey }
				: list
		}),
		// Like ConvexClient, forget loaded cursors when the last reader leaves.
		withConnectionHooks(noop, () => {
			pages.set(null)
		}),
	)

	const state = computed((): PaginatedState<Item> => {
		const list = pages()
		if (!list) return SKIPPED
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
	}, `${name}.state`)

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
