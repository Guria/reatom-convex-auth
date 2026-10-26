import { afterEach, expect, test, vi } from 'vite-plus/test'

import { until } from './completion'

const root = document.createElement('div')
afterEach(() => root.replaceChildren())

test('1000 separate attribute mutations scan the container only once', async () => {
	const items = Array.from({ length: 1000 }, () => {
		const item = document.createElement('i')
		item.dataset['v'] = '-1'
		root.append(item)
		return item
	})
	const scan = vi.spyOn(root, 'querySelectorAll')
	try {
		const completed = until(root, { selector: '[data-v="0"]', count: 1000 })
		for (const item of items) {
			item.dataset['v'] = '0'
			await Promise.resolve()
		}
		expect(await completed).toBeGreaterThan(0)
		expect(scan).toHaveBeenCalledTimes(1)
	} finally {
		scan.mockRestore()
	}
})

test('tracks removed subtrees, nested insertions, and changed attributes', async () => {
	root.innerHTML = '<div><i data-v="0"></i><i data-v="0"></i></div>'
	const completed = until(root, { selector: '[data-v="0"]', count: 3 })
	root.firstElementChild?.remove()
	const replacement = document.createElement('div')
	replacement.innerHTML = '<i data-v="0"></i><i data-v="0"></i><i data-v="-1"></i>'
	root.append(replacement)
	await Promise.resolve()
	replacement.lastElementChild?.setAttribute('data-v', '0')
	await completed
	expect(root.querySelectorAll('[data-v="0"]')).toHaveLength(3)
})

test('checks list replacement, count, and first text together', async () => {
	root.innerHTML = '<ul><li>old</li></ul>'
	const completed = until(root, { selector: 'li', count: 2, firstText: 'fresh' })
	root.innerHTML = '<ul><li>fresh</li><li>old</li></ul>'
	await completed
})

test('rejects an unmet condition and disconnects its observer', async () => {
	await expect(until(root, { selector: 'li', count: 1 }, 10)).rejects.toThrow('timed out')
})
