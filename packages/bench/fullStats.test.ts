import { expect, test } from 'vite-plus/test'

import { pairedRatio, quantile, summarize } from './fullStats'

test('reports median, IQR and interpolated p95 without mutating samples', () => {
	const input = [4, 1, 3, 2]
	expect(summarize(input)).toEqual({
		median: 2.5,
		q1: 1.75,
		q3: 3.25,
		p95: 3.8499999999999996,
		n: 4,
	})
	expect(input).toEqual([4, 1, 3, 2])
	expect(quantile([7], 0.95)).toBe(7)
	expect(() => quantile([], 0.5)).toThrow()
})

test('bootstrap preserves iteration pairing and is reproducible', () => {
	const baseline = [1, 10, 100, 1000]
	const candidate = baseline.map((ms) => ms / 2)
	expect(pairedRatio(baseline, candidate)).toEqual({ ratio: 0.5, low: 0.5, high: 0.5 })
	expect(pairedRatio(baseline, [3, 2, 4, 1])).toEqual(pairedRatio(baseline, [3, 2, 4, 1]))
	expect(() => pairedRatio([1], [1, 2])).toThrow()
	expect(() => pairedRatio([0], [1])).toThrow()
})
