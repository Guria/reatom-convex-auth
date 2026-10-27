import { wrap } from '@reatom/core'
import { bindField, reatomComponent } from '@reatom/react'

import { authProviderLabel } from '#entities/session'
import { NOTES_PAGE_SIZE, type NotesPageModel } from '#pages/notes/model/notesPage'
import { m } from '#paraglide/messages.js'
import { Alert, Button, Field, Heading, Input, Skeleton, Text } from '#shared/components'
import { styled } from '#styled-system/jsx'

const Viewer = reatomComponent(({ viewer }: Pick<NotesPageModel, 'viewer'>) => {
	const current = viewer.data()
	if (!current) return <Skeleton h="5" w="64" />
	return (
		<Text color="muted">
			{m.notes_viewer({ provider: authProviderLabel(current.provider), email: current.email })}
		</Text>
	)
}, 'Viewer')

const NoteList = reatomComponent(({ notes }: Pick<NotesPageModel, 'notes'>) => {
	const error = notes.error()
	if (error) {
		return (
			<Alert.Root status="error" role="alert">
				<Alert.Indicator />
				<Alert.Content>
					<Alert.Title>{m.notes_error_title()}</Alert.Title>
					<Alert.Description>{error.message}</Alert.Description>
				</Alert.Content>
			</Alert.Root>
		)
	}
	const status = notes.status()
	if (status === 'LoadingFirstPage') {
		return (
			<styled.div role="status" aria-label={m.notes_loading()} display="grid" gap="2">
				<Skeleton h="10" />
				<Skeleton h="10" />
			</styled.div>
		)
	}
	const list = notes.results()
	if (list.length === 0) return <Text color="muted">{m.notes_empty()}</Text>
	return (
		<styled.div display="flex" flexDirection="column" gap="3">
			<styled.ul aria-label={m.notes_title()} display="grid" gap="2">
				{list.map((note) => (
					<styled.li
						key={note._id}
						p="3"
						borderWidth="1px"
						borderColor="border"
						borderRadius="md"
						bg="bg.default"
					>
						{note.text}
					</styled.li>
				))}
			</styled.ul>
			{status !== 'Exhausted' && (
				<Button
					variant="outline"
					alignSelf="flex-start"
					loading={status === 'LoadingMore'}
					loadingText={m.notes_loading_more()}
					onClick={wrap(() => notes.loadMore(NOTES_PAGE_SIZE))}
				>
					{m.notes_load_more()}
				</Button>
			)}
		</styled.div>
	)
}, 'NoteList')

const AddNoteForm = reatomComponent(({ form }: Pick<NotesPageModel, 'form'>) => {
	const { fields, submit } = form
	const error = submit.error()
	return (
		<styled.form
			display="flex"
			flexDirection="column"
			gap="3"
			onSubmit={wrap((event) => {
				event.preventDefault()
				submit()
			})}
		>
			<styled.div display="flex" gap="2" alignItems="flex-end">
				<Field.Root flex="1">
					<Field.Label>{m.notes_new_label()}</Field.Label>
					<Input autoComplete="off" {...bindField(fields.text)} />
				</Field.Root>
				<Button type="submit" loading={!submit.ready()} loadingText={m.notes_adding()}>
					{m.notes_add()}
				</Button>
			</styled.div>
			{error && (
				<Alert.Root status="error" role="alert">
					<Alert.Indicator />
					<Alert.Content>
						<Alert.Title>{m.notes_add_error()}</Alert.Title>
					</Alert.Content>
				</Alert.Root>
			)}
		</styled.form>
	)
}, 'AddNoteForm')

export const NotesPage = reatomComponent(
	({ model }: { model: NotesPageModel }) => (
		<styled.main p="6" display="flex" flexDirection="column" gap="6" maxW="2xl">
			<styled.div display="flex" flexDirection="column" gap="1">
				<Heading as="h1" fontSize="2xl">
					{m.notes_title()}
				</Heading>
				<Viewer viewer={model.viewer} />
			</styled.div>
			<AddNoteForm form={model.form} />
			<NoteList notes={model.notes} />
		</styled.main>
	),
	'NotesPage',
)
