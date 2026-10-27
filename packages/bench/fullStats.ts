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

/** Seeded bootstrap of paired iteration ratios. Repeats are not independent machines. */
export function pairedRatio(baseline: number[], candidate: number[]) {
	if (!baseline.length || baseline.length !== candidate.length || baseline.some((ms) => ms <= 0))
		throw new Error('Paired positive samples required')
	let seed = 211
	const next = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
		return seed / 2 ** 32
	}
	const ratios = candidate.map((ms, index) => ms / baseline[index]!)
	const boot = Array.from({ length: 2000 }, () =>
		quantile(
			Array.from({ length: ratios.length }, () => ratios[Math.floor(next() * ratios.length)]!),
			0.5,
		),
	)
	return { ratio: quantile(ratios, 0.5), low: quantile(boot, 0.025), high: quantile(boot, 0.975) }
}
