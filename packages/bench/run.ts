// Benchmarks convex/react against the Reatom binding: runtime scenarios in
// Chromium on production builds (main.tsx), and minified bundle sizes of
// equivalent apps (size/). The Reatom side runs once per Reatom build: the
// packages installed here (stable) and in packages/reatom-next (next).
// `--native` instead runs the binding next to packages/reatom-convex-client
// on the stable build; `--patched` adds convex/react and the binding on the
// SDK with packages/convex-patched applied. `--write` saves the report to
// RESULTS*.md.
import type { Bench } from './main'
import type { Plugin, PreviewServer } from 'vite'

import react from '@vitejs/plugin-react'
import { patchedConvex } from 'convex-patched'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { chromium, type Page } from 'playwright'
import { build, preview } from 'vite'

const { values: options } = parseArgs({
	options: {
		items: { type: 'string', default: '1000' },
		iterations: { type: 'string', default: '15' },
		warmup: { type: 'string', default: '3' },
		write: { type: 'boolean', default: false },
		matched: { type: 'boolean', default: false },
		native: { type: 'boolean', default: false },
		patched: { type: 'boolean', default: false },
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
const outputName = options.patched
	? 'RESULTS_PATCHED'
	: options.native
		? options.unbatched
			? 'RESULTS_NATIVE_UNBATCHED'
			: 'RESULTS_NATIVE'
		: options.matched
			? 'RESULTS_MATCHED'
			: 'RESULTS'
if ([options.matched, options.native, options.patched].filter(Boolean).length > 1)
	throw new Error('--matched, --native and --patched are separate comparisons')
if (options.unbatched && !options.native) throw new Error('--unbatched requires --native')
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
function reatomBuild(name: string, dir: string) {
	const used = new Map<string, Set<string>>()
	let adapted = false
	const record = (pkg: string, id: string) =>
		used.set(pkg, (used.get(pkg) ?? new Set<string>()).add(packageDir(id, pkg)))
	const adapt = <Resolved extends { id: string }>(source: string, resolved: Resolved) => {
		if (source !== JSX_RUNTIME || !lacksJsx(resolved.id)) return resolved
		adapted = true
		return jsxRuntimeAdapter
	}
	const plugin: Plugin = {
		name: `reatom-${name}`,
		enforce: 'pre',
		async resolveId(source) {
			const pkg = reatomPackage(source)
			if (!pkg) return
			const resolved = await this.resolve(source, path.join(dir, 'package.json'), {
				skipSelf: true,
			})
			if (!resolved) throw new Error(`${name}: cannot resolve ${source} from ${dir}`)
			record(pkg, resolved.id)
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
	return { name, dir, plugin, describe }
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

const builds =
	options.native || options.patched
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

// convex/react loads no Reatom; it runs in the first page.
const COLUMNS = options.patched
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
	const pageDir = path.join(outDir, reatom.name)
	await build({
		configFile: false,
		root: benchDir,
		logLevel: 'warn',
		plugins: [react(), reatom.plugin, convexPatchedPlugin(false)],
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
			const byName = await page.evaluate(
				(input) =>
					(window as unknown as { bench: Bench }).bench.run(input.binding, input.scenario, {
						items: input.items,
						queryResponses: input.queryResponses,
						batchQuerySet: input.batchQuerySet,
					}),
				{ binding, scenario, items: config.items, queryResponses, batchQuerySet },
			)
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

async function runtime() {
	const { browser, pages, errors, close } = await openPages()
	try {
		const runs = COLUMNS.map((column) => ({ ...column, page: pages.get(column.build)!.page }))
		const scenarios = await runs[0]!.page.evaluate(
			() => (window as unknown as { bench: Bench }).bench.scenarios,
		)
		const results = await iterations(runs, scenarios, errors)
		const versions = new Map([...pages].map(([reatom, { version }]) => [reatom, version]))
		return { results, versions, browserVersion: browser.version() }
	} finally {
		await close()
	}
}

function runtimeTables(results: Results) {
	const labels = COLUMNS.map((column) => column.label)
	const table = (cell: (samples: Sample[], official: Sample[]) => string) =>
		[
			`| Scenario | ${labels.join(' | ')} |`,
			`|---|${labels.map(() => '---:').join('|')}|`,
			...Object.entries(results).map(
				([scenario, byLabel]) =>
					`| ${scenario} | ${labels.map((label) => cell(byLabel[label]!, byLabel[OFFICIAL]!)).join(' | ')} |`,
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

async function bundleSize(entry: string, reatom?: ReatomBuild, patched = false) {
	const output = await build({
		configFile: false,
		root: benchDir,
		logLevel: 'silent',
		plugins: [
			react(),
			...(reatom ? [reatom.plugin] : []),
			...(patched ? [convexPatchedPlugin(true)] : []),
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
	/** Label of the row whose gzip size is the app's baseline. */
	baseline?: string
}

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
		...(options.patched
			? [
					app('Binding + @reatom/react', 'reatom.tsx', react, true),
					app('Binding + @reatom/jsx', 'reatom-jsx.tsx', jsx, true),
				]
			: []),
		...(options.native || options.patched
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
		...(options.patched
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
	]
	const measured = await Promise.all(
		rows.map(({ entry, reatom, patched }) => bundleSize(entry, reatom, patched)),
	)
	const byLabel = new Map(rows.map(({ label }, index) => [label, measured[index]!]))
	const kb = (bytes: number) => (bytes / 1024).toFixed(1)
	const added = (size: Size, baseline: string | undefined) =>
		baseline ? `+${kb(size.gzip - byLabel.get(baseline)!.gzip)}` : ''
	return [
		'| Bundle | min KiB | gzip KiB | brotli KiB | gzip added by Convex |',
		'|---|---:|---:|---:|---:|',
		...rows.map(({ label, baseline }, index) => {
			const size = measured[index]!
			return `| ${label} | ${kb(size.min)} | ${kb(size.gzip)} | ${kb(size.brotli)} | ${added(size, baseline)} |`
		}),
	].join('\n')
}

const { results, versions, browserVersion } = await runtime()
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
const buildList = builds
	.map(
		(reatom) =>
			`- ${reatom.name} (${path.relative(path.resolve(benchDir, '../..'), reatom.dir)}): ${reatom.describe().join(', ')}. The page reports \`VERSION\` ${versions.get(reatom)}.`,
	)
	.join('\n')
const report = `# convex/react vs the Reatom binding${options.native || options.patched ? ' and native client' : ''}${options.patched ? ' on the patched SDK' : ''}

Generated by \`mise run bench${options.matched ? ' --matched' : ''}${options.native ? ' --native' : ''}${options.patched ? ' --patched' : ''}${options.unbatched ? ' --unbatched' : ''} --items ${config.items} --iterations ${config.iterations} --warmup ${config.warmup} --write\` on ${new Date().toISOString().slice(0, 10)}.
${os.cpus()[0]?.model ?? 'unknown CPU'}, ${os.platform()} ${os.release()}, Node ${process.version}, Chromium ${browserVersion}.
${config.iterations} iterations after ${config.warmup} warmup, ${config.items} components where a scenario mounts many.

Reatom builds, as bundled into their pages and size apps:

${buildList}

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
`

console.log(report)
if (options.write) {
	await writeFile(path.join(benchDir, `${outputName}.md`), report)
	await writeFile(
		path.join(benchDir, `${outputName}.json`),
		JSON.stringify(
			{
				config: { ...config, native: options.native, patched: options.patched, batchQuerySet },
				browserVersion,
				generated: new Date().toISOString(),
				builds: builds.map(({ name, describe }) => ({ name, packages: describe() })),
				results,
			},
			null,
			2,
		) + '\n',
	)
}
