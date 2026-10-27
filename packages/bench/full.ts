// Focused comparison of current PR #211 and the idiomatic native rewrite.
import type { FullBench, FullMode, FullSample } from './fullMain'

import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { gzipSync, brotliCompressSync } from 'node:zlib'
import { chromium } from 'playwright'
import { build, preview } from 'vite'

import { artifactPlugin, loadArtifacts } from './artifacts'
import { captureBrowserErrors } from './browserDiagnostics'
import { fullReatom } from './fullBuild'
import { renderFullReport, renderFullSummary } from './fullReport'
import { summarizeFull } from './fullStats'
import { renderPlainReport } from './plainReport'

const { values } = parseArgs({
	options: {
		sizes: { type: 'string', default: '10,100,1000,5000' },
		iterations: { type: 'string', default: '25' },
		warmup: { type: 'string', default: '5' },
		write: { type: 'boolean', default: false },
		plain: { type: 'boolean', default: false },
	},
})
const positive = (value: string, minimum = 1) => {
	const n = Number(value)
	if (!Number.isSafeInteger(n) || n < minimum) throw new Error(`Invalid count: ${value}`)
	return n
}
const sizes = values.sizes.split(',').map((size) => positive(size, 10))
const iterations = positive(values.iterations)
const warmup = positive(values.warmup, 0)
const root = path.resolve(import.meta.dirname, '../..')
const benchDir = import.meta.dirname
const artifacts = loadArtifacts({ lockFile: path.join(benchDir, 'full.lock.json') })
const reatom = fullReatom()
const directory = path.join(root, values.plain ? '.var/bench/plain' : '.var/bench/full')
mkdirSync(directory, { recursive: true })
const shapes = ['per-message', 'coalesced'] as const
export type FullRecord = FullSample & {
	iteration: number
	size: number
	shape: string
	mode: string
	metric: string
	group: 'view' | 'client'
}
export type FullSummary = {
	size: number
	shape: string
	mode: string
	metric: string
	group: string
	median: number
	q1: number
	q3: number
	p95: number
	n: number
	renders: number | null
	commits: number | null
	transitions: number | null
	adds: number | null
	querySetMessages: number | null
	callbacks: number | null
	relative?: ReturnType<typeof import('./fullStats').pairedRatio>
}
export type MemoryRow = {
	mode: string
	size: number
	liveBytes: number
	retainedBytes: number
	domNodes: number
}
export type BundleRow = { id: string; label: string; min: number; gzip: number; brotli: number }
export type FullResult = {
	date: string
	config: { sizes: number[]; iterations: number; warmup: number }
	environment: {
		os: string
		arch: string
		cpu: string
		cpus: number
		memoryGiB: number
		browser: string
		node: string
		revision: string
		productionReact: string
	}
	artifacts: typeof artifacts
	reatom: ReturnType<typeof reatom.provenance>
	modes: FullMode[]
	summary: FullSummary[]
	memory: MemoryRow[]
	bundles: BundleRow[]
	records: FullRecord[]
	checks?: string[]
}

const rotate = <T>(list: T[], shift: number) => [
	...list.slice(shift % list.length),
	...list.slice(0, shift % list.length),
]

function sizeRows() {
	const rows = [
		{
			id: 'pr-react',
			label: 'PR #211 + convex/react',
			entry: 'official.tsx',
			sdk: 'batched' as const,
		},
		{
			id: 'native-react',
			label: 'Native rewrite + convex/react',
			entry: 'official.tsx',
			sdk: 'atoms' as const,
		},
		{
			id: 'pr-reatom',
			label: 'PR #211 + Reatom binding + React',
			entry: 'reatom.tsx',
			sdk: 'batched' as const,
		},
		{
			id: 'native-reatom',
			label: 'Native direct atoms + React',
			entry: 'atoms-api.tsx',
			sdk: 'atoms' as const,
		},
		{
			id: 'pr-jsx',
			label: 'PR #211 + Reatom binding + JSX',
			entry: 'reatom-jsx.tsx',
			sdk: 'batched' as const,
		},
		{
			id: 'native-jsx',
			label: 'Native direct atoms + JSX',
			entry: 'atoms-api-jsx.tsx',
			sdk: 'atoms' as const,
		},
	]
	if (values.plain)
		rows.push(
			{
				id: 'pr-plain',
				label: 'PR #211 + plain React store',
				entry: 'plain-react.tsx',
				sdk: 'batched',
			},
			{
				id: 'native-plain',
				label: 'Native + plain React store',
				entry: 'plain-react.tsx',
				sdk: 'atoms',
			},
		)
	return rows.filter(
		(row) =>
			!values.plain || ['pr-react', 'native-react', 'pr-plain', 'native-plain'].includes(row.id),
	)
}

async function bundles(): Promise<BundleRow[]> {
	const output: BundleRow[] = []
	for (const row of sizeRows()) {
		const result = await build({
			configFile: false,
			root: benchDir,
			logLevel: 'silent',
			plugins: [
				react(),
				...(row.id === 'pr-plain'
					? [
							{
								name: 'plain-pr-size',
								enforce: 'pre' as const,
								resolveId(source: string) {
									if (source === '../plainClient') return path.join(benchDir, 'plainPrSize.ts')
									return undefined
								},
							},
						]
					: []),
				reatom.plugin,
				artifactPlugin(artifacts, row.sdk),
			],
			build: {
				write: false,
				minify: true,
				modulePreload: false,
				rollupOptions: { input: path.join(benchDir, 'size', row.entry) },
			},
		})
		const code = (Array.isArray(result) ? result : [result])
			.flatMap((r) => ('output' in r ? r.output : []))
			.flatMap((chunk) => (chunk.type === 'chunk' ? [chunk.code] : []))
			.join('\n')
		output.push({
			id: row.id,
			label: row.label,
			min: Buffer.byteLength(code),
			gzip: gzipSync(code, { level: 9 }).length,
			brotli: brotliCompressSync(code).length,
		})
	}
	return output
}

await build({
	configFile: false,
	root: benchDir,
	logLevel: 'warn',
	plugins: [react(), reatom.plugin, artifactPlugin(artifacts)],
	build: {
		outDir: path.join(directory, 'app'),
		emptyOutDir: true,
		rollupOptions: { input: path.join(benchDir, 'full.html') },
	},
})
const server = await preview({
	configFile: false,
	root: benchDir,
	logLevel: 'silent',
	build: { outDir: path.join(directory, 'app') },
	preview: {
		port: 4331,
		strictPort: true,
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
		},
	},
})
const browser = await chromium.launch()
const context = await browser.newContext()
const page = await context.newPage()
const errors = captureBrowserErrors(page)
const records: FullRecord[] = []
const memory: MemoryRow[] = []
try {
	await page.goto(`${server.resolvedUrls!.local[0]}full.html`)
	const meta = await page.evaluate((plain) => {
		const b = (window as unknown as { fullBench: FullBench }).fullBench
		return {
			modes: plain ? b.plainModes : b.modes,
			clients: plain ? b.plainClients : b.clients,
			version: b.version,
			isolated: crossOriginIsolated,
		}
	}, values.plain)
	if (!meta.isolated) throw new Error('High resolution timers require cross-origin isolation')
	console.log(
		`Chromium ${browser.version()}, Reatom ${meta.version}, ${sizes.join('/')} items, ${iterations} measured + ${warmup} warmup`,
	)
	const checks = values.plain
		? await page.evaluate(() =>
				(window as unknown as { fullBench: FullBench }).fullBench.checkPlainClient(),
			)
		: []
	console.log(`Preflight: ${checks.length} native facade integration groups passed`)
	for (const shape of shapes)
		await page.evaluate(
			(shape) =>
				(window as unknown as { fullBench: FullBench }).fullBench.reactiveArgs({
					items: 10,
					queryResponses: shape,
					batchQuerySet: true,
				}),
			shape,
		)
	for (const size of sizes) {
		for (let iteration = -warmup; iteration < iterations; iteration++) {
			const ordinal = iteration + warmup
			for (const shape of ordinal % 2 ? [...shapes].reverse() : shapes) {
				const scenarios =
					size === 1000 || sizes.length === 1
						? ['distinctQueries', 'sharedQuery', 'extra', 'optimisticMutation', 'pagination']
						: ['distinctQueries', 'sharedQuery', 'extra']
				if (values.plain) scenarios.push('updateBurst')
				for (const scenario of rotate(scenarios, ordinal)) {
					for (const mode of rotate([...meta.modes], ordinal)) {
						if (iterations === 1) console.log(`${mode.id} / ${scenario} / ${shape}`)
						const samples = await page
							.evaluate(
								({ id, scenario, config }) =>
									(window as unknown as { fullBench: FullBench }).fullBench.runView(
										id,
										scenario,
										config,
									),
								{
									id: mode.id,
									scenario,
									config: { items: size, queryResponses: shape, batchQuerySet: true },
								},
							)
							.catch((error: unknown) => {
								throw new Error(`${mode.id} / ${scenario} / N=${size} / ${shape}: ${String(error)}`)
							})
						if (iteration >= 0)
							for (const [metric, sample] of Object.entries(samples))
								records.push({
									...sample,
									iteration,
									size,
									shape,
									mode: mode.id,
									metric,
									group: 'view',
								})
					}
				}
				for (const kind of rotate(meta.clients, ordinal)) {
					if (iterations === 1) console.log(`${kind} / client / ${shape}`)
					const samples = await page
						.evaluate(
							({ kind, config }) =>
								(window as unknown as { fullBench: FullBench }).fullBench.clientRun(kind, config),
							{ kind, config: { items: size, queryResponses: shape, batchQuerySet: true } },
						)
						.catch((error: unknown) => {
							throw new Error(`${kind} / N=${size} / ${shape}: ${String(error)}`)
						})
					if (iteration >= 0)
						for (const [metric, sample] of Object.entries(samples))
							records.push({
								...sample,
								iteration,
								size,
								shape,
								mode: kind,
								metric,
								group: 'client',
							})
				}
				if (errors.length) throw new Error(errors.join('\n'))
			}
			if (iteration < 0 || (iteration + 1) % 5 === 0)
				console.log(
					`N=${size} ${iteration < 0 ? `warmup ${iteration + warmup + 1}/${warmup}` : `${iteration + 1}/${iterations}`}`,
				)
		}
		// GC changes performance. Keep it in a separate pass after all timed runs at this size.
		const cdp = await context.newCDPSession(page)
		for (let repeat = 0; repeat < 3; repeat++)
			for (const mode of rotate([...meta.modes], repeat)) {
				await cdp.send('HeapProfiler.collectGarbage')
				const before = await cdp.send('Runtime.getHeapUsage')
				const nodesBefore = await cdp.send('Memory.getDOMCounters')
				await page.evaluate(
					({ id, config }) =>
						(window as unknown as { fullBench: FullBench }).fullBench.memoryMount(id, config),
					{
						id: mode.id,
						config: { items: size, queryResponses: 'coalesced' as const, batchQuerySet: true },
					},
				)
				await cdp.send('HeapProfiler.collectGarbage')
				const live = await cdp.send('Runtime.getHeapUsage')
				const nodes = await cdp.send('Memory.getDOMCounters')
				await page.evaluate(() =>
					(window as unknown as { fullBench: FullBench }).fullBench.memoryClear(),
				)
				await cdp.send('HeapProfiler.collectGarbage')
				const after = await cdp.send('Runtime.getHeapUsage')
				memory.push({
					mode: mode.id,
					size,
					liveBytes: live.usedSize - before.usedSize,
					retainedBytes: after.usedSize - before.usedSize,
					domNodes: nodes.nodes - nodesBefore.nodes,
				})
			}
		await cdp.detach()
		writeFileSync(path.join(directory, 'checkpoint.json'), JSON.stringify({ records, memory }))
	}
	const result: FullResult = {
		date: new Date().toISOString(),
		checks,
		config: { sizes, iterations, warmup },
		environment: {
			os: `${os.platform()} ${os.release()}`,
			arch: os.arch(),
			cpu: os.cpus()[0]!.model,
			cpus: os.cpus().length,
			memoryGiB: os.totalmem() / 2 ** 30,
			browser: browser.version(),
			node: process.version,
			revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
			productionReact: 'React 19.2.7 production, no profiling instrumentation',
		},
		artifacts,
		reatom: reatom.provenance(),
		modes: [...meta.modes],
		records,
		summary: summarizeFull(records),
		memory,
		bundles: await bundles(),
	}
	const raw = JSON.stringify(result)
	writeFileSync(path.join(directory, 'results.json'), raw)
	if (values.write) {
		const name = values.plain ? 'PLAIN' : 'FULL'
		writeFileSync(path.join(benchDir, `${name}_SAMPLES.json.gz`), gzipSync(raw, { level: 9 }))
		const report = values.plain ? renderPlainReport(result) : renderFullReport(result)
		writeFileSync(path.join(benchDir, `RESULTS_${name}.md`), report.markdown)
		writeFileSync(path.join(benchDir, `RESULTS_${name}.html`), report.html)
		if (!values.plain && sizes.includes(1000))
			writeFileSync(path.join(benchDir, 'RESULTS_FULL_SUMMARY.html'), renderFullSummary(result))
	}
	console.log(`Saved ${records.length} samples to ${directory}/results.json`)
} finally {
	await browser.close()
	await server.close()
}
