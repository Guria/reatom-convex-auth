// Run the unchanged app with the experimental client. Keep the default build
// and its test fakes on the binding; only this build swaps the backend factory.
import { mergeConfig } from 'vite-plus'

import config from './vite.config'

export default mergeConfig(config, {
	plugins: [
		{
			name: 'native-convex-client',
			enforce: 'pre',
			transform(code: string, id: string) {
				if (!id.endsWith('/src/shared/api/backend.ts')) return
				const transformed = code
					.replace(
						"import { ConvexClient } from 'convex/browser'",
						"import { reatomConvexClient } from 'reatom-convex-client'",
					)
					.replace("from 'reatom-convex'", "from 'reatom-convex-client'")
					.replace(
						"new ConvexClient(env('VITE_CONVEX_URL'))",
						"reatomConvexClient(env('VITE_CONVEX_URL'))",
					)
				if (
					transformed.includes('new ConvexClient') ||
					!transformed.includes('reatomConvexClient(env(')
				) {
					throw new Error('Native client replacement no longer matches backend.ts')
				}
				return transformed
			},
		},
	],
})
