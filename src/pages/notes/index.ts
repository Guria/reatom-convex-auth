import { m } from '#paraglide/messages.js'
import { withMatchHeaderTrail } from '#shared/model'

import { notesRoute } from './model/routes'

notesRoute.match.extend(withMatchHeaderTrail(1, { label: () => m.nav_notes() }))

export { notesRoute }
export { NotesNavItem } from './ui/NotesNavItem'
