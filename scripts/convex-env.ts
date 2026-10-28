// Sets the deployment variables both auth libraries need. Missing secrets are
// generated; derived values are rewritten when they no longer match.
//
// Convex Auth and better-auth share one RS256 key pair. Both sign with
// iss = CONVEX_SITE_URL and aud = "convex", so the backend verifies their
// tokens through one OIDC provider (convex/auth.config.ts) whose JWKS
// (served by Convex Auth from `JWKS`) holds that single key. Convex Auth
// tokens carry no `kid`, which the backend accepts only for a one-key JWKS.
import { symmetricEncrypt } from 'better-auth/crypto'
import { execFileSync } from 'node:child_process'
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	randomBytes,
} from 'node:crypto'

// An explicit `SITE_URL` replaces the stored one; without it the stored one stays.
const siteUrl = process.env['SITE_URL']
// `--prod` targets the production deployment of the configured project.
const target = process.argv.includes('--prod') ? ['--prod'] : []

const convexEnv = (args: string[], input?: string) =>
	execFileSync('nub', ['exec', 'convex', 'env', ...target, ...args], {
		encoding: 'utf8',
		input,
		stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'],
	})

const get = (name: string) => {
	const value = convexEnv(['get', name]).trim()
	return value === '' ? null : value
}

const set = (name: string, value: string) => {
	convexEnv(['set', name], value)
	console.log(`${name}: set`)
}

const ensure = (name: string, create: () => string) => {
	const value = get(name)
	if (value !== null) {
		console.log(`${name}: already set`)
		return value
	}
	const created = create()
	set(name, created)
	return created
}

if (siteUrl === undefined) ensure('SITE_URL', () => 'http://localhost:5173')
else if (get('SITE_URL') === siteUrl) console.log('SITE_URL: up to date')
else set('SITE_URL', siteUrl)
const secret = ensure('BETTER_AUTH_SECRET', () => randomBytes(32).toString('base64'))
// Same format as `npx @convex-dev/auth`: PKCS#8 PEM with newlines as spaces.
const privatePem = ensure('JWT_PRIVATE_KEY', () =>
	generateKeyPairSync('rsa', { modulusLength: 2048 })
		.privateKey.export({ format: 'pem', type: 'pkcs8' })
		.toString()
		.trimEnd()
		.replace(/\n/g, ' '),
)

const der = Buffer.from(privatePem.replace(/-----[^-]+-----|\s/g, ''), 'base64')
const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' })
const kid = createHash('sha256').update(String(publicJwk.n)).digest('base64url').slice(0, 16)

const jwks = JSON.stringify({ keys: [{ use: 'sig', alg: 'RS256', kid, ...publicJwk }] })
if (get('JWKS') === jwks) console.log('JWKS: up to date')
else set('JWKS', jwks)

// better-auth's static key record: the jwt plugin signs with `id` as `kid`
// and decrypts `privateKey` with BETTER_AUTH_SECRET.
const current = get('BETTER_AUTH_JWKS')
const currentKid = current === null ? null : (JSON.parse(current) as { id: string }[])[0]?.id
if (currentKid === kid) console.log('BETTER_AUTH_JWKS: up to date')
else {
	const encrypted = await symmetricEncrypt({
		key: secret,
		data: JSON.stringify(privateKey.export({ format: 'jwk' })),
	})
	set(
		'BETTER_AUTH_JWKS',
		JSON.stringify([
			{
				id: kid,
				alg: 'RS256',
				publicKey: JSON.stringify(publicJwk),
				privateKey: JSON.stringify(encrypted),
				createdAt: new Date().toISOString(),
			},
		]),
	)
}
