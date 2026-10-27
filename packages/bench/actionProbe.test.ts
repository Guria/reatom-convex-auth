import { expect, test } from 'vite-plus/test'

import { runActionProbe } from './actionProbe'

test.each(['plain', 'subscribed', 'hooked', 'atom'] as const)(
	'%s probe accounts for every write without a timing assertion',
	(kind) => {
		const result = runActionProbe(25, kind)
		expect(result.calls).toBe(25)
		expect(result.ms).toBeGreaterThanOrEqual(0)
	},
)
