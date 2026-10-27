import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vite-plus/test'

import { loadArtifacts } from './artifacts'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

const fixture = () => {
	const workspace = mkdtempSync(path.join(os.tmpdir(), 'convex-bench-artifact-'))
	roots.push(workspace)
	const source = path.join(workspace, 'source')
	mkdirSync(path.join(source, 'package/dist/esm'), { recursive: true })
	writeFileSync(
		path.join(source, 'package/package.json'),
		JSON.stringify({
			name: 'convex',
			version: '1.48.0',
			dependencies: { '@reatom/core': '^1001.3.0' },
		}),
	)
	writeFileSync(path.join(source, 'package/dist/esm/index.js'), 'export const version = "1.48.0"')
	const archive = path.join(workspace, 'artifact.tgz')
	execFileSync('tar', ['-czf', archive, '-C', source, 'package'])
	const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex')
	const records = ['batched', 'rewrite'].map((id) => ({
		id,
		label: id,
		threadId: 'test',
		repository: 'test/repo',
		commit: 'a'.repeat(40),
		archive,
		sha256,
	}))
	const lockFile = path.join(workspace, 'lock.json')
	writeFileSync(lockFile, JSON.stringify({ convex: records }))
	return { workspace, lockFile, records, archive }
}

test('extracts and reuses verified artifacts, then detects modified JS', () => {
	const input = fixture()
	const first = loadArtifacts(input)
	expect(first).toHaveLength(2)
	expect(first[0]?.esmSha256).toHaveLength(64)
	expect(loadArtifacts(input)).toEqual(first)
	writeFileSync(path.join(first[0]!.root, 'node_modules/convex/dist/esm/index.js'), 'changed')
	expect(() => loadArtifacts(input)).toThrow('cached ESM contents changed')
})

test('rejects a missing or modified archive before reading its package', () => {
	const input = fixture()
	writeFileSync(input.archive, 'not the archived build')
	expect(() => loadArtifacts(input)).toThrow('SHA-256 mismatch')
	rmSync(input.archive)
	expect(() => loadArtifacts(input)).toThrow('Missing batched')
})

test('rejects duplicate variant ids instead of silently replacing one', () => {
	const input = fixture()
	writeFileSync(input.lockFile, JSON.stringify({ convex: [input.records[0], input.records[0]] }))
	expect(() => loadArtifacts(input)).toThrow('Duplicate SDK artifact id')
})
