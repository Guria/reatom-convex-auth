import type { FullResult, FullSummary } from './full'

const number = (n: number) => (n < 1 ? n.toFixed(3) : n < 10 ? n.toFixed(2) : n.toFixed(1))
const label = (mode: string) =>
	({
		'pr-react': 'PR #211, existing convex/react',
		'native-react': 'Native, compatibility convex/react',
		'pr-plain': 'PR #211, plain store',
		'native-plain': 'Native, plain store',
		'pr-base': 'PR #211 BaseConvexClient',
		'native-base': 'Native BaseConvexClient compatibility',
	})[mode] ?? mode

/** All operations get equal space; the default chart is no longer a mount-only scaling plot. */
export function renderPlainReport(result: FullResult) {
	const table = (group: string, size: number, shape: string) => {
		const rows = result.summary.filter(
			(r) => r.group === group && r.size === size && r.shape === shape,
		)
		const modes =
			group === 'view'
				? result.modes.map((m) => m.id)
				: ['pr-base', 'native-base', 'pr-plain', 'native-plain']
		return [
			`| Operation, ms | ${modes.map(label).join(' | ')} |`,
			`|---|${modes.map(() => '---:').join('|')}|`,
			...[...new Set(rows.map((r) => r.metric))].map(
				(metric) =>
					`| ${metric} | ${modes
						.map((mode) => {
							const r = rows.find((row) => row.mode === mode && row.metric === metric)!
							return `${number(r.median)} [${number(r.q1)}, ${number(r.q3)}]; p95 ${number(r.p95)}`
						})
						.join(' | ')} |`,
			),
		].join('\n')
	}
	const heap = (size: number, mode: string, key: 'liveBytes' | 'retainedBytes') => {
		const values = result.memory
			.filter((r) => r.size === size && r.mode === mode)
			.map((r) => r[key])
			.sort((a, b) => a - b)
		return values[Math.floor(values.length / 2)]! / 2 ** 20
	}
	const memoryTable = [
		'| N | Path | Live heap MiB | After cleanup MiB |',
		'|---:|---|---:|---:|',
		...result.config.sizes.flatMap((size) =>
			result.modes.map(
				({ id }) =>
					`| ${size} | ${label(id)} | ${heap(size, id, 'liveBytes').toFixed(2)} | ${heap(size, id, 'retainedBytes').toFixed(2)} |`,
			),
		),
	].join('\n')
	const markdown = [
		'# Non-Reatom consumers without the compatibility layer',
		'',
		`Measured ${result.date} on ${result.environment.cpu}, ${result.environment.os}, Chromium ${result.environment.browser}.`,
		`${result.config.iterations} measured iterations after ${result.config.warmup} warmups at each N; ${result.records.length} timing samples.`,
		'',
		'## What is being compared',
		'',
		'- PR #211 through its existing `convex/react` API, and the native rewrite through its existing Convex compatibility clients. These are controls, not the proposed path.',
		'- PR #211 and the native rewrite through exactly the same `useSyncExternalStore` React consumer. Components import no Reatom APIs. No `@reatom/react`, `ConvexReactClient`, `BaseConvexClient` or `ConvexClient` runs on the native plain path.',
		'- `plainClient.ts` owns one Reatom frame internally. Its query stores subscribe directly to the public result atom. `getSnapshot`, `subscribe`, `onUpdate`, commands and cleanup are ordinary functions. The runtime still depends on Reatom.',
		'- The PR plain control dispatches BaseConvexClient transitions by query token rather than scanning every listener. Pagination uses the SDK core pagination client. Both plain paths render the same React items and keyed lists.',
		'- Callback-only tests compare both plain APIs without a UI, next to the two BaseConvexClient controls. The native plain callback and React paths use the same facade.',
		'',
		'## Coverage and limits',
		'',
		'- Distinct/shared query lifecycle; full, 1% and single-query updates; twenty-transition bursts; replacement of 10% of query IDs; optimistic confirmation; 100 concurrent mutations and actions; first/next page; teardown; live and post-cleanup heap; minified/gzip/Brotli app size.',
		'- Median, IQR and descriptive p95 use raw per-iteration timings. Paired-bootstrap 95% intervals for the ratio of medians appear in the interactive report. One machine is not a population sample. Sub-0.3 ms results and differences below 10% need caution.',
		'- Both query-set response shapes run, with rotating mode and scenario order. Each timing session starts a fresh client and in-page protocol server. Mutation/list/page UI rows have fixed data sizes and run at N=1000. Query count scales the other rows.',
		'- The fake server re-evaluates all queries for an update but transmits only changed results. Latencies include its work and task scheduling, not just client CPU. No network or real backend is measured. Twenty-transition burst means twenty separate wire transitions, not twenty isolated render frames.',
		'- Query stores are intentionally small, client-rendered stores. They are not a complete replacement for Convex React: no SSR snapshots, Suspense, auth provider integration, preloading, query GC policy, or full legacy API parity.',
		'- Auth and pagination have preflight correctness checks, but auth refresh/reconnect speed, long-running throughput, offline persistence, production reliability and exhaustive failure parity are not benchmarked.',
		'- Heap probes force GC outside timed work, three repeats per path and scale. Deltas include server, facade and React allocations. A positive post-cleanup delta does not establish a leak. Negative deltas are GC noise. This is not a long-lived retention test.',
		'',
		'## Native facade integration checks',
		'',
		...(result.checks ?? []).map((s) => `- ${s}`),
		'',
		'## Runtime',
		'',
		...result.config.sizes.flatMap((size) =>
			['per-message', 'coalesced'].flatMap((shape) =>
				['view', 'client'].flatMap((group) => [
					`### ${group}, N=${size}, ${shape}`,
					'',
					table(group, size, shape),
					'',
				]),
			),
		),
		'## Memory',
		'',
		memoryTable,
		'',
		'## Bundle size',
		'',
		'Plain apps use the same React consumer and include authentication state, connection state, a skippable query, an optimistic mutation and pagination. Existing-hook apps remain separate controls. The plain apps do not render refresh state. All use production React; no profiling build.',
		'',
		'| App | Min KiB | gzip KiB | Brotli KiB |',
		'|---|---:|---:|---:|',
		...result.bundles.map(
			(r) =>
				`| ${r.label} | ${(r.min / 1024).toFixed(2)} | ${(r.gzip / 1024).toFixed(2)} | ${(r.brotli / 1024).toFixed(2)} |`,
		),
		'',
		'## Exact builds',
		'',
		...result.artifacts.map(
			(a) =>
				`- ${a.label}: \`${a.commit}\`, archive SHA-256 \`${a.sha256}\`, ESM SHA-256 \`${a.esmSha256}\`.`,
		),
		`- Reatom v1001 preview: ${result.reatom.spec}. React and React DOM resolve to one copy. Source revision: \`${result.environment.revision}\`.`,
		'',
		'```sh',
		'mise run bench:plain --write',
		'```',
		'',
		'`PLAIN_SAMPLES.json.gz` includes every sample, counters, heap measurement, bootstrap interval and source hash. `RESULTS_PLAIN.html` is the interactive scorecard. These results do not overwrite the earlier full comparison.',
		'',
	].join('\n')
	const compact = (r: FullSummary) => ({
		...r,
		median: +r.median.toPrecision(7),
		q1: +r.q1.toPrecision(7),
		q3: +r.q3.toPrecision(7),
		p95: +r.p95.toPrecision(7),
	})
	const data = {
		sizes: result.config.sizes,
		rows: result.summary.map(compact),
		bundles: result.bundles,
		memory: result.memory,
	}
	const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Non-Reatom consumers, no compatibility layer</title><style>
*{box-sizing:border-box}body{margin:0;color:var(--foreground,CanvasText);font:14px var(--font-sans,system-ui);line-height:1.5}h1{font-size:26px;line-height:1.15;margin:0 0 10px}h2{font-size:17px;margin:0 0 8px}p{margin:8px 0;color:var(--muted-foreground,GrayText)}small{font-size:11px;color:var(--muted-foreground,GrayText)}.box{background:var(--card,Canvas);padding:16px;border-radius:var(--radius,10px);border:1px solid var(--border,ButtonBorder);margin:16px 0}.controls{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}select{background:var(--secondary,ButtonFace);color:inherit;font:inherit;border:1px solid var(--border,ButtonBorder);border-radius:6px;padding:7px}.legend{font-size:12px;display:flex;gap:18px;margin:12px 0}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--chart-1,LinkText);margin-right:5px}.dot.n{background:var(--chart-2,VisitedText)}.chart{display:grid;grid-template-columns:1fr 1fr;gap:14px 22px}.metric{font-size:12px}.line{display:flex;justify-content:space-between;gap:8px}.num{font-family:var(--font-mono,monospace);white-space:nowrap}.track{height:8px;background:var(--secondary,ButtonFace);margin:5px 0;border-radius:3px}.fill{height:100%;background:var(--chart-1,LinkText);border-radius:3px}.fill.n{background:var(--chart-2,VisitedText)}.scroll{overflow-x:auto}table{border-collapse:collapse;font-size:12px;width:100%}td,th{padding:7px 5px;text-align:right;border-bottom:1px solid var(--border,ButtonBorder)}td:first-child,th:first-child{text-align:left}svg{width:100%;height:210px}svg text{fill:var(--muted-foreground,GrayText);font:11px var(--font-sans,system-ui)}details{font-size:12px}@media(max-width:530px){.chart{grid-template-columns:1fr}h1{font-size:23px}}
</style></head><body><h1>Ordinary consumers, no legacy layer</h1><p>The native client still uses Reatom internally. Consumers use callbacks or plain React stores, not atoms, frames or Reatom components.</p><small>${result.records.length.toLocaleString()} samples · ${result.config.iterations} measured + ${result.config.warmup} warmups · ${result.environment.cpu} · Chromium ${result.environment.browser}</small><div class="controls"><select id="group" aria-label="Consumer"><option value="view">Same ordinary React hooks</option><option value="client">Callbacks, no renderer</option></select><select id="size" aria-label="Queries">${result.config.sizes.map((n) => `<option value="${n}" ${n === 1000 ? 'selected' : ''}>${n} queries</option>`).join('')}</select><select id="shape" aria-label="Responses"><option>per-message</option><option>coalesced</option></select><select id="stat" aria-label="Statistic"><option value="median">Median</option><option value="p95">p95</option></select></div><div class="legend"><span><i class="dot"></i>PR #211 plain store</span><span><i class="dot n"></i>Native plain store</span><small>Lower is better · ms</small></div><div class="box"><h2>Lifecycle, steady state and write paths</h2><div id="bars" class="chart"></div></div><div class="box"><h2>Scale any operation, not only mount</h2><select id="metric" aria-label="Operation"></select><svg id="scale" role="img" aria-label="Operation latency across query counts"></svg></div><div class="box"><h2>Same-run legacy API controls</h2><small>Existing convex/react and matched plain React consumer. For callback tests, controls are BaseConvexClient.</small><div class="scroll"><table><thead id="head"></thead><tbody id="table"></tbody></table></div></div><div class="box"><h2>Memory and bundle cost</h2><div id="cost"></div><small>Heap is median of three GC probes, includes the fake server and renderer. After-cleanup deltas are not proof of leaks. App size is gzip.</small></div><details class="box"><summary>Method, bootstrap intervals and limitations</summary><p>All times include in-page websocket protocol work, fake-server query evaluation, JSON and task scheduling. No network or real backend. Sparse updates still evaluate the entire query set on the fake server. Mutation/page UI rows use fixed-size fixtures at N=1000.</p><p>Both plain columns use the same React component, keyed DOM and useSyncExternalStore. The native facade owns its frame and reads public result atoms, without any compatibility classes. React is production, not profiling.</p><p>The interval is a paired bootstrap 95% interval for the ratio of medians, native/PR. It does not quantify variation across machines. Differences below 10% or times below 0.3 ms can be noise. p95 is descriptive from ${result.config.iterations} samples, not a service-level guarantee.</p><div id="ratios"></div><p>Native facade integration checks: ${(result.checks ?? []).length} groups passed. SSR, Suspense, auth provider components, preloading, and full legacy API parity are not provided by this prototype. Auth/reconnect performance and long-lived leak tests were not run.</p><p>PR #211 <code>a5dce54</code> · native <code>9257e2f</code> · Reatom preview <code>5f42184</code>. Both SDKs already batch query-set changes.</p></details><script>
const data=${JSON.stringify(data).replaceAll('<', '\\u003c')};const $=id=>document.getElementById(id),f=n=>n<1?n.toFixed(3):n<10?n.toFixed(2):n.toFixed(1);const rows=()=>data.rows.filter(r=>r.group===$('group').value&&r.size===+$('size').value&&r.shape===$('shape').value);const med=v=>{v=[...v].sort((a,b)=>a-b);return v[Math.floor(v.length/2)]};
function chart(){const group=$('group').value,shape=$('shape').value,metric=$('metric').value,stat=$('stat').value;const lists=['pr-plain','native-plain'].map(mode=>data.rows.filter(r=>r.mode===mode&&r.group===group&&r.shape===shape&&r.metric===metric));const max=Math.max(...lists.flat().map(r=>r[stat]))*1.1||1,x=n=>45+n/Math.max(...data.sizes)*550,y=n=>175-n/max*145;$('scale').setAttribute('viewBox','0 0 620 210');$('scale').innerHTML='<title>'+metric+' by query count</title><desc>PR #211 and native, '+stat+' milliseconds</desc>'+[0,.5,1].map(v=>'<line x1="45" x2="595" y1="'+y(v*max)+'" y2="'+y(v*max)+'" stroke="var(--border,ButtonBorder)"/><text x="2" y="'+(y(v*max)+4)+'">'+f(v*max)+'</text>').join('')+data.sizes.filter(n=>n>=100).map(n=>'<text x="'+x(n)+'" y="200" text-anchor="middle">'+n+'</text>').join('')+lists.map((list,i)=>'<polyline fill="none" stroke="var(--chart-'+(i+1)+','+(i?'VisitedText':'LinkText')+')" stroke-width="2.5" points="'+list.map(r=>x(r.size)+','+y(r[stat])).join(' ')+'"/>'+list.map(r=>'<circle r="3.5" cx="'+x(r.size)+'" cy="'+y(r[stat])+'" fill="var(--chart-'+(i+1)+','+(i?'VisitedText':'LinkText')+')"><title>N='+r.size+': '+f(r[stat])+' ms</title></circle>').join('')).join('')}
function render(){const all=rows(),stat=$('stat').value;const pr=all.filter(r=>r.mode==='pr-plain'),pairs=pr.map(a=>[a,all.find(b=>b.mode==='native-plain'&&b.metric===a.metric)]);$('bars').innerHTML=pairs.map(([a,b])=>{const x=a[stat],y=b[stat],max=Math.max(x,y)||1;return '<div class="metric"><div class="line"><strong>'+a.metric+'</strong><span class="num">'+f(x)+' / '+f(y)+'</span></div><div class="track"><div class="fill" style="width:'+x/max*100+'%"></div></div><div class="track"><div class="fill n" style="width:'+y/max*100+'%"></div></div></div>'}).join('');const old=$('metric').value;$('metric').innerHTML=pr.map(a=>'<option>'+a.metric+'</option>').join('');if(pr.some(a=>a.metric===old))$('metric').value=old;else if(pr.some(a=>a.metric==='update all'))$('metric').value='update all';const modes=$('group').value==='view'?['pr-react','native-react','pr-plain','native-plain']:['pr-base','native-base','pr-plain','native-plain'];$('head').innerHTML='<tr><th>Operation</th><th>PR legacy</th><th>Native compat</th><th>PR plain</th><th>Native plain</th></tr>';$('table').innerHTML=pr.map(a=>'<tr><td>'+a.metric+'</td>'+modes.map(mode=>{const r=all.find(r=>r.mode===mode&&r.metric===a.metric);return '<td>'+f(r[stat])+'</td>'}).join('')+'</tr>').join('');$('ratios').innerHTML='<table><tr><th>Operation</th><th>Native/PR</th><th>95% interval</th></tr>'+pairs.map(([a,b])=>'<tr><td>'+a.metric+'</td><td>'+b.relative.ratio.toFixed(2)+'×</td><td>['+b.relative.low.toFixed(2)+', '+b.relative.high.toFixed(2)+']</td></tr>').join('')+'</table>';const costs=['pr-plain','native-plain'].map(mode=>{const probes=data.memory.filter(r=>r.mode===mode&&r.size===+$('size').value),bundle=data.bundles.find(r=>r.id===mode);return {mode,live:med(probes.map(r=>r.liveBytes))/1048576,after:med(probes.map(r=>r.retainedBytes))/1048576,bundle:bundle.gzip/1024}});$('cost').innerHTML='<table><tr><th>Path</th><th>Live MiB</th><th>After cleanup</th><th>gzip KiB</th></tr>'+costs.map(r=>'<tr><td>'+r.mode+'</td><td>'+f(r.live)+'</td><td>'+f(r.after)+'</td><td>'+f(r.bundle)+'</td></tr>').join('')+'</table>';chart()}
['group','size','shape','stat'].forEach(id=>$(id).addEventListener('change',render));$('metric').addEventListener('change',chart);render();</script></body></html>`
	return { markdown, html }
}
