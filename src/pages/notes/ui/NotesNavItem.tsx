import { reatomComponent } from '@reatom/react'
import { StickyNote } from 'lucide-react'

import { m } from '#paraglide/messages.js'
import { SideNavButton, SideNavItemContent } from '#widgets/side-nav'

import { notesRoute } from '../model/routes'

export const NotesNavItem = reatomComponent(
	() => (
		<a href={notesRoute.path()}>
			<SideNavButton active={notesRoute.match()}>
				<SideNavItemContent Icon={StickyNote} label={m.nav_notes()} />
			</SideNavButton>
		</a>
	),
	'NotesNavItem',
)
