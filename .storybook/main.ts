import { defineMain } from '@storybook/react-vite/node'
import assert from 'node:assert'

const base = process.env['STORYBOOK_BASE_URL']
assert(base, 'STORYBOOK_BASE_URL env var is not set')

export default defineMain({
	framework: { name: '@storybook/react-vite', options: { strictMode: false } },
	features: {
		experimentalTestSyntax: true,
		sidebarOnboardingChecklist: false,
	},
	stories: ['../src/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
	addons: [
		'@storybook/addon-vitest',
		'@storybook/addon-a11y',
		'@storybook/addon-docs',
		'msw-storybook-addon',
	],
	staticDirs: ['../public'],
	viteFinal: (config) => {
		config.base = base
		// Stories run against the fake deployment (src/shared/mocks/convexBackend.ts),
		// whose clients the preview sets into the backend atoms. Setting an atom
		// runs its initializer first, which needs these even without .env.local.
		config.define = {
			...config.define,
			'import.meta.env.VITE_CONVEX_URL': JSON.stringify('https://fake.convex.cloud'),
			'import.meta.env.VITE_CONVEX_SITE_URL': JSON.stringify('https://convex-site.test'),
		}
		config.server = {
			...config.server,
			hmr: false,
		}
		return config
	},
})
