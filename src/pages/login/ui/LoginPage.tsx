import type { AuthFormModel } from '#pages/login/model/routes'

import { wrap } from '@reatom/core'
import { bindField, reatomComponent } from '@reatom/react'

import { authProvider, authProviderLabel, sessionStatus, signOut } from '#entities/session'
import { m } from '#paraglide/messages.js'
import { AUTH_PROVIDERS } from '#shared/api'
import { Alert, Button, Field, Fieldset, Heading, Input, Text } from '#shared/components'
import { styled } from '#styled-system/jsx'

const ProviderSwitch = reatomComponent(({ disabled }: { disabled: boolean }) => {
	const selected = authProvider()
	return (
		<Fieldset.Root disabled={disabled}>
			<Fieldset.Legend>{m.auth_provider_label()}</Fieldset.Legend>
			<styled.div display="flex" gap="4">
				{AUTH_PROVIDERS.map((id) => (
					<styled.label key={id} display="flex" alignItems="center" gap="2" cursor="pointer">
						<input
							type="radio"
							name="auth-provider"
							value={id}
							checked={selected === id}
							onChange={wrap(() => authProvider.set(id))}
						/>
						{authProviderLabel(id)}
					</styled.label>
				))}
			</styled.div>
		</Fieldset.Root>
	)
}, 'ProviderSwitch')

const RejectedSession = reatomComponent(
	() => (
		<Alert.Root status="error" role="alert">
			<Alert.Indicator />
			<Alert.Content>
				<Alert.Title>{m.session_rejected_title()}</Alert.Title>
				<Alert.Description>{m.session_rejected_description()}</Alert.Description>
			</Alert.Content>
			<Button size="sm" variant="outline" onClick={wrap(() => signOut())}>
				{m.auth_sign_out()}
			</Button>
		</Alert.Root>
	),
	'RejectedSession',
)

export const LoginPage = reatomComponent(({ model }: { model: AuthFormModel }) => {
	const { mode, form } = model
	const { fields, submit } = form
	const isSignUp = mode() === 'signUp'
	const error = submit.error()
	const pending = !submit.ready()

	return (
		<styled.main minH="100dvh" display="grid" placeItems="center" bg="gray.2" px="4" py="8">
			<styled.form
				w="full"
				maxW="380px"
				bg="bg.default"
				borderWidth="1px"
				borderColor="border"
				borderRadius="md"
				p="6"
				display="flex"
				flexDirection="column"
				gap="5"
				onSubmit={wrap((event) => {
					event.preventDefault()
					submit()
				})}
			>
				<styled.div display="flex" flexDirection="column" gap="1">
					<Heading as="h1" fontSize="2xl">
						{isSignUp ? m.signup_title() : m.login_title()}
					</Heading>
					<Text color="muted">{m.login_description()}</Text>
				</styled.div>

				{sessionStatus() === 'rejected' && <RejectedSession />}

				{error && (
					<Alert.Root status="error" role="alert">
						<Alert.Indicator />
						<Alert.Content>
							<Alert.Title>{isSignUp ? m.signup_error_title() : m.login_error_title()}</Alert.Title>
							<Alert.Description>{m.login_error_description()}</Alert.Description>
						</Alert.Content>
					</Alert.Root>
				)}

				<ProviderSwitch disabled={pending} />

				<Field.Root required>
					<Field.Label>{m.login_email()}</Field.Label>
					<Input type="email" autoComplete="email" {...bindField(fields.email)} />
				</Field.Root>

				<Field.Root required>
					<Field.Label>{m.login_password()}</Field.Label>
					<Input
						type="password"
						minLength={8}
						autoComplete={isSignUp ? 'new-password' : 'current-password'}
						{...bindField(fields.password)}
					/>
				</Field.Root>

				<Button
					type="submit"
					loading={pending}
					loadingText={isSignUp ? m.signup_creating() : m.login_signing_in()}
				>
					{isSignUp ? m.signup_submit() : m.login_submit()}
				</Button>

				<Button
					type="button"
					variant="plain"
					disabled={pending}
					onClick={wrap(() => mode.set(isSignUp ? 'signIn' : 'signUp'))}
				>
					{isSignUp ? m.login_switch_to_signin() : m.login_switch_to_signup()}
				</Button>
			</styled.form>
		</styled.main>
	)
}, 'LoginPage')
