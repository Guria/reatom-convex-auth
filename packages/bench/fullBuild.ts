import type { Plugin } from 'vite'

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const preview = path.join(root, '.var/bench/preview')
const packages = ['@reatom/core', '@reatom/react', '@reatom/jsx', 'react', 'react-dom']
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** Every Reatom import, including those inside a fork, uses the same pinned preview. */
export function fullReatom() {
	const expected = JSON.parse(
		readFileSync(path.join(import.meta.dirname, 'preview.lock.json'), 'utf8'),
	)
	const installed = JSON.parse(readFileSync(path.join(preview, 'package-lock.json'), 'utf8'))
	if (JSON.stringify(expected) !== JSON.stringify(installed))
		throw new Error('Preview integrity lock differs from preview.lock.json')
	const modules = new Map<string, string>()
	const copies = new Map<string, string>()
	const recordModule = (pkg: string, id: string) => {
		const end = id.indexOf(`/node_modules/${pkg}/`)
		if (end < 0) throw new Error(`${pkg} resolved outside node_modules`)
		const packageRoot = id.slice(0, end + `/node_modules/${pkg}`.length)
		if (copies.has(pkg) && copies.get(pkg) !== packageRoot) throw new Error(`Two copies of ${pkg}`)
		copies.set(pkg, packageRoot)
		modules.set(id, sha256(id))
	}
	const runtimeEntry = (source: string, id: string) => {
		if (source !== '@reatom/jsx/jsx-runtime') return id
		if (/export\s*\{[^}]*\bjsx\b/.test(readFileSync(id, 'utf8'))) return id
		return path.join(import.meta.dirname, 'reatomJsxRuntime.ts')
	}
	const importer = (pkg: string) =>
		path.join(pkg.startsWith('@reatom/') ? preview : import.meta.dirname, 'package.json')
	const plugin: Plugin = {
		name: 'full-benchmark-reatom-preview',
		enforce: 'pre',
		async resolveId(source) {
			if (source.startsWith('convex-patched/'))
				return this.resolve(
					source.replace('convex-patched/', 'convex/'),
					path.join(import.meta.dirname, 'package.json'),
					{ skipSelf: true },
				)
			const pkg = packages.find(
				(candidate) => source === candidate || source.startsWith(`${candidate}/`),
			)
			if (!pkg) return
			const resolved = await this.resolve(source, importer(pkg), { skipSelf: true })
			if (!resolved) throw new Error(`Missing preview ${source}. See packages/bench/README.md`)
			recordModule(pkg, resolved.id)
			return runtimeEntry(source, resolved.id)
		},
	}
	return {
		plugin,
		provenance: () => ({
			spec: 'https://pkg.pr.new/@reatom/{core,react,jsx}@5f42184',
			lockSha256: sha256(path.join(preview, 'package-lock.json')),
			modules: [...modules].map(([file, hash]) => ({
				file: path.relative(root, file),
				sha256: hash,
			})),
		}),
	}
}
