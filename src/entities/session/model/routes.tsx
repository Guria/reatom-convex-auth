import { urlAtom } from '@reatom/core'
import { createElement, Fragment } from 'react'

import { createAppPath, rootRoute } from '#shared/router'

import { sessionStatus } from './session'

const loginPath = createAppPath('login')

/** Layout for pages that read private Convex data. */
export const protectedRoute = rootRoute.reatomRoute(
	{
		layout: true,
		params: () => {
			const status = sessionStatus()
			if (status === 'authenticated') return {}
			// While the backend checks the token, the app shows a session status.
			// The query survives: an auth library's redirect back may land on
			// `/login/` with its params.
			const { pathname, search } = urlAtom()
			if (status !== 'authenticating' && pathname !== loginPath) {
				urlAtom.go(loginPath + search, true)
			}
			return null
		},
		render: (self) => self.outlet().filter(Boolean).at(-1) ?? createElement(Fragment),
	},
	'protectedRoute',
)
