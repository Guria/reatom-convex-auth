import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const VERSION = '1.48.0'
const PATCH = path.join(import.meta.dirname, '../convex.patch')
const ROOT = path.resolve(import.meta.dirname, '../../../.var/convex-patched')

const installedConvex = () => {
	const entry = createRequire(import.meta.url).resolve('convex/values')
	const end = entry.lastIndexOf('/node_modules/convex/')
	if (end < 0) throw new Error(`convex resolved outside node_modules: ${entry}`)
	return entry.slice(0, end + '/node_modules/convex'.length)
}

/**
 * Copies the installed convex ESM build to `root/node_modules/convex` and
 * applies `convex.patch`. Resolving `convex/*` from `root/package.json` then
 * finds the copy. The copy is reused while the patch and source are the same.
 */
export function patchedConvex(root = ROOT) {
	const source = installedConvex()
	const { version } = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8')) as {
		version: string
	}
	if (version !== VERSION) throw new Error(`convex.patch targets ${VERSION}, found ${version}`)
	const patch = readFileSync(PATCH)
	const stamp = createHash('sha256').update(patch).update(source).digest('hex')
	const target = path.join(root, 'node_modules', 'convex')
	const stampFile = path.join(root, 'stamp')
	if (existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp) return root
	rmSync(root, { recursive: true, force: true })
	mkdirSync(target, { recursive: true })
	cpSync(path.join(source, 'package.json'), path.join(target, 'package.json'))
	cpSync(path.join(source, 'dist', 'esm'), path.join(target, 'dist', 'esm'), { recursive: true })
	execFileSync('patch', ['-p1', '--forward', '--silent', '-d', target, '-i', PATCH])
	writeFileSync(path.join(root, 'package.json'), '{ "private": true, "type": "module" }\n')
	writeFileSync(stampFile, stamp)
	return root
}

/** The patched copy's file for a `convex/*` ESM entry, e.g. `browser/index.js`. */
export const patchedConvexFile = (root: string, entry: string) =>
	path.join(root, 'node_modules', 'convex', 'dist', 'esm', entry)
