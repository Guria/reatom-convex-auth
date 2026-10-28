// Load immutable npm-pack outputs, never another thread's mutable dist/.
import type { Plugin } from 'vite'

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const ROOT = path.resolve(import.meta.dirname, '../..')
const artifactSchema = z.object({
	id: z.string(),
	label: z.string(),
	threadId: z.string(),
	repository: z.string(),
	commit: z.string().regex(/^[a-f0-9]{40}$/),
	archive: z.string(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
const sdkSchema = artifactSchema.extend({ id: z.enum(['batched', 'rewrite', 'atoms']) })
const coreSchema = artifactSchema.extend({ id: z.enum(['action-base', 'action-patch']) })
const lockSchema = z.object({
	convex: z.array(sdkSchema).min(2),
	core: z.array(coreSchema).length(2).optional(),
})
const packageSchema = z.object({
	name: z.enum(['convex', '@reatom/core']),
	version: z.string(),
	dependencies: z.record(z.string(), z.string()).optional(),
})
export type SdkArtifact = z.infer<typeof sdkSchema> & { root: string; esmSha256: string }
export type CoreArtifact = z.infer<typeof coreSchema> & { root: string; esmSha256: string }

const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

/** Hash filenames and bytes of the actual JS consumed by the browser build. */
const treeDigest = (root: string) => {
	const hash = createHash('sha256')
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const file = path.join(directory, entry.name)
			if (entry.isDirectory()) visit(file)
			else if (entry.name.endsWith('.js'))
				hash.update(path.relative(root, file)).update('\0').update(readFileSync(file)).update('\0')
		}
	}
	visit(root)
	return hash.digest('hex')
}

const unpackArtifact = (archive: string, root: string, target: string, directory: string) => {
	const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split('\n')
	if (entries.some((entry) => !entry.startsWith('package/') || entry.split('/').includes('..')))
		throw new Error('Invalid artifact archive paths')
	rmSync(root, { recursive: true, force: true })
	mkdirSync(target, { recursive: true })
	execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', target])
	writeFileSync(path.join(root, 'package.json'), '{"private":true,"type":"module"}\n')
	writeFileSync(path.join(root, 'complete'), treeDigest(path.join(target, directory)))
}

const verifyArchive = (artifact: z.infer<typeof artifactSchema>, archive: string) => {
	if (!existsSync(archive))
		throw new Error(
			`Missing ${artifact.label}: copy its tarball to ${archive}. See packages/bench/README.md`,
		)
	if (digest(readFileSync(archive)) !== artifact.sha256)
		throw new Error(`${artifact.label}: tarball SHA-256 mismatch`)
}

const EXPECTED_VERSION = { convex: '1.48.0', '@reatom/core': '1001.3.0' } as const

const verifyPackage = (target: string, packageName: keyof typeof EXPECTED_VERSION, id: string) => {
	const pkg = packageSchema.parse(
		JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8')),
	)
	if (pkg.name !== packageName || pkg.version !== EXPECTED_VERSION[packageName])
		throw new Error(`Unexpected artifact package ${pkg.name}@${pkg.version}`)
	if ((id === 'rewrite' || id === 'atoms') && !pkg.dependencies?.['@reatom/core'])
		throw new Error('Reatom SDK artifact lacks its runtime dependency')
}

const readArtifact = <Artifact extends z.infer<typeof artifactSchema>>(
	artifact: Artifact,
	workspace: string,
	packageName: keyof typeof EXPECTED_VERSION,
	directory: string,
): Artifact & { root: string; esmSha256: string } => {
	const archive = path.resolve(workspace, artifact.archive)
	verifyArchive(artifact, archive)
	const root = path.join(workspace, '.var/bench/artifacts', artifact.sha256)
	const target = path.join(root, 'node_modules', packageName)
	const stamp = path.join(root, 'complete')
	if (!existsSync(stamp)) unpackArtifact(archive, root, target, directory)
	verifyPackage(target, packageName, artifact.id)
	const esmSha256 = treeDigest(path.join(target, directory))
	if (readFileSync(stamp, 'utf8') !== esmSha256)
		throw new Error(`${artifact.label}: cached ESM contents changed; remove ${root}`)
	return { ...artifact, root, esmSha256 }
}

export function loadArtifacts({
	workspace = ROOT,
	lockFile = path.join(import.meta.dirname, 'artifacts.lock.json'),
} = {}): SdkArtifact[] {
	const lock = lockSchema.parse(JSON.parse(readFileSync(lockFile, 'utf8')))
	if (new Set(lock.convex.map(({ id }) => id)).size !== lock.convex.length)
		throw new Error('Duplicate SDK artifact id')
	return lock.convex.map((artifact) => readArtifact(artifact, workspace, 'convex', 'dist/esm'))
}

export function loadCoreArtifacts(): CoreArtifact[] {
	const lock = lockSchema.parse(
		JSON.parse(readFileSync(path.join(import.meta.dirname, 'artifacts.lock.json'), 'utf8')),
	)
	if (!lock.core || new Set(lock.core.map(({ id }) => id)).size !== 2)
		throw new Error('Missing matched core artifacts')
	return lock.core.map((artifact) => readArtifact(artifact, ROOT, '@reatom/core', 'dist'))
}

/** `convex-artifact-<id>/x` names artifact `<id>`; with an override, so does any `convex/x`. */
const artifactImport = (source: string, override?: string) => {
	const match = /^convex-artifact-(batched|rewrite|atoms)(\/.*|)$/.exec(source)
	if (match) return { id: match[1]!, suffix: match[2]! }
	if (override && /^convex(?:\/|$)/.test(source))
		return { id: override, suffix: source.slice('convex'.length) }
	return undefined
}

/**
 * Resolves `convex-artifact-<id>/*` to the unpacked tarball, or to the stock SDK
 * when no artifacts are loaded. `override` sends plain `convex/*` imports to
 * one artifact, for size builds.
 */
export function artifactPlugin(artifacts: SdkArtifact[], override?: SdkArtifact['id']): Plugin {
	const byId = new Map<string, SdkArtifact>(artifacts.map((artifact) => [artifact.id, artifact]))
	const inArtifact = (id: string, artifact: SdkArtifact | undefined) =>
		!artifact || id.startsWith(`${artifact.root}/node_modules/convex/`)
	return {
		name: 'convex-thread-artifacts',
		enforce: 'pre',
		// Bench-only tarball resolver; the override switch is simpler than a
		// coverage test would be.
		// fallow-ignore-next-line complexity
		async resolveId(source) {
			const target = artifactImport(source, override)
			if (!target) return
			const artifact = byId.get(target.id)
			const importer = path.join(artifact?.root ?? import.meta.dirname, 'package.json')
			const resolved = await this.resolve(`convex${target.suffix}`, importer, { skipSelf: true })
			if (!resolved || !inArtifact(resolved.id, artifact))
				throw new Error(`${source} resolved outside its artifact: ${resolved?.id}`)
			return resolved
		},
	}
}
