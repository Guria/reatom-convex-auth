/// <reference types="msw-storybook-addon/types" />
import '../src/setup'

import '../src/index.css'

import { reatomContext } from '@reatom/react'
import addonA11y from '@storybook/addon-a11y'
import { definePreview } from '@storybook/react-vite'
import { configureDiagnostics } from 'kahraman/preview'
import addonMsw from 'msw-storybook-addon'
import { setupWorker } from 'msw/browser'

import { clearAbortErrors, drainAbortErrors, formatAbortErrors } from './abortErrorGuard'
// oxlint-disable-next-line no-restricted-imports
import { useEffect, useMemo, type PropsWithChildren } from 'react'

import { handlersArray } from '#app/mocks/handlers'
import { authProvider } from '#entities/session'
import {
	betterAuthClient,
	convex,
	type AuthProviderId,
	convexAuthStorageKeys,
	convexAuthTransport,
	createBetterAuthClient,
} from '#shared/api'
import {
	createFakeConvexBackend,
	FAKE_CONVEX_SITE_URL,
	fakeBetterAuthHandlers,
	fakeConvexBackend,
} from '#shared/mocks/convexBackend'
import { css } from '#styled-system/css'

import { setupStorybookUrl } from './setupStorybookUrl'
import { FALLBACK_VIEWPORT, getViewportSize } from './viewports'

// Storybook 10.5's test preview replaces `HTMLElement.prototype.focus` with an
// accessor for interaction instrumentation. Zag's focus-visible manager reads
// that property from the prototype, invoking the accessor with an invalid
// receiver and causing `TypeError: Illegal invocation`. Keep the native method
// and restore it before each story until the upstream compatibility issue is resolved.
const nativeHTMLElementFocus = globalThis.HTMLElement
	? Object.getOwnPropertyDescriptor(globalThis.HTMLElement.prototype, 'focus')?.value
	: undefined

// MSW worker setup. The default request handlers (`handlersArray`) are passed
// as initial handlers so they survive the addon's per-story `resetHandlers()`
// — every story gets the full route set mocked by default, with individual
// routes overridable via `msw.use(...)` in a story's `beforeEach`.
async function setupMswWorker() {
	const worker = setupWorker(...handlersArray, ...fakeBetterAuthHandlers)
	await worker.start({
		onUnhandledRequest: 'bypass',
		quiet: true,
		serviceWorker: {
			url: `${import.meta.env['BASE_URL']}mockServiceWorker.js`,
		},
	})
	return worker
}

const NO_NOTES: string[] = []
const SEEDED_USER = { email: 'alex@example.com', password: 'correct-horse' }
const convexAuthKeys = convexAuthStorageKeys('convexAuth')
// Auth state persisted by the adapters; each story gets a new fake backend.
const AUTH_STORAGE_KEYS = [
	convexAuthKeys.token,
	convexAuthKeys.refreshToken,
	'better-auth_cookie',
	'better-auth_session_data',
	'authProvider',
]

// A fresh in-memory Convex deployment per story. `authenticated` stories
// start with a restored Convex Auth session, as after a page reload.
const startFakeBackend = (authenticated: boolean, seedNotes: string[]) => {
	AUTH_STORAGE_KEYS.forEach((key) => window.localStorage.removeItem(key))
	const backend = createFakeConvexBackend()
	fakeConvexBackend.current = backend
	if (authenticated) {
		const tokens = backend.seedConvexAuthSession(SEEDED_USER.email, SEEDED_USER.password)
		window.localStorage.setItem(convexAuthKeys.token, tokens.token)
		window.localStorage.setItem(convexAuthKeys.refreshToken, tokens.refreshToken)
		backend.seedNotes(SEEDED_USER.email, seedNotes)
	}
	return backend
}

function ReatomDecorator({
	children,
	initialPath = '',
	authenticated = true,
	seedNotes = NO_NOTES,
	provider,
}: PropsWithChildren<{
	authenticated?: boolean
	seedNotes?: string[]
	initialPath?: string
	provider?: AuthProviderId
}>) {
	const frame = useMemo(() => {
		// localStorage is shared across stories on the same origin. Atoms backed
		// by withLocalStorage (theme, locale, top-bar toggles, auth) would otherwise
		// inherit state a previous story persisted. Reset to defaults in test runs
		// before the fresh frame reads them.
		if ((globalThis as Record<string, unknown>)['__vitest_worker__']) {
			window.localStorage.clear()
		}
		const backend = startFakeBackend(authenticated, seedNotes)
		const client = backend.createClient()
		const storyFrame = setupStorybookUrl(initialPath, () => {
			convex.set(client)
			convexAuthTransport.set(backend.convexAuth)
			betterAuthClient.set(createBetterAuthClient(FAKE_CONVEX_SITE_URL))
			if (provider) authProvider.set(provider)
		})
		return { storyFrame, client, backend }
	}, [authenticated, initialPath, provider, seedNotes])

	useEffect(() => {
		return () => {
			// The client reconnects on its own until closed.
			void frame.storyFrame.run(() => frame.client.close())
			frame.backend.server.close()
			clearAbortErrors()
			queueMicrotask(clearAbortErrors)
		}
	}, [frame])

	return <reatomContext.Provider value={frame.storyFrame}>{children}</reatomContext.Provider>
}

const preview = definePreview({
	addons: [addonA11y(), addonMsw(setupMswWorker)],
	decorators: [
		(Story, { parameters }) => (
			<ReatomDecorator
				authenticated={parameters['authenticated']}
				seedNotes={parameters['seedNotes']}
				initialPath={parameters['initialPath']}
				provider={parameters['authProvider']}
			>
				<Story />
			</ReatomDecorator>
		),
		(Story) => (
			<div className={css({ colorPalette: 'indigo' })}>
				<Story />
			</div>
		),
	],
	parameters: {
		a11y: { test: 'todo' },
	},
	// fallow-ignore-next-line complexity
	beforeEach: async ({ globals, parameters }) => {
		// Run before a story mounts, so Zag observes the native focus method.
		if (nativeHTMLElementFocus) {
			Object.defineProperty(HTMLElement.prototype, 'focus', {
				configurable: true,
				value: nativeHTMLElementFocus,
			})
		}
		configureDiagnostics(parameters['kahraman'])
		clearAbortErrors()
		if (!(globalThis as Record<string, unknown>)['__vitest_worker__']) return
		const { page } = await import('vite-plus/test/browser')
		const viewportGlobal = globals['viewport'] as { value?: string } | string | undefined
		const viewportName = typeof viewportGlobal === 'string' ? viewportGlobal : viewportGlobal?.value
		const viewport = (viewportName ? getViewportSize(viewportName) : null) ?? FALLBACK_VIEWPORT
		await page.viewport(viewport.width, viewport.height)
		return () => {
			const errors = drainAbortErrors()
			if (errors.length > 0) {
				throw new Error(
					`Reatom AbortErrors detected during story test:\n${formatAbortErrors(errors)}`,
				)
			}
		}
	},
})

export default preview
