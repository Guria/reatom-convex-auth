// Benchmarks convex/react against the Reatom binding: runtime scenarios in
// Chromium on production builds (main.tsx), and minified bundle sizes of
// equivalent apps (size/). The Reatom side runs once per Reatom build: the
// packages installed here (stable) and in packages/reatom-next (next).
// `--native` instead runs the binding next to packages/reatom-convex-client
// on the stable build; `--patched` adds convex/react and the binding on the
// SDK with packages/convex-patched applied. `--write` saves the report to
// RESULTS*.md.
import type { ActionProbeKind } from './actionProbe'
import type { Bench } from './main'
import type { Plugin, PreviewServer } from 'vite'

import react from '@vitejs/plugin-react'
import { patchedConvex } from 'convex-patched'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { chromium, type Page } from 'playwright'
import { build, preview } from 'vite'

import {
	artifactPlugin,
	loadArtifacts,
	loadCoreArtifacts,
	type CoreArtifact,
	type SdkArtifact,
} from './artifacts'

const { values: options } = parseArgs({
	options: {
		items: { type: 'string', default: '1000' },
		iterations: { type: 'string', default: '15' },
		warmup: { type: 'string', default: '3' },
		write: { type: 'boolean', default: false },
		matched: { type: 'boolean', default: false },
		native: { type: 'boolean', default: false },
		patched: { type: 'boolean', default: false },
		artifacts: { type: 'boolean', default: false },
		'probe-abort': { type: 'boolean', default: false },
		'probe-action': { type: 'boolean', default: false },
		unbatched: { type: 'boolean', default: false },
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
const artifacts = options.artifacts ? loadArtifacts() : []
const coreArtifacts = options['probe-action'] ? loadCoreArtifacts() : []
const outputName = options.artifacts
	? options['probe-action']
		? 'RESULTS_ARTIFACTS_ACTION'
		: options['probe-abort']
			? 'RESULTS_ARTIFACTS_ABORT'
			: 'RESULTS_ARTIFACTS'
	: options.patched
		? 'RESULTS_PATCHED'
		: options.native
			? options.unbatched
				? 'RESULTS_NATIVE_UNBATCHED'
				: 'RESULTS_NATIVE'
			: options.matched
				? 'RESULTS_MATCHED'
				: 'RESULTS'
if (
	[options.matched, options.native, options.patched, options.artifacts].filter(Boolean).length > 1
)
	throw new Error('--matched, --native and --patched are separate comparisons')
if (options.unbatched && !options.native) throw new Error('--unbatched requires --native')
if (options['probe-abort'] && options['probe-action'])
	throw new Error('Choose one matched Reatom pair')
if (options['probe-action'] && !options.artifacts)
	throw new Error('--probe-action requires --artifacts')
if (options['probe-abort'] && !options.artifacts)
	throw new Error('--probe-abort requires --artifacts')
const batchQuerySet = !options.unbatched

const benchDir = import.meta.dirname
const outDir = path.resolve(benchDir, '../../.var/bench/runtime')
const OFFICIAL = 'convex/react'
const REATOM_PACKAGES = ['@reatom/core', '@reatom/react', '@reatom/jsx']
const JSX_RUNTIME = '@reatom/jsx/jsx-runtime'
// Stands in for a jsx-runtime entry that exports only `h`/`hf`.
const jsxRuntimeAdapter = path.join(benchDir, 'reatomJsxRuntime.ts')

type Sample = { ms: number; renders: number; commits: number; transitions?: number }
type Results = Record<string, Record<string, Sample[]>>

const readPackage = (dir: string) =>
	JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
		version: string
		dependencies?: Record<string, string>
	}

const packageDir = (id: string, pkg: string) => {
	const end = id.indexOf(`/node_modules/${pkg}/`)
	if (end < 0) throw new Error(`${pkg} resolved outside node_modules: ${id}`)
	return path.join(id.slice(0, end), 'node_modules', pkg)
}

const reatomPackage = (source: string) =>
	REATOM_PACKAGES.find((id) => source === id || source.startsWith(`${id}/`))

const lacksJsx = (file: string) => !/export\s*\{[^}]*\bjsx\b/.test(readFileSync(file, 'utf8'))

// URL and path specs (pkg.pr.new previews) say more than the version.
const specNote = (spec: string | undefined) => (spec?.includes('/') ? ` (${spec})` : '')

/**
 * A set of installed @reatom/* packages. Its plugin resolves every @reatom/*
 * import from `dir`, so a page or bundle never mixes two Reatom copies, and
 * records the package directories the builds used. A jsx-runtime entry
 * without `jsx` resolves to the adapter.
 */
function reatomBuild(name: string, dir: string, coreArtifact?: CoreArtifact) {
	const used = new Map<string, Set<string>>()
	const importedFiles = new Set<string>()
	let adapted = false
	const record = (pkg: string, id: string) =>
		used.set(pkg, (used.get(pkg) ?? new Set<string>()).add(packageDir(id, pkg)))
	const adapt = <Resolved extends { id: string }>(source: string, resolved: Resolved) => {
		if (source !== JSX_RUNTIME || !lacksJsx(resolved.id)) return resolved
		adapted = true
		return jsxRuntimeAdapter
	}
	const coreRoot = coreArtifact?.root ?? dir
	const importer = (pkg: string) =>
		path.join(pkg === '@reatom/core' ? coreRoot : dir, 'package.json')
	const plugin: Plugin = {
		name: `reatom-${name}`,
		enforce: 'pre',
		async resolveId(source) {
			const pkg = reatomPackage(source)
			if (!pkg) return
			const resolved = await this.resolve(source, importer(pkg), { skipSelf: true })
			if (!resolved) throw new Error(`${name}: cannot resolve ${source} from ${dir}`)
			record(pkg, resolved.id)
			importedFiles.add(resolved.id)
			return adapt(source, resolved)
		},
	}
	const label = (pkg: string, roots: Set<string>, spec: string | undefined) => {
		if (roots.size > 1) throw new Error(`${name}: two copies of ${pkg}: ${[...roots]}`)
		const { version } = readPackage([...roots][0]!)
		const adapter = pkg === '@reatom/jsx' && adapted ? ' with the JSX runtime adapter' : ''
		return `${pkg} ${version}${specNote(spec)}${adapter}`
	}
	/** `@reatom/core 1001.3.0, …`, from the packages the builds used. */
	const describe = () => {
		const specs = readPackage(dir).dependencies ?? {}
		const order = ([a]: [string, unknown], [b]: [string, unknown]) =>
			REATOM_PACKAGES.indexOf(a) - REATOM_PACKAGES.indexOf(b)
		return [...used].sort(order).map(([pkg, roots]) => label(pkg, roots, specs[pkg]))
	}
	const moduleHashes = () =>
		[...importedFiles].sort().map((file) => ({
			file: path.relative(path.resolve(benchDir, '../..'), file),
			sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
		}))
	return { name, dir, plugin, describe, coreArtifact, moduleHashes }
}

type ReatomBuild = ReturnType<typeof reatomBuild>

/**
 * Resolves `convex-patched/*` to the patched convex copy. With `everywhere`,
 * every `convex` import does, for size apps written against `convex/*`.
 */
function convexPatchedPlugin(everywhere: boolean): Plugin {
	const importer = path.join(patchedConvex(), 'package.json')
	const pattern = everywhere ? /^convex(?:-patched(?=\/))?(\/.*|)$/ : /^convex-patched(\/.*)$/
	const inCopy = (source: string, id: string | undefined) => {
		if (id?.includes('/.var/convex-patched/')) return id
		throw new Error(`convex-patched: ${source} resolved to ${id}`)
	}
	return {
		name: 'convex-patched',
		enforce: 'pre',
		async resolveId(source) {
			const match = pattern.exec(source)
			if (!match) return
			const resolved = await this.resolve(`convex${match[1]!}`, importer, { skipSelf: true })
			return inCopy(source, resolved?.id)
		},
	}
}

const builds = options['probe-action']
	? coreArtifacts.map((artifact) => reatomBuild(artifact.id, benchDir, artifact))
	: options.artifacts && options['probe-abort']
		? [
				reatomBuild('abort-base', path.resolve(benchDir, '../reatom-base')),
				reatomBuild('abort-patch', path.resolve(benchDir, '../reatom-next')),
			]
		: options.artifacts || options.native || options.patched
			? [reatomBuild('stable', benchDir)]
			: [
					options.matched
						? reatomBuild('base', path.resolve(benchDir, '../reatom-base'))
						: reatomBuild('stable', benchDir),
					reatomBuild('next', path.resolve(benchDir, '../reatom-next')),
				]

const patchedColumns = () =>
	[
		{ label: OFFICIAL, binding: OFFICIAL },
		{ label: `${OFFICIAL} patched`, binding: `${OFFICIAL} patched` },
		...['@reatom/react', '@reatom/jsx'].flatMap((binding) => [
			{ label: `${binding} binding`, binding },
			{ label: `${binding} binding patched`, binding: `${binding} patched` },
			{ label: `${binding} native`, binding: `${binding} native` },
		]),
	].map((column) => ({ ...column, build: builds[0]! }))

const artifactColumns = () =>
	builds.flatMap((reatom) =>
		[
			...['convex/react', '@reatom/react', '@reatom/jsx'].flatMap((binding) => [
				{ label: binding === OFFICIAL ? OFFICIAL : `${binding} binding`, binding },
				{ label: `${binding} ESM patch`, binding: `${binding} patched` },
				{ label: `${binding} TS patch`, binding: `${binding} TS patch` },
				{ label: `${binding} Reatom SDK`, binding: `${binding} Reatom SDK` },
				{ label: `${binding} Atoms SDK`, binding: `${binding} Atoms SDK` },
			]),
			...['@reatom/react', '@reatom/jsx'].map((binding) => ({
				label: `${binding} Atoms SDK API`,
				binding: `${binding} Atoms SDK API`,
			})),
			...['@reatom/react', '@reatom/jsx'].map((binding) => ({
				label: `${binding} native`,
				binding: `${binding} native`,
			})),
		].map((column) => ({
			...column,
			label: builds.length === 1 ? column.label : `${column.label} ${reatom.name}`,
			build: reatom,
		})),
	)

// The artifact rewrite also makes convex/react depend on the selected Reatom build.
const COLUMNS = options.artifacts
	? artifactColumns()
	: options.patched
		? patchedColumns()
		: [
				{ label: OFFICIAL, binding: OFFICIAL, build: builds[0]! },
				...['@reatom/react', '@reatom/jsx'].flatMap((binding) =>
					options.native
						? [
								{ label: `${binding} binding`, binding, build: builds[0]! },
								{ label: `${binding} native`, binding: `${binding} native`, build: builds[0]! },
							]
						: builds.map((reatom) => ({
								label: `${binding} ${reatom.name}`,
								binding,
								build: reatom,
							})),
				),
			]

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

async function buildPage(reatom: ReatomBuild) {
	const pageDir = path.join(outDir, options.artifacts ? 'artifacts' : 'existing', reatom.name)
	await build({
		configFile: false,
		root: benchDir,
		logLevel: 'warn',
		plugins: [react(), reatom.plugin, convexPatchedPlugin(false), artifactPlugin(artifacts)],
		resolve: {
			// Production React with <Profiler> callbacks, to count commits.
			alias: [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }],
		},
		build: { outDir: pageDir, emptyOutDir: true },
	})
	return pageDir
}

async function openPages() {
	const servers: PreviewServer[] = []
	for (const [index, reatom] of builds.entries()) {
		servers.push(
			await preview({
				configFile: false,
				root: benchDir,
				logLevel: 'silent',
				build: { outDir: await buildPage(reatom) },
				// Cross-origin isolation gives performance.now() 5µs resolution instead of 100µs.
				preview: {
					port: 4317 + index,
					strictPort: true,
					headers: {
						'Cross-Origin-Opener-Policy': 'same-origin',
						'Cross-Origin-Embedder-Policy': 'require-corp',
					},
				},
			}),
		)
	}
	const browser = await chromium.launch()
	const errors: string[] = []
	const pages = new Map<ReatomBuild, { page: Page; version: string }>()
	for (const [index, reatom] of builds.entries()) {
		// A context per page keeps each in its own renderer process and heap.
		const page = await (await browser.newContext()).newPage()
		page.on('pageerror', (error) => errors.push(error.message))
		page.on('console', (message) => {
			if (message.type() === 'error') errors.push(message.text())
		})
		await page.goto(servers[index]!.resolvedUrls!.local[0]!)
		const version = await page.evaluate(() => (window as unknown as { bench: Bench }).bench.version)
		pages.set(reatom, { page, version })
	}
	const close = async () => {
		await browser.close()
		await Promise.all(servers.map((server) => server.close()))
	}
	return { browser, pages, errors, close }
}

type Run = (typeof COLUMNS)[number] & { page: Page }

/** Runs every scenario for every column, starting at column `shift`. */
async function iteration(
	runs: Run[],
	shift: number,
	scenarios: string[],
	errors: string[],
	queryResponses: (typeof workloads)[number],
) {
	const order = [...runs.slice(shift), ...runs.slice(0, shift)]
	const samples: Array<{ label: string; byName: Record<string, Sample> }> = []
	for (const scenario of scenarios) {
		for (const { label, binding, page } of order) {
			await page.bringToFront()
			const byName = await page
				.evaluate(
					(input) =>
						(window as unknown as { bench: Bench }).bench.run(input.binding, input.scenario, {
							items: input.items,
							queryResponses: input.queryResponses,
							batchQuerySet: input.batchQuerySet,
						}),
					{ binding, scenario, items: config.items, queryResponses, batchQuerySet },
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

const record = (results: Results, samples: Awaited<ReturnType<typeof iteration>>) =>
	samples
		.flatMap(({ label, byName }) =>
			Object.entries(byName).map(([name, sample]) => ({ label, name, sample })),
		)
		.forEach(({ label, name, sample }) => ((results[name] ??= {})[label] ??= []).push(sample))

const workloadOrder = (index: number) => (index % 2 ? [...workloads].reverse() : workloads)

async function iterations(runs: Run[], scenarios: string[], errors: string[]) {
	const results: Record<(typeof workloads)[number], Results> = { 'per-message': {}, coalesced: {} }
	// The first column and the workload order rotate; warmup samples are dropped.
	for (const index of Array.from({ length: config.warmup + config.iterations }, (_, i) => i)) {
		for (const workload of workloadOrder(index)) {
			const samples = await iteration(runs, index % runs.length, scenarios, errors, workload)
			if (index >= config.warmup) record(results[workload], samples)
		}
	}
	return results
}

type ActionProbeSample = {
	build: string
	kind: ActionProbeKind
	size: number
	ms: number
	calls: number
}
const alternate = <T>(list: readonly T[], iteration: number) =>
	iteration % 2 ? [...list].reverse() : list

/** Iteration order of the action probe: builds and kinds alternate per iteration. */
function actionPlan() {
	const kinds = ['plain', 'subscribed', 'hooked', 'atom'] as const
	return Array.from({ length: config.warmup + config.iterations }, (_, iteration) =>
		[1000, 2000, 4000, 8000].flatMap((size) =>
			alternate(builds, iteration).flatMap((build) =>
				alternate(kinds, iteration).map((kind) => ({ iteration, size, build, kind })),
			),
		),
	).flat()
}

async function actionMeasurements(
	pages: Map<ReatomBuild, { page: Page; version: string }>,
): Promise<ActionProbeSample[]> {
	if (!options['probe-action']) return []
	const samples: ActionProbeSample[] = []
	for (const { iteration, size, build, kind } of actionPlan()) {
		const { page } = pages.get(build)!
		await page.bringToFront()
		const result = await page.evaluate(
			(input) => (window as unknown as { bench: Bench }).bench.actionProbe(input.size, input.kind),
			{ size, kind },
		)
		if (iteration >= config.warmup) samples.push({ build: build.name, kind, size, ...result })
	}
	return samples
}

async function runtime() {
	const { browser, pages, errors, close } = await openPages()
	try {
		const runs = COLUMNS.map((column) => ({ ...column, page: pages.get(column.build)!.page }))
		const scenarios = await runs[0]!.page.evaluate(
			() => (window as unknown as { bench: Bench }).bench.scenarios,
		)
		const results = await iterations(runs, scenarios, errors)
		const versions = new Map([...pages].map(([reatom, { version }]) => [reatom, version]))
		const actionSamples = await actionMeasurements(pages)
		return { results, versions, browserVersion: browser.version(), actionSamples }
	} finally {
		await close()
	}
}

function runtimeTables(results: Results) {
	const labels = COLUMNS.map((column) => column.label)
	const baselines = new Map(
		COLUMNS.map(({ label, build }) => [
			label,
			COLUMNS.find((column) => column.binding === OFFICIAL && column.build === build)!.label,
		]),
	)
	const table = (cell: (samples: Sample[], official: Sample[]) => string) =>
		[
			`| Scenario | ${labels.join(' | ')} |`,
			`|---|${labels.map(() => '---:').join('|')}|`,
			...Object.entries(results).map(
				([scenario, byLabel]) =>
					`| ${scenario} | ${labels.map((label) => cell(byLabel[label]!, byLabel[baselines.get(label)!]!)).join(' | ')} |`,
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
		transitions: labels
			.map((label) => {
				const counts = results['mount']![label]!.map((sample) => sample.transitions ?? 0).sort(
					(a, b) => a - b,
				)
				return `${label}: ${quantile(counts, 0.5)}`
			})
			.join('; '),
		counts: table(
			(samples) => `${count(median(samples, 'renders'))} / ${count(median(samples, 'commits'))}`,
		),
	}
}

async function bundleSize(
	entry: string,
	reatom?: ReatomBuild,
	patched = false,
	artifact?: SdkArtifact['id'],
) {
	const output = await build({
		configFile: false,
		root: benchDir,
		logLevel: 'silent',
		plugins: [
			react(),
			...(reatom ? [reatom.plugin] : []),
			...(patched ? [convexPatchedPlugin(true)] : []),
			artifactPlugin(artifacts, artifact),
		],
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

type Size = Awaited<ReturnType<typeof bundleSize>>

type SizeRow = {
	label: string
	entry: string
	reatom?: ReatomBuild
	patched?: boolean
	artifact?: SdkArtifact['id']
	/** Label of the row whose gzip size is the app's baseline. */
	baseline?: string
}

const withPatchedApps = options.artifacts || options.patched
const withNativeApps = withPatchedApps || options.native

const appRows = (reatom: ReatomBuild): SizeRow[] => {
	const react = `React + Reatom ${reatom.name}`
	const jsx = `Reatom + @reatom/jsx ${reatom.name}`
	const app = (label: string, entry: string, baseline: string, patched = false) => ({
		label: `${label} app ${reatom.name}${patched ? ', patched SDK' : ''}`,
		entry,
		reatom,
		patched,
		baseline,
	})
	return [
		app('Binding + @reatom/react', 'reatom.tsx', react),
		app('Binding + @reatom/jsx', 'reatom-jsx.tsx', jsx),
		...(withPatchedApps
			? [
					app('Binding + @reatom/react', 'reatom.tsx', react, true),
					app('Binding + @reatom/jsx', 'reatom-jsx.tsx', jsx, true),
				]
			: []),
		...(withNativeApps
			? [
					app('Native + @reatom/react', 'native.tsx', react),
					app('Native + @reatom/jsx', 'native-jsx.tsx', jsx),
				]
			: []),
	]
}

async function sizes() {
	const rows: SizeRow[] = [
		{ label: 'React', entry: 'react.tsx' },
		...builds.map((reatom) => ({
			label: `React + Reatom ${reatom.name}`,
			entry: 'react-reatom.tsx',
			reatom,
		})),
		...builds.map((reatom) => ({
			label: `Reatom + @reatom/jsx ${reatom.name}`,
			entry: 'reatom-jsx-baseline.tsx',
			reatom,
		})),
		{ label: 'convex/react app', entry: 'official.tsx', baseline: 'React' },
		...(options.artifacts || options.patched
			? [
					{
						label: 'convex/react app, patched SDK',
						entry: 'official.tsx',
						patched: true,
						baseline: 'React',
					},
				]
			: []),
		...builds.flatMap(appRows),
		...(options.artifacts
			? builds.flatMap((reatom) =>
					artifacts.flatMap(({ id, label }) => [
						{
							label: `${label} + convex/react app ${reatom.name}`,
							entry: 'official.tsx',
							reatom,
							artifact: id,
							baseline: 'React',
						},
						{
							label: `${label} + binding/react app ${reatom.name}`,
							entry: 'reatom.tsx',
							reatom,
							artifact: id,
							baseline: `React + Reatom ${reatom.name}`,
						},
						{
							label: `${label} + binding/jsx app ${reatom.name}`,
							entry: 'reatom-jsx.tsx',
							reatom,
							artifact: id,
							baseline: `Reatom + @reatom/jsx ${reatom.name}`,
						},
						...(id === 'atoms'
							? [
									{
										label: `${label} API + @reatom/react app ${reatom.name}`,
										entry: 'atoms-api.tsx',
										reatom,
										artifact: id,
										baseline: `React + Reatom ${reatom.name}`,
									},
									{
										label: `${label} API + @reatom/jsx app ${reatom.name}`,
										entry: 'atoms-api-jsx.tsx',
										reatom,
										artifact: id,
										baseline: `Reatom + @reatom/jsx ${reatom.name}`,
									},
								]
							: []),
					]),
				)
			: []),
	]
	const measured = await Promise.all(
		rows.map(({ entry, reatom, patched, artifact }) =>
			bundleSize(entry, reatom, patched, artifact),
		),
	)
	const byLabel = new Map(rows.map(({ label }, index) => [label, measured[index]!]))
	const kb = (bytes: number) => (bytes / 1024).toFixed(1)
	const added = (size: Size, baseline: string | undefined) =>
		baseline ? `+${kb(size.gzip - byLabel.get(baseline)!.gzip)}` : ''
	const table = [
		'| Bundle | min KiB | gzip KiB | brotli KiB | gzip added by Convex |',
		'|---|---:|---:|---:|---:|',
		...rows.map(({ label, baseline }, index) => {
			const size = measured[index]!
			return `| ${label} | ${kb(size.min)} | ${kb(size.gzip)} | ${kb(size.brotli)} | ${added(size, baseline)} |`
		}),
	].join('\n')
	return {
		table,
		rows: rows.map(({ label, baseline }, index) => ({ label, baseline, ...measured[index]! })),
	}
}

const { results, versions, browserVersion, actionSamples } = await runtime()
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
const bundleSizes = await sizes()
const sizeTable = bundleSizes.table
const buildList = builds
	.map(
		(reatom) =>
			`- ${reatom.name} (${path.relative(path.resolve(benchDir, '../..'), reatom.dir)}): ${reatom.describe().join(', ')}${reatom.coreArtifact ? `, core commit ${reatom.coreArtifact.commit}` : ''}. The page reports \`VERSION\` ${versions.get(reatom)}.`,
	)
	.join('\n')
const provenance = [...artifacts, ...coreArtifacts].map(({ root: _root, ...artifact }) => artifact)
const provenanceText = artifacts
	.map(
		({ label, repository, commit, sha256, esmSha256 }) =>
			`- ${label}: ${repository}@${commit}, archive SHA-256 \`${sha256}\`, ESM JS tree SHA-256 \`${esmSha256}\`.`,
	)
	.join('\n')
const actionReport =
	actionSamples.length === 0
		? ''
		: [
				'## Repeated-action control',
				'',
				'One action called N times in one tick, in Chromium. Median ms and IQR. Atom writes, subscribed actions and hooked actions are controls, not estimates of app performance.',
				'',
				'| Kind | N | ' + builds.map(({ name }) => name).join(' | ') + ' |',
				'|---|---:|' + builds.map(() => '---:').join('|') + '|',
				...(['plain', 'subscribed', 'hooked', 'atom'] as const).flatMap((kind) =>
					[1000, 2000, 4000, 8000].map(
						(size) =>
							'| ' +
							kind +
							' | ' +
							size +
							' | ' +
							builds
								.map(({ name }) => {
									const times = actionSamples
										.filter(
											(sample) =>
												sample.build === name && sample.kind === kind && sample.size === size,
										)
										.map(({ ms }) => ms)
										.sort((a, b) => a - b)
									return `${ms(quantile(times, 0.5))} (${ms(quantile(times, 0.25))}–${ms(quantile(times, 0.75))})`
								})
								.join(' | ') +
							' |',
					),
				),
			].join('\n')
const report = `# convex/react vs the Reatom binding${withNativeApps ? ' and native client' : ''}${options.patched ? ' on the patched SDK' : ''}${options.artifacts ? ' on the Guria/convex-js builds' : ''}

Generated by \`mise run bench${options.matched ? ' --matched' : ''}${options.native ? ' --native' : ''}${options.patched ? ' --patched' : ''}${options.artifacts ? ' --artifacts' : ''}${options['probe-abort'] ? ' --probe-abort' : ''}${options['probe-action'] ? ' --probe-action' : ''}${options.unbatched ? ' --unbatched' : ''} --items ${config.items} --iterations ${config.iterations} --warmup ${config.warmup} --write\` on ${new Date().toISOString().slice(0, 10)}.
${os.cpus()[0]?.model ?? 'unknown CPU'}, ${os.platform()} ${os.release()}, Node ${process.version}, Chromium ${browserVersion}.
${config.iterations} iterations after ${config.warmup} warmup, ${config.items} components where a scenario mounts many.

Reatom builds, as bundled into their pages and size apps:

${buildList}

${options.artifacts ? `## Thread artifacts\n\n${provenanceText}\n\nESM patch means the local published-SDK patch; TS patch means the fork tarball. Reatom SDK keeps the SDK API; native means the smaller local package with a different low-level API. Artifacts remain unmodified. Every SDK import inside a size build uses the chosen artifact. Every Reatom import, including those inside the rewritten SDK, uses the selected build.` : ''}

## Runtime

Production builds run the same scenarios for convex/react, the Reatom binding
rendered by @reatom/react, and the same binding rendered by @reatom/jsx. Each
Reatom build gets its own page, so a page never loads two Reatom copies;
convex/react runs in the baseline page. Each run gets a fresh in-process Convex
server (packages/convex-fake-server), client and container. Every iteration
runs all ${COLUMNS.length} columns ${builds.length === 1 ? 'in one page' : 'across both pages'}, and the column that goes first
rotates. Workload order also alternates. Times run from the action to the
DOM change. The completion observer scans the container once, then updates a
set of matches from changed nodes. It does not rescan 1000 items per update.

${options.patched ? `Columns marked "patched" run convex/react or the binding on convex@1.48.0 with packages/convex-patched applied: query set edits made in one microtask go out as one message, and while no optimistic update is pending a transition updates only the queries it names. The native client batches query set edits too.` : ''}

${options.native ? `The native client uses \`batchQuerySet: ${batchQuerySet}\`. ${batchQuerySet ? 'It coalesces query-set edits within a microtask. The binding and convex/react send one edit per message.' : 'It sends one edit per message, matching the other clients. This is the control for query-set batching.'}` : ''}

The stress case sends one response for each query-set message. The coalesced
case waits until the currently queued query-set burst has been processed and
sends its final state in one transition. These are synthetic response shapes,
not a claim about the response grouping of a deployed Convex backend.

${workloadReports}

- mount, update all, update one, unmount: ${config.items} components, each with its own query. Unmount runs until the server holds no subscriptions.
- shared mount, shared update: ${config.items} components reading one query.
- optimistic shown, mutation confirmed: a mutation with the same optimistic update on a 100-item list, until the optimistic and then the server result render.
- first page, load more: pages of 25. convex/react uses \`usePaginatedQuery\`; the binding uses the core paginated query client.
- @reatom/jsx renders lists as reactive array children, which rebuild the list on each change.

## Bundle size

Minified production builds of equivalent apps (packages/bench/size): client,
auth, connection state, a skippable query, an optimistic mutation and a
paginated query. The Reatom apps are built once per Reatom build. Each app's
Convex share is measured over its own baseline: React for convex/react,
React + Reatom or Reatom + @reatom/jsx of the same build for the binding.

${sizeTable}

${actionReport}
`

console.log(report)
if (options.write) {
	await writeFile(path.join(benchDir, `${outputName}.md`), report)
	await writeFile(
		path.join(benchDir, `${outputName}.json`),
		JSON.stringify(
			{
				config: {
					...config,
					native: options.native,
					patched: options.patched,
					artifacts: options.artifacts,
					batchQuerySet,
				},
				browserVersion,
				provenance,
				bundleSizes: bundleSizes.rows,
				actionSamples,
				generated: new Date().toISOString(),
				builds: builds.map(({ name, describe, coreArtifact, moduleHashes }) => ({
					name,
					packages: describe(),
					coreCommit: coreArtifact?.commit,
					moduleHashes: moduleHashes(),
				})),
				results,
			},
			null,
			2,
		) + '\n',
	)
}
