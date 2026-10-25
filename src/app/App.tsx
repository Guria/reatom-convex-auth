import { urlAtom, withChangeHook } from '@reatom/core'
import { reatomComponent } from '@reatom/react'

import { sessionStatus } from '#entities/session'
import { loginRoute } from '#pages/login'
import { NotFoundPage } from '#pages/not-found'
import { notesRoute } from '#pages/notes'
import { m } from '#paraglide/messages.js'
import { Spinner, Toaster } from '#shared/components'
import { documentTitleAtom, localeAtom } from '#shared/model'
import { rootRoute } from '#shared/router'
import { styled } from '#styled-system/jsx'
import { AppShell } from '#widgets/app-shell'

import { AccountMenu } from './AccountMenu'
import { ConnectionStatus } from './ConnectionStatus'
import { HeaderBreadcrumbs } from './HeaderBreadcrumbs'
import { MobileHeader } from './MobileHeader'
import { SidebarNavigation } from './SidebarNavigation'

urlAtom.extend(
	withChangeHook(() => {
		if (rootRoute.exact()) {
			if (sessionStatus() === 'authenticated') {
				notesRoute.go(undefined, true)
			} else {
				loginRoute.go(undefined, true)
			}
		}
	}),
)

// The client holds a session but the backend has not accepted its token yet:
// neither the sign-in page nor private pages are the right owner.
const CheckingSession = () => (
	<styled.main
		role="status"
		aria-label={m.session_checking()}
		minH="100dvh"
		display="grid"
		placeItems="center"
	>
		<Spinner />
	</styled.main>
)

export const App = reatomComponent(() => {
	localeAtom()
	documentTitleAtom()
	if (sessionStatus() === 'authenticating') {
		return (
			<>
				<CheckingSession />
				<Toaster />
			</>
		)
	}
	if (loginRoute.match()) {
		return (
			<>
				{rootRoute.render()}
				<Toaster />
			</>
		)
	}

	// `rootRoute` is a layout that matches any path under the base. When its
	// outlet is empty, no registered child route (login, dashboard, ...) matched
	// the current URL — render the not-found fallback.
	const outlet = rootRoute.outlet()
	const content = outlet.length > 0 ? rootRoute.render() : <NotFoundPage />

	return (
		<>
			<AppShell
				appName={m.app_name()}
				sidebarContent={<SidebarNavigation />}
				sidebarFooter={
					<styled.div display="flex" flexDirection="column" gap="3">
						<AccountMenu />
					</styled.div>
				}
				mobileHeader={<MobileHeader />}
				breadcrumbs={<HeaderBreadcrumbs />}
			>
				<ConnectionStatus />
				{content}
			</AppShell>
			<Toaster />
		</>
	)
}, 'App')
