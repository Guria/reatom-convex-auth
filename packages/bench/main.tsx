// Runtime benchmark: the same scenarios for each binding, each iteration on a
// fresh fake server, client and container. `run.ts` builds this page
// in production mode and calls `runBenchmarks` from Playwright.
import { clearStack } from '@reatom/core'

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

type Config = {
	items: number
	iterations: number
	warmup: number
	/** Labels and scenario names to run; all by default. */
	only?: { bindings?: string[]; scenarios?: string[] }
}
type Sample = { ms: number; renders: number; commits: number }
type Results = Record<string, Record<string, Sample[]>>

const allBindings = [official, reatom, reatomJsx]

const settle = (server: BenchServer) => server.server.settled()

async function session<T>(binding: Binding, run: (ctx: Context) => Promise<T>) {
	const server = createBenchServer()
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
async function measure(container: Element, act: () => void, done: () => boolean): Promise<Sample> {
	counters.renders = 0
	counters.commits = 0
	const start = performance.now()
	act()
	const end = await until(container, done)
	return { ms: end - start, renders: counters.renders, commits: counters.commits }
}

const count = (container: Element, selector: string) => container.querySelectorAll(selector).length

type Scenario = (binding: Binding, config: Config) => Promise<Record<string, Sample>>

// N components, each with its own query.
const distinctQueries: Scenario = (binding, { items }) =>
	session(binding, async ({ server, instance, container }) => {
		const ids = Array.from({ length: items }, (_, index) => index)
		const all = (v: number) => () => count(container, `[data-v="${v}"]`) === items
		const mount = await measure(container, () => instance.items(ids), all(0))
		const updateAll = await measure(container, () => server.bump(ids), all(1))
		const middle = Math.floor(items / 2)
		const updateOne = await measure(
			container,
			() => server.bump([middle]),
			() => count(container, `[data-id="${middle}"][data-v="2"]`) === 1,
		)
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
const sharedQuery: Scenario = (binding, { items }) =>
	session(binding, async ({ server, instance, container }) => {
		const all = (v: number) => () => count(container, `[data-v="${v}"]`) === items
		const mount = await measure(container, () => instance.shared(items), all(0))
		const update = await measure(container, () => server.bump([0]), all(1))
		return { 'shared mount': mount, 'shared update': update }
	})

const optimisticMutation: Scenario = (binding) =>
	session(binding, async ({ instance, container }) => {
		const handle: Handle = {}
		instance.list(handle)
		await until(container, () => count(container, 'li') === LIST_SIZE)
		const first = () => container.querySelector('li')?.textContent
		counters.renders = 0
		counters.commits = 0
		const start = performance.now()
		const confirmed = handle.add!('fresh')
		const shownAt = await until(container, () => first() === 'fresh')
		const shown = { ms: shownAt - start, renders: 0, commits: counters.commits }
		await confirmed
		// The server's list keeps its size; the optimistic one had one more.
		const confirmedAt = await until(
			container,
			() => count(container, 'li') === LIST_SIZE && first() === 'fresh',
		)
		const roundTrip = { ms: confirmedAt - start, renders: 0, commits: counters.commits }
		return { 'optimistic shown': shown, 'mutation confirmed': roundTrip }
	})

const pagination: Scenario = (binding) =>
	session(binding, async ({ instance, container }) => {
		const handle: Handle = {}
		const pageSize = 25
		const first = await measure(
			container,
			() => instance.pages(pageSize, handle),
			() => count(container, 'li') === pageSize,
		)
		const more = await measure(
			container,
			() => handle.loadMore!(pageSize),
			() => count(container, 'li') === pageSize * 2,
		)
		return { 'first page': first, 'load more': more }
	})

const allScenarios = { distinctQueries, sharedQuery, optimisticMutation, pagination }

const selected = <T,>(entries: Array<[string, T]>, names: string[] | undefined) =>
	entries.filter(([name]) => !names || names.includes(name)).map(([, value]) => value)

// Without React there are no commits to count.
const withCommits = (binding: Binding, sample: Sample): Sample =>
	binding.commits ? sample : { ...sample, commits: Number.NaN }

const record = (results: Results, binding: Binding, samples: Record<string, Sample>) => {
	for (const [name, sample] of Object.entries(samples)) {
		;((results[name] ??= {})[binding.label] ??= []).push(withCommits(binding, sample))
	}
}

// Rotates which binding goes first.
const orderFor = (iteration: number, bindings: Binding[]) => {
	const shift = iteration % bindings.length
	return [...bindings.slice(shift), ...bindings.slice(0, shift)]
}

async function runRound(config: Config, sink: Results, order: Binding[], scenarios: Scenario[]) {
	const runs = scenarios.flatMap((scenario) => order.map((binding) => [scenario, binding] as const))
	for (const [scenario, binding] of runs) record(sink, binding, await scenario(binding, config))
}

async function runBenchmarks(config: Config): Promise<Results> {
	const results: Results = {}
	const { bindings: bindingNames, scenarios: scenarioNames } = config.only ?? {}
	const bindings = selected(
		allBindings.map((binding) => [binding.label, binding]),
		bindingNames,
	)
	const scenarios = selected(Object.entries(allScenarios), scenarioNames)
	for (let iteration = 0; iteration < config.warmup + config.iterations; iteration++) {
		// Warmup samples go to a throwaway record.
		const sink = iteration >= config.warmup ? results : {}
		await runRound(config, sink, orderFor(iteration, bindings), scenarios)
	}
	return results
}

Object.assign(window, { runBenchmarks })
