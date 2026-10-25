// Benchmarks convex/react against the Reatom binding: runtime scenarios in
// Chromium on production builds (main.tsx), and minified bundle sizes of
// equivalent apps (size/). `--write` saves the report to RESULTS.md.
import react from '@vitejs/plugin-react'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { chromium } from 'playwright'
import { build, preview } from 'vite'

const { values: options } = parseArgs({
	options: {
		items: { type: 'string', default: '1000' },
		iterations: { type: 'string', default: '15' },
		warmup: { type: 'string', default: '3' },
		write: { type: 'boolean', default: false },
	},
})
const config = {
	items: Number(options.items),
	iterations: Number(options.iterations),
	warmup: Number(options.warmup),
}

const benchDir = import.meta.dirname
const outDir = path.resolve(benchDir, '../../.var/bench/runtime')
const OFFICIAL = 'convex/react'
// See reatomJsxRuntime.ts.
const resolve = {
	alias: [
		{
			find: /^@reatom\/jsx\/jsx-runtime$/,
			replacement: path.join(benchDir, 'reatomJsxRuntime.ts'),
		},
	],
}
const LABELS = [OFFICIAL, '@reatom/react', '@reatom/jsx'] as const

type Sample = { ms: number; renders: number; commits: number }
type Results = Record<string, Record<string, Sample[]>>

const quantile = (sorted: number[], q: number) => {
	const position = (sorted.length - 1) * q
	const lower = Math.floor(position)
	const upper = Math.ceil(position)
	return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}
const sortedBy = (samples: Sample[], key: keyof Sample) =>
	samples.map((sample) => sample[key]).sort((a, b) => a - b)
const median = (samples: Sample[], key: keyof Sample) => quantile(sortedBy(samples, key), 0.5)
const ms = (value: number) => (value < 10 ? value.toFixed(2) : value.toFixed(1))

async function runtime() {
	await build({
		configFile: false,
		root: benchDir,
		logLevel: 'warn',
		plugins: [react()],
		resolve: {
			alias: [
				...resolve.alias,
				// Production React with <Profiler> callbacks, to count commits.
				{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' },
			],
		},
		build: { outDir, emptyOutDir: true },
	})
	const server = await preview({
		configFile: false,
		root: benchDir,
		logLevel: 'silent',
		build: { outDir },
		// Cross-origin isolation gives performance.now() 5µs resolution instead of 100µs.
		preview: {
			port: 4317,
			headers: {
				'Cross-Origin-Opener-Policy': 'same-origin',
				'Cross-Origin-Embedder-Policy': 'require-corp',
			},
		},
	})
	const browser = await chromium.launch()
	try {
		const page = await browser.newPage()
		const errors: string[] = []
		page.on('pageerror', (error) => errors.push(error.message))
		page.on('console', (message) => {
			if (message.type() === 'error') errors.push(message.text())
		})
		await page.goto(server.resolvedUrls!.local[0]!)
		const results = await page.evaluate(
			(input) =>
				(window as unknown as { runBenchmarks(c: typeof input): Promise<Results> }).runBenchmarks(
					input,
				),
			config,
		)
		if (errors.length > 0) throw new Error(`Browser errors:\n${errors.join('\n')}`)
		return { results, browserVersion: browser.version() }
	} finally {
		await browser.close()
		await server.close()
	}
}

function runtimeTable(results: Results) {
	const cell = (samples: Sample[]) => {
		const sorted = sortedBy(samples, 'ms')
		return `${ms(quantile(sorted, 0.5))} (${ms(quantile(sorted, 0.25))}–${ms(quantile(sorted, 0.75))})`
	}
	const others = LABELS.slice(1)
	const rows = Object.entries(results).map(([scenario, byLabel]) => {
		const official = byLabel[OFFICIAL]!
		const ratios = others.map(
			(label) => `${(median(byLabel[label]!, 'ms') / median(official, 'ms')).toFixed(2)}×`,
		)
		const counts = (key: keyof Sample) => {
			const values = LABELS.map((label) => median(byLabel[label]!, key))
			if (values.every((value) => !value)) return '–'
			return values.map((value) => (Number.isNaN(value) ? '–' : value)).join(' / ')
		}
		return `| ${scenario} | ${LABELS.map((label) => cell(byLabel[label]!)).join(' | ')} | ${ratios.join(' | ')} | ${counts('renders')} | ${counts('commits')} |`
	})
	return [
		`| Scenario | ${LABELS.map((label) => `${label} ms`).join(' | ')} | ${others.map((label) => `${label} / official`).join(' | ')} | renders | commits |`,
		`|---|${LABELS.map(() => '---:').join('|')}|${others.map(() => '---:').join('|')}|---:|---:|`,
		...rows,
	].join('\n')
}

async function bundleSize(entry: string) {
	const output = await build({
		configFile: false,
		root: benchDir,
		logLevel: 'silent',
		plugins: [react()],
		resolve,
		build: {
			write: false,
			minify: true,
			modulePreload: false,
			rollupOptions: { input: path.join(benchDir, 'size', entry) },
		},
	})
	const outputs = Array.isArray(output) ? output : [output]
	const code = outputs
		.flatMap((result) => ('output' in result ? result.output : []))
		.flatMap((chunk) => (chunk.type === 'chunk' ? [chunk.code] : []))
		.join('\n')
	return {
		min: Buffer.byteLength(code),
		gzip: gzipSync(code, { level: 9 }).length,
		brotli: brotliCompressSync(code, {
			params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
		}).length,
	}
}

async function sizes() {
	type Size = Awaited<ReturnType<typeof bundleSize>>
	const [reactOnly, reactReatom, reatomJsxOnly, official, reatom, reatomJsx] = await Promise.all(
		[
			'react.tsx',
			'react-reatom.tsx',
			'reatom-jsx-baseline.tsx',
			'official.tsx',
			'reatom.tsx',
			'reatom-jsx.tsx',
		].map(bundleSize),
	)
	const kb = (bytes: number) => (bytes / 1024).toFixed(1)
	const row = (label: string, size: Size | undefined, baseline?: Size) =>
		`| ${label} | ${kb(size!.min)} | ${kb(size!.gzip)} | ${kb(size!.brotli)} | ${baseline ? `+${kb(size!.gzip - baseline.gzip)}` : ''} |`
	return [
		'| Bundle | min KiB | gzip KiB | brotli KiB | gzip added by Convex |',
		'|---|---:|---:|---:|---:|',
		row('React', reactOnly),
		row('React + Reatom', reactReatom),
		row('Reatom + @reatom/jsx', reatomJsxOnly),
		row('convex/react app', official, reactOnly),
		row('Binding + @reatom/react app', reatom, reactReatom),
		row('Binding + @reatom/jsx app', reatomJsx, reatomJsxOnly),
	].join('\n')
}

const { results, browserVersion } = await runtime()
const report = `# convex/react vs the Reatom binding

Generated by \`mise run bench\` on ${new Date().toISOString().slice(0, 10)}.
${os.cpus()[0]?.model ?? 'unknown CPU'}, ${os.platform()} ${os.release()}, Node ${process.version}, Chromium ${browserVersion}.
${config.iterations} iterations after ${config.warmup} warmup, ${config.items} components where a scenario mounts many.

## Runtime

Production builds run the same scenarios in one page for convex/react, the
Reatom binding rendered by @reatom/react, and the same binding rendered by
@reatom/jsx. Each iteration gets a fresh in-process Convex server
(packages/convex-fake-server), client and container, and the start
order rotates. Times run from the action to the DOM change, median with the
interquartile range. Renders count item component renders (for @reatom/jsx,
recomputes of an item's bound value); commits count React commits. Both list
medians in column order.

${runtimeTable(results)}

- mount, update all, update one, unmount: ${config.items} components, each with its own query. Unmount runs until the server holds no subscriptions.
- shared mount, shared update: ${config.items} components reading one query.
- optimistic shown, mutation confirmed: a mutation with the same optimistic update on a 100-item list, until the optimistic and then the server result render.
- first page, load more: pages of 25. convex/react uses \`usePaginatedQuery\`; the binding uses the core paginated query client.
- @reatom/jsx renders lists as reactive array children, which rebuild the list on each change.

## Bundle size

Minified production builds of equivalent apps (packages/bench/size): client, auth,
connection state, a skippable query, an optimistic mutation and a paginated
query. Each app's Convex share is measured over its own baseline: React for
convex/react, React + Reatom or Reatom + @reatom/jsx for the binding.

${await sizes()}
`

console.log(report)
if (options.write) await writeFile(path.join(benchDir, 'RESULTS.md'), report)
