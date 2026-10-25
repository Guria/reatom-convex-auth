// Benchmarks convex/react against the Reatom binding: runtime scenarios in
// Chromium on production builds (bench/main.tsx), and minified bundle sizes of
// equivalent apps (bench/size). `--write` saves the report to bench/RESULTS.md.
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

const root = path.resolve(import.meta.dirname, '..')
const benchDir = path.join(root, 'bench')
const outDir = path.join(root, '.var/bench/runtime')
const LABELS = ['convex/react', 'reatom'] as const

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
		// Production React with <Profiler> callbacks, to count commits.
		resolve: { alias: [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }] },
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
	const rows = Object.entries(results).map(([scenario, byLabel]) => {
		const [official, reatom] = LABELS.map((label) => byLabel[label]!)
		const cell = (samples: Sample[]) => {
			const sorted = sortedBy(samples, 'ms')
			return `${ms(quantile(sorted, 0.5))} (${ms(quantile(sorted, 0.25))}–${ms(quantile(sorted, 0.75))})`
		}
		const ratio = median(reatom!, 'ms') / median(official!, 'ms')
		const counts = (key: keyof Sample) => {
			const [a, b] = [median(official!, key), median(reatom!, key)]
			return a === 0 && b === 0 ? '–' : `${a} / ${b}`
		}
		return `| ${scenario} | ${cell(official!)} | ${cell(reatom!)} | ${ratio.toFixed(2)}× | ${counts('renders')} | ${counts('commits')} |`
	})
	return [
		'| Scenario | convex/react ms | reatom ms | reatom / official | renders | commits |',
		'|---|---:|---:|---:|---:|---:|',
		...rows,
	].join('\n')
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

async function sizes() {
	type Size = Awaited<ReturnType<typeof bundleSize>>
	const [reactOnly, reactReatom, official, reatom] = await Promise.all(
		['react.tsx', 'react-reatom.tsx', 'official.tsx', 'reatom.tsx'].map(bundleSize),
	)
	const kb = (bytes: number) => (bytes / 1024).toFixed(1)
	const row = (label: string, size: Size | undefined, baseline?: Size) =>
		`| ${label} | ${kb(size!.min)} | ${kb(size!.gzip)} | ${kb(size!.brotli)} | ${baseline ? `+${kb(size!.gzip - baseline.gzip)}` : ''} |`
	return [
		'| Bundle | min KiB | gzip KiB | brotli KiB | gzip added by Convex |',
		'|---|---:|---:|---:|---:|',
		row('React', reactOnly),
		row('React + Reatom', reactReatom),
		row('convex/react app', official, reactOnly),
		row('Reatom binding app', reatom, reactReatom),
	].join('\n')
}

const { results, browserVersion } = await runtime()
const report = `# convex/react vs the Reatom binding

Generated by \`mise run bench\` on ${new Date().toISOString().slice(0, 10)}.
${os.cpus()[0]?.model ?? 'unknown CPU'}, ${os.platform()} ${os.release()}, Node ${process.version}, Chromium ${browserVersion}.
${config.iterations} iterations after ${config.warmup} warmup, ${config.items} components where a scenario mounts many.

## Runtime

Production builds of both bindings run the same scenarios in one page, each
iteration on a fresh in-process Convex server (src/shared/mocks/fakeConvexServer.ts),
client and React root; the bindings alternate which goes first. Times run from
the action to the DOM change, median with the interquartile range. Renders
count item component renders; commits count React commits (both as
convex/react / reatom medians).

${runtimeTable(results)}

- mount, update all, update one, unmount: ${config.items} components, each with its own query. Unmount runs until the server holds no subscriptions.
- shared mount, shared update: ${config.items} components reading one query.
- optimistic shown, mutation confirmed: a mutation with the same optimistic update on a 100-item list, until the optimistic and then the server result render.
- first page, load more: pages of 25. convex/react uses \`usePaginatedQuery\`; the binding uses the core paginated query client.

## Bundle size

Minified production builds of equivalent apps (bench/size): client, auth,
connection state, a skippable query, an optimistic mutation and a paginated
query. The Convex share of the convex/react app is measured over React; the
binding's over React + Reatom, which an app using the binding already ships.

${await sizes()}
`

console.log(report)
if (options.write) await writeFile(path.join(benchDir, 'RESULTS.md'), report)
