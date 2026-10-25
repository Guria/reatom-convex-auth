import { reatomEnum, reatomForm, urlAtom, wrap } from '@reatom/core'
import { Fragment } from 'react'

import { sessionStatus, signIn, signUp } from '#entities/session'
import { createAppPath, rootRoute } from '#shared/router'

import { LoginPage } from '../ui/LoginPage'

const notesPath = createAppPath('notes')

const reatomAuthForm = () => {
	const mode = reatomEnum(['signIn', 'signUp'], 'authForm.mode')
	const form = reatomForm(
		{ email: '', password: '' },
		{
			name: 'authForm',
			onSubmit: async (credentials) => {
				await wrap(mode() === 'signUp' ? signUp(credentials) : signIn(credentials))
			},
		},
	)
	return { mode, form }
}

export type AuthFormModel = ReturnType<typeof reatomAuthForm>

export const loginRoute = rootRoute.reatomRoute(
	{
		path: 'login',
		params: () => {
			if (sessionStatus() !== 'authenticated') return {}
			urlAtom.go(notesPath, true)
			return null
		},
		async loader() {
			return reatomAuthForm()
		},
		render(self) {
			const { isFulfilled, data } = self.loader.status()
			return isFulfilled ? <LoginPage key="login" model={data} /> : <Fragment key="loading" />
		},
	},
	'login',
)
