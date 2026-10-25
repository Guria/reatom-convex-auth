/** Reads JWT claims without verifying them; the Convex backend verifies. */
export function readJwtClaims(token: string): Record<string, unknown> | null {
	const payload = token.split('.')[1]
	if (!payload) return null
	try {
		const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
		const claims: unknown = JSON.parse(json)
		return typeof claims === 'object' && claims !== null ? { ...claims } : null
	} catch {
		return null
	}
}
