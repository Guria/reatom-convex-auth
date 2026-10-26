/** DOM completion checks visit changed nodes, not the whole container on every mutation. */
type Condition = { selector: string; count?: number; firstText?: string }

export function until(root: Element, condition: Condition, timeout = 20_000) {
	return new Promise<number>((resolve, reject) => {
		const matching = new Set(root.querySelectorAll(condition.selector))
		const done = () =>
			(condition.count === undefined || matching.size === condition.count) &&
			(condition.firstText === undefined ||
				root.querySelector(condition.selector)?.textContent === condition.firstText)
		if (done()) return resolve(performance.now())
		const update = (element: Element) => {
			if (root.contains(element) && element.matches(condition.selector)) matching.add(element)
			else matching.delete(element)
		}
		const visit = (node: Node, removed: boolean) => {
			if (!(node instanceof Element)) return
			update(node)
			// Removed nodes may no longer match their old attributes. Visit every
			// descendant once so none stays in the set after a list replacement.
			for (const element of node.querySelectorAll(removed ? '*' : condition.selector))
				update(element)
		}
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				if (record.type === 'attributes' && record.target instanceof Element) update(record.target)
				for (const node of record.removedNodes) visit(node, true)
				for (const node of record.addedNodes) visit(node, false)
			}
			if (!done()) return
			const now = performance.now()
			clearTimeout(timer)
			observer.disconnect()
			resolve(now)
		})
		const timer = setTimeout(() => {
			observer.disconnect()
			reject(new Error(`Benchmark condition timed out: ${JSON.stringify(condition)}`))
		}, timeout)
		observer.observe(root, {
			subtree: true,
			childList: true,
			attributes: true,
			characterData: true,
		})
	})
}
