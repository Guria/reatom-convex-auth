import { wrap } from '@reatom/core'
import { reatomComponent } from '@reatom/react'
import { ChevronsUpDown, LogOut } from 'lucide-react'

import { authProvider, authProviderLabel, sessionUser, signOut } from '#entities/session'
import { m } from '#paraglide/messages.js'
import { Menu, Text } from '#shared/components'
import { css } from '#styled-system/css'
import { styled } from '#styled-system/jsx'

export const AccountMenu = reatomComponent(() => {
	const user = sessionUser()
	const provider = authProviderLabel(authProvider())

	return (
		<Menu.Root positioning={{ placement: 'bottom-start' }}>
			<Menu.Trigger
				asChild
				className={css({ '[data-sidebar-collapsed] &': { justifyContent: 'center' } })}
			>
				<styled.button
					display="flex"
					alignItems="center"
					gap="2"
					w="100%"
					px="2"
					py="2"
					borderRadius="md"
					cursor="pointer"
					bg="transparent"
					border="none"
					color="inherit"
					_hover={{ bg: 'colorPalette.surface.bg.active' }}
				>
					<styled.div
						w="8"
						h="8"
						borderRadius="md"
						bg="colorPalette.3"
						flexShrink={0}
						display="flex"
						alignItems="center"
						justifyContent="center"
						fontSize="xs"
						fontWeight="bold"
						color="colorPalette.11"
					>
						{user?.email.charAt(0).toUpperCase() ?? ''}
					</styled.div>
					<styled.div
						flex="1"
						minW="0"
						textAlign="left"
						className={css({ '[data-sidebar-collapsed] &': { display: 'none' } })}
					>
						<styled.div fontSize="sm" fontWeight="medium" truncate>
							{user?.email ?? ''}
						</styled.div>
						<styled.div fontSize="xs" color="muted" truncate>
							{provider}
						</styled.div>
					</styled.div>
					<ChevronsUpDown
						className={css({
							w: '4',
							h: '4',
							color: 'muted',
							flexShrink: '0',
							'[data-sidebar-collapsed] &': { display: 'none' },
						})}
					/>
				</styled.button>
			</Menu.Trigger>
			<Menu.Positioner>
				<Menu.Content minW="56">
					{user && (
						<styled.div px="3" py="2" mb="1">
							<Text fontSize="sm" fontWeight="medium">
								{user.email}
							</Text>
							<Text fontSize="xs" color="muted">
								{provider}
							</Text>
						</styled.div>
					)}
					<Menu.Separator />
					<Menu.Item value="sign-out" onClick={wrap(() => signOut())}>
						<styled.div display="flex" alignItems="center" gap="2" color="red.fg">
							<LogOut className={css({ w: '4', h: '4' })} />
							{m.auth_sign_out()}
						</styled.div>
					</Menu.Item>
				</Menu.Content>
			</Menu.Positioner>
		</Menu.Root>
	)
}, 'AccountMenu')
