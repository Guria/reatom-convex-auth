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
			const resolved = await this.resolve(
				source,
				path.join(pkg.startsWith('@reatom/') ? preview : import.meta.dirname, 'package.json'),
				{ skipSelf: true },
			)
			if (!resolved) throw new Error(`Missing preview ${source}. See packages/bench/README.md`)
			const packageRoot = resolved.id.slice(
				0,
				resolved.id.indexOf(`/node_modules/${pkg}/`) + `/node_modules/${pkg}`.length,
			)
			if (copies.has(pkg) && copies.get(pkg) !== packageRoot)
				throw new Error(`Two copies of ${pkg}`)
			copies.set(pkg, packageRoot)
			modules.set(resolved.id, sha256(resolved.id))
			if (
				source === '@reatom/jsx/jsx-runtime' &&
				!/export\s*\{[^}]*\bjsx\b/.test(readFileSync(resolved.id, 'utf8'))
			)
				return path.join(import.meta.dirname, 'reatomJsxRuntime.ts')
			return resolved
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
