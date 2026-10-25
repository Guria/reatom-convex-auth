import type { BaseActor, Canvas } from 'kahraman'

import { button, heading, role } from '#shared/test'

const field = (label: string) => (canvas: Canvas) => canvas.getByLabelText(label)

export const loginLoc = {
	signInHeading: heading('Sign in'),
	signUpHeading: heading('Create account'),
	email: field('Email'),
	password: field('Password'),
}

type Credentials = { email: string; password: string }

export const withLoginPage = (I: Pick<BaseActor, 'click' | 'fill' | 'see' | 'waitExit'>) => ({
	chooseProvider: (label: string) => I.click(role('radio', label)),
	fillCredentials: async ({ email, password }: Credentials) => {
		await I.fill(loginLoc.email, email)
		await I.fill(loginLoc.password, password)
	},
	signUp: async (credentials: Credentials) => {
		await I.click(button('Create an account'))
		await I.see(loginLoc.signUpHeading)
		await I.fill(loginLoc.email, credentials.email)
		await I.fill(loginLoc.password, credentials.password)
		await I.click(button('Create account'))
		await I.waitExit(button('Creating account'))
	},
	signIn: async (credentials: Credentials) => {
		await I.fill(loginLoc.email, credentials.email)
		await I.fill(loginLoc.password, credentials.password)
		await I.click(button('Sign in'))
		await I.waitExit(button('Signing in'))
	},
})
