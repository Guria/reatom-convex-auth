import { expect, test } from 'vite-plus/test'

import { pairedRatio, quantile, summarize, summarizeFull } from './fullStats'

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

test('ratio of medians is not the median of individual iteration ratios', () => {
	expect(pairedRatio([1, 2, 100], [10, 2, 100]).ratio).toBe(5)
})

test('summary pairs the matching operation, scale and response shape', () => {
	const records = [
		{
			iteration: 0,
			size: 10,
			shape: 'coalesced',
			mode: 'pr-base',
			metric: 'mount',
			group: 'client' as const,
			ms: 2,
			transitions: 1,
		},
		{
			iteration: 0,
			size: 10,
			shape: 'coalesced',
			mode: 'native-atoms',
			metric: 'mount',
			group: 'client' as const,
			ms: 1,
			transitions: 1,
		},
	]
	const summaries = summarizeFull(records)
	expect(summaries[0]?.median).toBe(2)
	expect(summaries[0]?.relative).toBeUndefined()
	expect(summaries[1]?.relative).toEqual({ ratio: 0.5, low: 0.5, high: 0.5 })
	expect(summaries[1]?.transitions).toBe(1)
	expect(summaries[1]?.renders).toBeNull()
})
