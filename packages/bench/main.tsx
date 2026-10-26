// Runtime benchmark: the same scenarios for each binding, each run on a fresh
// fake server, client and container. `run.ts` builds this page once per Reatom
// build in production mode and drives `window.bench` from Playwright.
import { clearStack, VERSION } from '@reatom/core'

import {
	counters,
	createBenchServer,
	LIST_SIZE,
	until,
	type BenchInstance,
	type BenchServer,
	type Binding,
	type Handle,
} from './fixture'
import { official } from './official'
import { reatom } from './reatom'
import { reatomJsx } from './reatomJsx'

// The app's strict context: Reatom code runs only inside a frame.
clearStack()

type Config = { items: number; queryResponses: 'per-message' | 'coalesced' }
type Sample = { ms: number; renders: number; commits: number }

const allBindings = [official, reatom, reatomJsx]

const settle = (server: BenchServer) => server.server.settled()

async function session<T>(binding: Binding, config: Config, run: (ctx: Context) => Promise<T>) {
	const server = createBenchServer(config.queryResponses)
	// @reatom/jsx observes the container's parent, so it is attached first.
	const container = document.createElement('div')
	document.body.append(container)
	const instance = binding.create(server, container)
	while (!instance.connected()) await settle(server)
	try {
		return await run({ server, instance, container })
	} finally {
		await instance.close()
		container.remove()
		server.server.close()
	}
}

type Context = { server: BenchServer; instance: BenchInstance; container: HTMLElement }

/** Times `act` until `done`, counting renders and commits. */
async function measure(
	container: Element,
	act: () => void,
	done: Parameters<typeof until>[1],
): Promise<Sample> {
	counters.renders = 0
	counters.commits = 0
	const start = performance.now()
	act()
	const end = await until(container, done)
	return { ms: end - start, renders: counters.renders, commits: counters.commits }
}

type Scenario = (binding: Binding, config: Config) => Promise<Record<string, Sample>>

// N components, each with its own query.
const distinctQueries: Scenario = (binding, config) =>
	session(binding, config, async ({ server, instance, container }) => {
		const { items } = config
		const ids = Array.from({ length: items }, (_, index) => index)
		const all = (v: number) => ({ selector: `[data-v="${v}"]`, count: config.items })
		const mount = await measure(container, () => instance.items(ids), all(0))
		const updateAll = await measure(container, () => server.bump(ids), all(1))
		const middle = Math.floor(items / 2)
		const updateOne = await measure(container, () => server.bump([middle]), {
			selector: `[data-id="${middle}"][data-v="2"]`,
			count: 1,
		})
		// Later stray renders count too.
		await settle(server)
		updateOne.renders = counters.renders
		const start = performance.now()
		instance.clear()
		while (server.server.subscriptionCount('bench:item') > 0) await settle(server)
		const unmount = { ms: performance.now() - start, renders: 0, commits: 0 }
		return { mount, 'update all': updateAll, 'update one': updateOne, unmount }
	})

// N components reading one query.
const sharedQuery: Scenario = (binding, config) =>
	session(binding, config, async ({ server, instance, container }) => {
		const all = (v: number) => ({ selector: `[data-v="${v}"]`, count: config.items })
		const mount = await measure(container, () => instance.shared(config.items), all(0))
		const update = await measure(container, () => server.bump([0]), all(1))
		return { 'shared mount': mount, 'shared update': update }
	})

const optimisticMutation: Scenario = (binding, config) =>
	session(binding, config, async ({ instance, container }) => {
		const handle: Handle = {}
		instance.list(handle)
		await until(container, { selector: 'li', count: LIST_SIZE })
		counters.renders = 0
		counters.commits = 0
		const start = performance.now()
		const confirmed = handle.add!('fresh')
		const shownAt = await until(container, { selector: 'li', firstText: 'fresh' })
		const shown = { ms: shownAt - start, renders: 0, commits: counters.commits }
		await confirmed
		// The server's list keeps its size; the optimistic one had one more.
		const confirmedAt = await until(container, {
			selector: 'li',
			count: LIST_SIZE,
			firstText: 'fresh',
		})
		const roundTrip = { ms: confirmedAt - start, renders: 0, commits: counters.commits }
		return { 'optimistic shown': shown, 'mutation confirmed': roundTrip }
	})

const pagination: Scenario = (binding, config) =>
	session(binding, config, async ({ instance, container }) => {
		const handle: Handle = {}
		const pageSize = 25
		const first = await measure(container, () => instance.pages(pageSize, handle), {
			selector: 'li',
			count: pageSize,
		})
		const more = await measure(container, () => handle.loadMore!(pageSize), {
			selector: 'li',
			count: pageSize * 2,
		})
		return { 'first page': first, 'load more': more }
	})

const allScenarios: Record<string, Scenario> = {
	distinctQueries,
	sharedQuery,
	optimisticMutation,
	pagination,
}

// Without React there are no commits to count.
const withCommits = (binding: Binding, sample: Sample): Sample =>
	binding.commits ? sample : { ...sample, commits: Number.NaN }

/** Runs one scenario for one binding; returns its samples by name. */
async function runOnce(label: string, scenario: string, config: Config) {
	const binding = allBindings.find((candidate) => candidate.label === label)
	const runScenario = allScenarios[scenario]
	if (!binding || !runScenario) throw new Error(`Unknown run: ${label}, ${scenario}`)
	const samples = await runScenario(binding, config)
	return Object.fromEntries(
		Object.entries(samples).map(([name, sample]) => [name, withCommits(binding, sample)]),
	)
}

const bench = { version: VERSION, scenarios: Object.keys(allScenarios), run: runOnce }

/** What `run.ts` calls as `window.bench`. */
export type Bench = typeof bench

Object.assign(window, { bench })
