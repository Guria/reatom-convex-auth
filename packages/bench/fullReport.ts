import type { FullResult } from './full'

const fmt = (ms: number) => (ms < 1 ? ms.toFixed(3) : ms < 10 ? ms.toFixed(2) : ms.toFixed(1))
const kib = (bytes: number) => (bytes / 1024).toFixed(1)
const escape = (value: string) =>
	value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')

export function renderFullReport(result: FullResult) {
	const table = (size: number, shape: string, group: string) => {
		const rows = result.summary.filter(
			(r) => r.size === size && r.shape === shape && r.group === group,
		)
		const modes = [...new Set(rows.map((r) => r.mode))]
		const metrics = [...new Set(rows.map((r) => r.metric))]
		return [
			`| Scenario, ms median [IQR]; p95 | ${modes.join(' | ')} |`,
			`|---|${modes.map(() => '---:').join('|')}|`,
			...metrics.map(
				(metric) =>
					`| ${metric} | ${modes
						.map((mode) => {
							const r = rows.find(
								(candidate) => candidate.mode === mode && candidate.metric === metric,
							)!
							return `${fmt(r.median)} [${fmt(r.q1)}, ${fmt(r.q3)}]; ${fmt(r.p95)}`
						})
						.join(' | ')} |`,
			),
		].join('\n')
	}
	const markdown = [
		'# PR #211 vs the Reatom-native rewrite',
		'',
		`Measured ${result.date}. ${result.environment.cpu}, ${result.environment.os}, Chromium ${result.environment.browser}.`,
		`${result.config.iterations} measured iterations after ${result.config.warmup} warmups at each N. React production without the profiling build.`,
		'',
		'## What each column runs',
		'',
		...result.modes.map((mode) => `- \`${mode.id}\`: ${mode.label}.`),
		'- `pr-base`: PR #211 BaseConvexClient with token-indexed callbacks, no UI.',
		'- `native-base`: the rewrite through its BaseConvexClient compatibility adapter, same callback dispatcher.',
		'- `native-atoms`: direct query data atom subscriptions, no UI.',
		'',
		'## Revisions',
		'',
		...result.artifacts.map(
			(a) =>
				`- ${a.label}: \`${a.commit}\`, tarball SHA-256 \`${a.sha256}\`, compiled ESM SHA-256 \`${a.esmSha256}\`.`,
		),
		`- Reatom core, React and JSX: ${result.reatom.spec}. One copy of each package per page. The module hashes and npm integrity lock hash are in the raw samples.`,
		'',
		'## Method and limits',
		'',
		'- The same in-page websocket server and data run for both SDKs. It serializes JSON and schedules each frame on a later macrotask. No network latency or backend execution is measured.',
		'- Both per-message and coalesced query-set responses run, with their order alternating. Modes and scenario order rotate each iteration. No parallel benchmarks or CPU throttling.',
		'- DOM timings end when all expected nodes have the expected values. Client-only timings include server work, message scheduling and the normal asynchronous atom notifications.',
		'- Sparse updates still re-evaluate all live queries on the fake server, but send only changed values. They are end-to-end local latency, not isolated client CPU.',
		'- Every sample creates a fresh client and server. Mutation and pagination rows use a fixed 100-item list and 25-item pages, so only run at N=1000. Mutations/actions issue 100 concurrent requests without live queries. Optimistic tests issue ten concurrent mutations with N queries live and validate the confirmed result.',
		'- SDK-only shared-query tests assert exactly one server subscription. Churn replaces 10% of the IDs, waits for all values and checks the live subscription count.',
		'- Memory is a separate three-repeat pass. CDP forces GC before, during and after the view. Live JS heap deltas include client, fake server and renderer. Retained deltas after one cleanup are not a leak proof. Browser DOM counts include internal/detached nodes.',
		'- Ratios are rewrite/PR. Paired iteration bootstrap intervals describe this run, not confidence across machines. Differences below 10% and sub-0.3 ms results should not drive decisions.',
		'- This is not a full parity test, auth/reconnect performance test, real-backend test or production reliability claim.',
		'',
		'## Runtime',
		'',
		...result.config.sizes.flatMap((size) =>
			['view', 'client'].flatMap((group) =>
				['per-message', 'coalesced'].flatMap((shape) => [
					`### ${group}, N=${size}, ${shape}`,
					'',
					table(size, shape, group),
					'',
				]),
			),
		),
		'## Bundle size',
		'',
		'Feature-matched production apps: auth, connection state, skippable query, optimistic mutation and pagination. React production here, independent of runtime instrumentation.',
		'',
		'| App | min KiB | gzip KiB | Brotli KiB |',
		'|---|---:|---:|---:|',
		...result.bundles.map(
			(r) => `| ${r.label} | ${kib(r.min)} | ${kib(r.gzip)} | ${kib(r.brotli)} |`,
		),
		'',
		'## Reproduce',
		'',
		'```sh',
		'mise run bench:full --write',
		'```',
		'',
		'Prepare the two verified tarballs in `full.lock.json` and the pinned preview packages first. See README.md. `FULL_SAMPLES.json.gz` holds every raw timing, counters, heap measurement and build hash. `RESULTS_FULL.html` is the interactive report.',
		'',
	].join('\n')
	// Keep only the selected size in the inline view's data. The full report has all measurements.
	const display = {
		config: result.config,
		modes: result.modes,
		summary: result.summary,
		bundles: result.bundles,
		memory: result.memory,
		environment: result.environment,
		artifacts: result.artifacts.map(({ label, commit }) => ({ label, commit })),
	}
	const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;font:14px var(--font-sans,system-ui);color:var(--foreground);line-height:1.5}h1{font-size:27px;line-height:1.15;margin:0 0 10px}h2{font-size:18px;margin:0 0 12px}p{margin:8px 0;color:var(--muted-foreground)}small{font-size:11px;color:var(--muted-foreground)}.tag{font:11px var(--font-mono,monospace);color:var(--muted-foreground);letter-spacing:.06em;margin:4px 0 10px}.controls{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0}select,button{font:inherit;color:var(--foreground);background:var(--secondary);border:1px solid var(--border);border-radius:8px;padding:7px 10px}.panel{background:var(--card);border:1px solid var(--border);padding:16px;border-radius:var(--radius,12px);margin:14px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.barrow{margin:14px 0}.barhead{display:flex;justify-content:space-between;gap:8px;font-size:12px}.track{height:12px;background:var(--secondary);border-radius:3px;margin:5px 0}.fill{height:100%;border-radius:3px;background:var(--chart-1)}.native{background:var(--chart-2)}.legend{display:flex;gap:18px;font-size:12px;align-items:center}.dot{width:9px;height:9px;display:inline-block;border-radius:50%;margin-right:5px;background:var(--chart-1)}.dot.n{background:var(--chart-2)}.numbers{font:12px var(--font-mono,monospace)}table{width:100%;border-collapse:collapse;font-size:12px}td,th{padding:8px 5px;text-align:right;border-bottom:1px solid var(--border)}td:first-child,th:first-child{text-align:left}svg{width:100%;height:210px;overflow:visible}svg text{fill:var(--muted-foreground);font:11px var(--font-sans,system-ui)}.hidden{display:none}.scroll{overflow-x:auto}.foot{font-size:12px;margin:14px 0}.kpi{font-size:25px;color:var(--foreground);font-weight:650}.bad{color:var(--warning)}@media(max-width:520px){.grid{grid-template-columns:1fr}h1{font-size:23px}}
</style></head><body>
<div class="tag">MEASURED COMPARISON · ${escape(result.date.slice(0, 10))}</div>
<h1>PR #211 vs Reatom-native</h1><p id="conclusion"></p>
<div class="controls"><select id="pair" aria-label="Consumption path"><option value="react">Existing convex/react API</option><option value="reatom">Reatom consumers + React</option><option value="jsx">Reatom consumers + JSX</option><option value="base">SDK only · compatibility API</option><option value="atoms">SDK only · direct atoms</option></select><select id="size" aria-label="Query count">${result.config.sizes.map((n) => `<option value="${n}" ${n === 1000 ? 'selected' : ''}>${n.toLocaleString()} queries</option>`).join('')}</select><select id="shape" aria-label="Server responses"><option>per-message</option><option>coalesced</option></select></div>
<div class="legend"><span><i class="dot"></i>PR #211</span><span><i class="dot n"></i>Reatom-native rewrite</span><small>Lower is better</small></div>
<div class="panel"><h2 id="path"></h2><div id="hero" class="grid"></div><small>Median milliseconds. Brackets in the table give the interquartile range. Each point has ${result.config.iterations} measured runs.</small></div>
<div class="panel"><h2>How mount scales</h2><svg id="scale" role="img" aria-label="Mount latency across query counts"></svg><small>Linear axes. The consumer path and response mode above also apply here.</small></div>
<div class="panel"><h2>All measured operations</h2><div class="scroll"><table><thead><tr><th>Operation</th><th>PR ms [IQR]</th><th>Rewrite ms [IQR]</th><th>Rewrite / PR</th><th>Paired 95% interval</th></tr></thead><tbody id="rows"></tbody></table></div></div>
<div class="grid"><div class="panel"><h2>Bundle cost</h2><div id="bundle"></div><small>Whole feature-matched app, gzip KiB. Comparing JSX with React also changes the renderer.</small></div><div class="panel"><h2>Live JS heap</h2><div id="heap"></div><small>Median of 3 GC probes, MiB above an empty page. Includes fake server and renderer. SDK-only paths are not probed.</small></div></div>
<details class="panel"><summary>Method, counters and exact revisions</summary><p>${escape(result.environment.cpu)}, ${escape(result.environment.os)}. Chromium ${escape(result.environment.browser)}. React production without profiling. Reatom preview <code>5f42184</code>, one copy per package.</p><p>${result.config.warmup} warmups per N. Mode and scenario orders rotate. Both server response shapes run. No network, real backend, auth/reconnect measurement or CPU throttling.</p><p>Sparse updates include the fake server's full query re-evaluation. Client-only samples also include message scheduling and observer notification. Fixed-size mutation and pagination view scenarios run at N=1000 only.</p><p>Intervals resample paired iterations, not machines. Differences below 10% and times below 0.3 ms can be noise. Memory deltas are not leak tests.</p><div id="counters"></div>${display.artifacts.map((a) => `<p>${escape(a.label)}<br><code>${a.commit}</code></p>`).join('')}</details>
<script>const data=${JSON.stringify(display).replaceAll('<', '\\u003c')};
const $=id=>document.getElementById(id);const f=n=>n<1?n.toFixed(3):n<10?n.toFixed(2):n.toFixed(1);const med=v=>{v=[...v].sort((a,b)=>a-b);return v[Math.floor(v.length/2)]};
function selection(){const pair=$('pair').value;const group=pair==='base'||pair==='atoms'?'client':'view';return{group,size:+$('size').value,shape:$('shape').value,pr:group==='client'?'pr-base':'pr-'+pair,native:group==='client'?'native-'+pair:'native-'+pair}}
function bars(a,b,label,unit='ms'){const max=Math.max(a,b)||1;return '<div class="barrow"><div class="barhead"><strong>'+label+'</strong><span class="numbers">'+f(a)+' / '+f(b)+' '+unit+'</span></div><div class="track"><div class="fill" style="width:'+a/max*100+'%"></div></div><div class="track"><div class="fill native" style="width:'+b/max*100+'%"></div></div></div>'}
function render(){const s=selection();const rows=data.summary.filter(r=>r.size===s.size&&r.shape===s.shape&&r.group===s.group);const pairs=rows.filter(r=>r.mode===s.pr).map(a=>[a,rows.find(b=>b.mode===s.native&&b.metric===a.metric)]).filter(p=>p[1]);const mount=s.group==='view'?'mount':'subscribe distinct';const metrics=s.group==='view'?['mount','update all','update one','unmount']:['subscribe distinct','update all','update one','unsubscribe distinct'];const m=pairs.find(p=>p[0].metric===mount);const delta=m[1].median/m[0].median;
$('conclusion').textContent=(delta<.9?'The rewrite mounts '+(1/delta).toFixed(2)+'× faster':delta>1.1?'PR #211 mounts '+delta.toFixed(2)+'× faster':'Mount is within 10%')+' on this path. Switch the consumer path before drawing a general conclusion.';
$('path').textContent=$('pair').selectedOptions[0].textContent;
$('hero').innerHTML=metrics.map(metric=>{const p=pairs.find(p=>p[0].metric===metric);return p?bars(p[0].median,p[1].median,metric):''}).join('');
$('rows').innerHTML=pairs.map(([a,b])=>'<tr><td>'+a.metric+'</td><td>'+f(a.median)+' ['+f(a.q1)+', '+f(a.q3)+']</td><td>'+f(b.median)+' ['+f(b.q1)+', '+f(b.q3)+']</td><td>'+((b.relative||{}).ratio||b.median/a.median).toFixed(2)+'×</td><td>'+(b.relative?'['+b.relative.low.toFixed(2)+', '+b.relative.high.toFixed(2)+']':'')+'</td></tr>').join('');
const a=data.summary.filter(r=>r.mode===s.pr&&r.metric===mount&&r.shape===s.shape&&r.group===s.group);const b=data.summary.filter(r=>r.mode===s.native&&r.metric===mount&&r.shape===s.shape&&r.group===s.group);const maxY=Math.max(...a.concat(b).map(r=>r.median))*1.15;const maxX=Math.max(...data.config.sizes);const x=n=>48+n/maxX*540,y=n=>174-n/maxY*145;
$('scale').setAttribute('viewBox','0 0 620 210');$('scale').innerHTML='<title>Mount latency by query count</title><desc>PR #211 and Reatom-native, median milliseconds</desc>'+[0,.5,1].map(v=>'<line x1="48" x2="588" y1="'+y(v*maxY)+'" y2="'+y(v*maxY)+'" stroke="var(--border)"/><text x="5" y="'+(y(v*maxY)+4)+'">'+f(v*maxY)+'</text>').join('')+data.config.sizes.filter(n=>n>=100).map(n=>'<text x="'+x(n)+'" y="197" text-anchor="middle">'+n+'</text>').join('')+[a,b].map((list,i)=>'<polyline fill="none" stroke="var(--chart-'+(i+1)+')" stroke-width="2.5" points="'+list.map(r=>x(r.size)+','+y(r.median)).join(' ')+'"/>'+list.map(r=>'<circle cx="'+x(r.size)+'" cy="'+y(r.median)+'" r="3.5" fill="var(--chart-'+(i+1)+')"><title>N='+r.size+': '+f(r.median)+' ms</title></circle>').join('')).join('');
const pair=$('pair').value;const bundleA=data.bundles.find(r=>r.id==='pr-'+pair),bundleB=data.bundles.find(r=>r.id==='native-'+pair);$('bundle').innerHTML=bundleA&&bundleB?bars(bundleA.gzip/1024,bundleB.gzip/1024,'Feature-matched app','KiB'):'Select a renderer path for bundle sizes.';const heap=id=>data.memory.filter(r=>r.mode===id&&r.size===s.size).map(r=>r.liveBytes/1048576);const ha=heap(s.pr),hb=heap(s.native);$('heap').innerHTML=ha.length?bars(med(ha),med(hb),'Mounted view','MiB'):'SDK-only heap was not probed.';
const mountPair=pairs.find(p=>p[0].metric===mount);$('counters').innerHTML='<p>Mount transitions, PR / rewrite: <b>'+mountPair.map(r=>r.transitions??'not recorded').join(' / ')+'</b>. '+(s.group==='client'?'Query adds: '+mountPair.map(r=>r.adds).join(' / ')+'. Query-set messages: '+mountPair.map(r=>r.querySetMessages).join(' / ')+'.':'')+'</p>';
}['pair','size','shape'].forEach(id=>$(id).addEventListener('change',render));render();</script>
</body></html>`
	return { markdown, html }
}
