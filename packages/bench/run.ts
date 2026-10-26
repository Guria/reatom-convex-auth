// Benchmarks convex/react against the Reatom binding: runtime scenarios in
// Chromium on production builds (main.tsx), and minified bundle sizes of
// equivalent apps (size/). The Reatom side runs once per Reatom build: the
// packages installed here (stable) and in packages/reatom-next (next).
// `--write` saves the report to RESULTS.md.
import type { Bench } from './main'
import type { Plugin, PreviewServer } from 'vite'

import react from '@vitejs/plugin-react'
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
const outputName = options.matched ? 'RESULTS_MATCHED' : 'RESULTS'

const benchDir = import.meta.dirname
const outDir = path.resolve(benchDir, '../../.var/bench/runtime')
const OFFICIAL = 'convex/react'
const REATOM_PACKAGES = ['@reatom/core', '@reatom/react', '@reatom/jsx']
const JSX_RUNTIME = '@reatom/jsx/jsx-runtime'
// Stands in for a jsx-runtime entry that exports only `h`/`hf`.
const jsxRuntimeAdapter = path.join(benchDir, 'reatomJsxRuntime.ts')

type Sample = { ms: number; renders: number; commits: number }
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

const builds = [
	options.matched
		? reatomBuild('base', path.resolve(benchDir, '../reatom-base'))
		: reatomBuild('stable', benchDir),
	reatomBuild('next', path.resolve(benchDir, '../reatom-next')),
]

// convex/react loads no Reatom; it runs in the stable page.
const COLUMNS = [
	{ label: OFFICIAL, binding: OFFICIAL, build: builds[0]! },
	...['@reatom/react', '@reatom/jsx'].flatMap((binding) =>
		builds.map((reatom) => ({ label: `${binding} ${reatom.name}`, binding, build: reatom })),
	),
]

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

async function buildPage(reatom: ReatomBuild) {
	const pageDir = path.join(outDir, reatom.name)
	await build({
		configFile: false,
		root: benchDir,
		logLevel: 'warn',
		plugins: [react(), reatom.plugin],
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
					}),
				{ binding, scenario, items: config.items, queryResponses },
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
		counts: table(
			(samples) => `${count(median(samples, 'renders'))} / ${count(median(samples, 'commits'))}`,
		),
	}
}

async function bundleSize(entry: string, reatom?: ReatomBuild) {
	const output = await build({
		configFile: false,
		root: benchDir,
		logLevel: 'silent',
		plugins: [react(), ...(reatom ? [reatom.plugin] : [])],
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

async function sizes() {
	const reatomApps = async (reatom: ReatomBuild) => {
		const [reactReatom, jsxBaseline, binding, bindingJsx] = await Promise.all([
			bundleSize('react-reatom.tsx', reatom),
			bundleSize('reatom-jsx-baseline.tsx', reatom),
			bundleSize('reatom.tsx', reatom),
			bundleSize('reatom-jsx.tsx', reatom),
		])
		return { name: reatom.name, reactReatom, jsxBaseline, binding, bindingJsx }
	}
	const [[reactOnly, official], apps] = await Promise.all([
		Promise.all([bundleSize('react.tsx'), bundleSize('official.tsx')]),
		Promise.all(builds.map(reatomApps)),
	])
	const kb = (bytes: number) => (bytes / 1024).toFixed(1)
	const row = (label: string, size: Size, baseline?: Size) =>
		`| ${label} | ${kb(size.min)} | ${kb(size.gzip)} | ${kb(size.brotli)} | ${baseline ? `+${kb(size.gzip - baseline.gzip)}` : ''} |`
	return [
		'| Bundle | min KiB | gzip KiB | brotli KiB | gzip added by Convex |',
		'|---|---:|---:|---:|---:|',
		row('React', reactOnly),
		...apps.map((app) => row(`React + Reatom ${app.name}`, app.reactReatom)),
		...apps.map((app) => row(`Reatom + @reatom/jsx ${app.name}`, app.jsxBaseline)),
		row('convex/react app', official, reactOnly),
		...apps.map((app) =>
			row(`Binding + @reatom/react app ${app.name}`, app.binding, app.reactReatom),
		),
		...apps.map((app) =>
			row(`Binding + @reatom/jsx app ${app.name}`, app.bindingJsx, app.jsxBaseline),
		),
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

${tables.counts}`
	})
	.join('\n\n')
const sizeTable = await sizes()
const buildList = builds
	.map(
		(reatom) =>
			`- ${reatom.name} (${path.relative(path.resolve(benchDir, '../..'), reatom.dir)}): ${reatom.describe().join(', ')}. The page reports \`VERSION\` ${versions.get(reatom)}.`,
	)
	.join('\n')
const report = `# convex/react vs the Reatom binding

Generated by \`mise run bench${options.matched ? ' --matched' : ''}\` on ${new Date().toISOString().slice(0, 10)}.
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
runs all five columns across both pages, and the column that goes first
rotates. Workload order also alternates. Times run from the action to the
DOM change. The completion observer scans the container once, then updates a
set of matches from changed nodes. It does not rescan 1000 items per update.

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
				config,
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
