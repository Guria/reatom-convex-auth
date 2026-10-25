// Function references and the optimistic update shared by both bindings.
import type { OptimisticUpdate } from 'convex/browser'
import type { PaginationResult } from 'convex/server'

import { makeFunctionReference } from 'convex/server'

export type Note = { _id: string; text: string }

export const api = {
	item: makeFunctionReference<'query', { id: number }, { id: number; v: number }>('bench:item'),
	list: makeFunctionReference<'query', Record<string, never>, Note[]>('bench:list'),
	page: makeFunctionReference<
		'query',
		{ paginationOpts: { numItems: number; cursor: string | null } },
		PaginationResult<Note>
	>('bench:page'),
	add: makeFunctionReference<'mutation', { text: string }, string>('bench:add'),
}

export const LIST_SIZE = 100
export const DATASET_SIZE = 500

/** Both bindings use this update: the new note shows first until confirmed. */
export const addNoteFirst: OptimisticUpdate<{ text: string }> = (store, { text }) => {
	const current = store.getQuery(api.list, {})
	if (current) store.setQuery(api.list, {}, [{ _id: 'optimistic', text }, ...current])
}
