// Benchmarks convex/react against @reatomized/convex rendered by @reatom/react
// and @reatom/jsx: runtime scenarios in Chromium on a production build
// (main.tsx), and minified bundle sizes of equivalent apps (size/). `--write`
// saves the report to RESULTS.md.
import type { Bench } from './main'

import react from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { chromium, type Page } from 'playwright'
import { build, preview } from 'vite'

import { captureBrowserErrors } from './browserDiagnostics'

const { values: options } = parseArgs({
	options: {
		items: { type: 'string', default: '1000' },
		iterations: { type: 'string', default: '15' },
		warmup: { type: 'string', default: '3' },
		write: { type: 'boolean', default: false },
	},
})
const integer = (value: string, name: string, minimum = 1) => {
	const number = Number(value)
	if (!Number.isSafeInteger(number) || number < minimum)
		throw new Error(`${name} must be an integer >= ${minimum}`)
	return number
}
const config = {
	items: integer(options.items, 'items'),
	iterations: integer(options.iterations, 'iterations'),
	warmup: integer(options.warmup, 'warmup', 0),
}
const workloads = ['per-message', 'coalesced'] as const

const benchDir = import.meta.dirname
const outDir = path.resolve(benchDir, '../../.var/bench/runtime')
const OFFICIAL = 'convex/react'
const COLUMNS = [OFFICIAL, '@reatom/react', '@reatom/jsx']

type Sample = { ms: number; renders: number; commits: number; transitions?: number }
type Results = Record<string, Record<string, Sample[]>>

/** The installed version of `pkg`, from the bench's or the root's node_modules. */
const version = (pkg: string) => {
	const manifest = [benchDir, path.resolve(benchDir, '../..')]
		.map((dir) => path.join(dir, 'node_modules', pkg, 'package.json'))
		.find((file) => existsSync(file))
	if (!manifest) throw new Error(`${pkg} is not installed`)
	return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version
}

const quantile = (sorted: number[], q: number) => {
	const position = (sorted.length - 1) * q
	const lower = Math.floor(position)
	const upper = Math.ceil(position)
	return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}
const sortedBy = (samples: Sample[], key: 'ms' | 'renders' | 'commits') =>
	samples.map((sample) => sample[key]).sort((a, b) => a - b)
const median = (samples: Sample[], key: 'ms' | 'renders' | 'commits') =>
	quantile(sortedBy(samples, key), 0.5)
const ms = (value: number) => (value < 10 ? value.toFixed(2) : value.toFixed(1))

async function openPage() {
	await build({
		configFile: false,
		root: benchDir,
		logLevel: 'warn',
		plugins: [react()],
		resolve: {
			// Production React with <Profiler> callbacks, to count commits.
			alias: [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }],
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
			strictPort: true,
			headers: {
				'Cross-Origin-Opener-Policy': 'same-origin',
				'Cross-Origin-Embedder-Policy': 'require-corp',
			},
		},
	})
	const browser = await chromium.launch()
	const page = await browser.newPage()
	const errors = captureBrowserErrors(page)
	await page.goto(server.resolvedUrls!.local[0]!)
	const close = async () => {
		await browser.close()
		await server.close()
	}
	return { browser, page, errors, close }
}

/** Runs every scenario for every column, starting at column `shift`. */
async function iteration(
	page: Page,
	shift: number,
	scenarios: string[],
	errors: string[],
	queryResponses: (typeof workloads)[number],
) {
	const order = [...COLUMNS.slice(shift), ...COLUMNS.slice(0, shift)]
	const samples: Array<{ label: string; byName: Record<string, Sample> }> = []
	for (const scenario of scenarios) {
		for (const label of order) {
			const byName = await page
				.evaluate(
					(input) =>
						(window as unknown as { bench: Bench }).bench.run(input.label, input.scenario, {
							items: input.items,
							queryResponses: input.queryResponses,
						}),
					{ label, scenario, items: config.items, queryResponses },
				)
				.catch((error: unknown) => {
					throw new Error(`${label} / ${scenario} / ${queryResponses}: ${String(error)}`)
				})
			if (errors.length > 0) throw new Error(`Browser errors:\n${errors.join('\n')}`)
			samples.push({ label, byName })
		}
	}
	return samples
}

async function runtime() {
	const { browser, page, errors, close } = await openPage()
	try {
		const scenarios = await page.evaluate(
			() => (window as unknown as { bench: Bench }).bench.scenarios,
		)
		const results: Record<(typeof workloads)[number], Results> = {
			'per-message': {},
			coalesced: {},
		}
		// The first column and the workload order rotate; warmup samples are dropped.
		for (let index = 0; index < config.warmup + config.iterations; index++) {
			const order = index % 2 ? [...workloads].reverse() : workloads
			for (const workload of order) {
				const samples = await iteration(page, index % COLUMNS.length, scenarios, errors, workload)
				if (index < config.warmup) continue
				for (const { label, byName } of samples)
					for (const [name, sample] of Object.entries(byName))
						((results[workload][name] ??= {})[label] ??= []).push(sample)
			}
		}
		return { results, browserVersion: browser.version() }
	} finally {
		await close()
	}
}

function runtimeTables(results: Results) {
	const table = (cell: (samples: Sample[], official: Sample[]) => string) =>
		[
			`| Scenario | ${COLUMNS.join(' | ')} |`,
			`|---|${COLUMNS.map(() => '---:').join('|')}|`,
			...Object.entries(results).map(
				([scenario, byLabel]) =>
					`| ${scenario} | ${COLUMNS.map((label) => cell(byLabel[label]!, byLabel[OFFICIAL]!)).join(' | ')} |`,
			),
		].join('\n')
	const count = (value: number) => (!value || Number.isNaN(value) ? '–' : String(value))
	return {
		times: table((samples, official) => {
			const value = median(samples, 'ms')
			if (samples === official) return ms(value)
			return `${ms(value)} (${(value / median(official, 'ms')).toFixed(2)}×)`
		}),
		spread: table((samples) => {
			const sorted = sortedBy(samples, 'ms')
			return `${ms(quantile(sorted, 0.25))}–${ms(quantile(sorted, 0.75))}`
		}),
		transitions: COLUMNS.map((label) => {
			const counts = results['mount']![label]!.map((sample) => sample.transitions ?? 0).sort(
				(a, b) => a - b,
			)
			return `${label}: ${quantile(counts, 0.5)}`
		}).join('; '),
		counts: table(
			(samples) => `${count(median(samples, 'renders'))} / ${count(median(samples, 'commits'))}`,
		),
	}
}

async function bundleSize(entry: string) {
	const output = await build({
		configFile: false,
		root: benchDir,
		logLevel: 'silent',
		plugins: [react()],
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

/** Each app's Convex share is measured over the baseline without Convex. */
const SIZE_ROWS = [
	{ label: 'React', entry: 'react.tsx' },
	{ label: 'React + Reatom', entry: 'react-reatom.tsx' },
	{ label: 'Reatom + @reatom/jsx', entry: 'reatom-jsx-baseline.tsx' },
	{ label: 'convex/react app', entry: 'official.tsx', baseline: 'React' },
	{
		label: '@reatomized/convex + @reatom/react app',
		entry: 'reatom.tsx',
		baseline: 'React + Reatom',
	},
	{
		label: '@reatomized/convex + @reatom/jsx app',
		entry: 'reatom-jsx.tsx',
		baseline: 'Reatom + @reatom/jsx',
	},
]

async function sizes() {
	const measured = await Promise.all(SIZE_ROWS.map(({ entry }) => bundleSize(entry)))
	const gzipOf = new Map(SIZE_ROWS.map(({ label }, index) => [label, measured[index]!.gzip]))
	const kb = (bytes: number) => (bytes / 1024).toFixed(1)
	return [
		'| Bundle | min KiB | gzip KiB | brotli KiB | gzip added by Convex |',
		'|---|---:|---:|---:|---:|',
		...SIZE_ROWS.map(({ label, baseline }, index) => {
			const size = measured[index]!
			const added = baseline ? `+${kb(size.gzip - gzipOf.get(baseline)!)}` : ''
			return `| ${label} | ${kb(size.min)} | ${kb(size.gzip)} | ${kb(size.brotli)} | ${added} |`
		}),
	].join('\n')
}

const { results, browserVersion } = await runtime()
const workloadReports = workloads
	.map((workload) => {
		const tables = runtimeTables(results[workload])
		return `### ${workload === 'per-message' ? 'Per-message responses, stress case' : 'Coalesced query-set responses'}

Median ms, with the ratio to convex/react:

${tables.times}

Interquartile range, ms:

${tables.spread}

Item renders / React commits, medians. JSX counts bound-value recomputes:

${tables.counts}

Query-set transitions during mount, medians: ${tables.transitions}.`
	})
	.join('\n\n')
const sizeTable = await sizes()
const packages = ['convex', '@reatomized/convex', '@reatom/core', '@reatom/react', '@reatom/jsx']
	.map((pkg) => `${pkg} ${version(pkg)}`)
	.join(', ')

const report = `# convex/react vs @reatomized/convex

Generated by \`mise run bench --items ${config.items} --iterations ${config.iterations} --warmup ${config.warmup} --write\` on ${new Date().toISOString().slice(0, 10)}.
${os.cpus()[0]?.model ?? 'unknown CPU'}, ${os.platform()} ${os.release()}, Node ${process.version}, Chromium ${browserVersion}.
${packages}.
${config.iterations} iterations after ${config.warmup} warmup, ${config.items} components where a scenario mounts many.

## Runtime

A production build runs the same scenarios for convex/react and for
@reatomized/convex rendered by @reatom/react and by @reatom/jsx. Each run gets a
fresh in-process Convex server (packages/convex-fake-server), client and
container. The column that goes first rotates every iteration, and the workload
order alternates. Times run from the action to the DOM change.

The stress case sends one response for each query-set message. The coalesced
case waits until the queued query-set burst has been processed and sends its
final state in one transition. These are synthetic response shapes, not a claim
about how a deployed Convex backend groups responses.

${workloadReports}

- mount, update all, update one, unmount: ${config.items} components, each with its own query. Unmount runs until the server holds no subscriptions.
- shared mount, shared update: ${config.items} components reading one query.
- optimistic shown, mutation confirmed: a mutation with the same optimistic update on a 100-item list, until the optimistic and then the server result render.
- first page, load more: pages of 25.
- @reatom/jsx renders lists as reactive array children, which rebuild the list on each change.

## Bundle size

Minified production builds of equivalent apps (packages/bench/size): client,
auth, connection state, a skippable query, an optimistic mutation and a
paginated query. Each app's Convex share is measured over its baseline without
Convex.

${sizeTable}
`

console.log(report)
if (options.write) await writeFile(path.join(benchDir, 'RESULTS.md'), report)
