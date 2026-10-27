import type { FullRecord, FullSummary } from './full'

/** Linear-interpolated quantiles, including the p95 rather than treating it as a worst case. */
export function quantile(values: number[], q: number) {
	if (!values.length || q < 0 || q > 1) throw new Error('Invalid quantile input')
	const sorted = [...values].sort((a, b) => a - b)
	const position = (sorted.length - 1) * q
	const lo = Math.floor(position)
	return sorted[lo]! + (sorted[Math.ceil(position)]! - sorted[lo]!) * (position - lo)
}

export function summarize(values: number[]) {
	return {
		median: quantile(values, 0.5),
		q1: quantile(values, 0.25),
		q3: quantile(values, 0.75),
		p95: quantile(values, 0.95),
		n: values.length,
	}
}

/** Seeded paired bootstrap of the ratio of medians, not the median of ratios. */
export function pairedRatio(baseline: number[], candidate: number[]) {
	if (!baseline.length || baseline.length !== candidate.length || baseline.some((ms) => ms <= 0))
		throw new Error('Paired positive samples required')
	let seed = 211
	const next = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
		return seed / 2 ** 32
	}
	const boot = Array.from({ length: 2000 }, () => {
		const indices = Array.from({ length: baseline.length }, () =>
			Math.floor(next() * baseline.length),
		)
		return (
			quantile(
				indices.map((i) => candidate[i]!),
				0.5,
			) /
			quantile(
				indices.map((i) => baseline[i]!),
				0.5,
			)
		)
	})
	return {
		ratio: quantile(candidate, 0.5) / quantile(baseline, 0.5),
		low: quantile(boot, 0.025),
		high: quantile(boot, 0.975),
	}
}

export function summarizeFull(records: FullRecord[]): FullSummary[] {
	const groups = new Map<string, FullRecord[]>()
	for (const record of records) {
		const key = JSON.stringify([
			record.group,
			record.size,
			record.shape,
			record.mode,
			record.metric,
		])
		const group = groups.get(key) ?? []
		group.push(record)
		groups.set(key, group)
	}
	return [...groups.values()].map((samples) => {
		const first = samples[0]!
		const counts = (
			key: 'renders' | 'commits' | 'transitions' | 'adds' | 'querySetMessages' | 'callbacks',
		) => {
			const values = samples.flatMap((s) =>
				typeof s[key] === 'number' && Number.isFinite(s[key]) ? [s[key]!] : [],
			)
			return values.length ? summarize(values).median : null
		}
		const result: FullSummary = {
			group: first.group,
			size: first.size,
			shape: first.shape,
			mode: first.mode,
			metric: first.metric,
			...summarize(samples.map((s) => s.ms)),
			renders: counts('renders'),
			commits: counts('commits'),
			transitions: counts('transitions'),
			adds: counts('adds'),
			querySetMessages: counts('querySetMessages'),
			callbacks: counts('callbacks'),
		}
		if (first.mode.startsWith('native-')) {
			const baselineId =
				first.mode === 'native-atoms' || first.mode === 'native-base'
					? 'pr-base'
					: first.mode.replace('native-', 'pr-')
			const baseline = groups.get(
				JSON.stringify([first.group, first.size, first.shape, baselineId, first.metric]),
			)
			if (baseline)
				result.relative = pairedRatio(
					baseline.map((s) => s.ms),
					samples.map((s) => s.ms),
				)
		}
		return result
	})
}
