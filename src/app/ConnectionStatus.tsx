import { reatomComponent } from '@reatom/react'

import { m } from '#paraglide/messages.js'
import { convex } from '#shared/api'
import { styled } from '#styled-system/jsx'

// A token refresh stops the socket too, so it takes precedence.
export const ConnectionStatus = reatomComponent(() => {
	const { hasEverConnected, isWebSocketConnected } = convex.connectionState()
	const message = convex.isRefreshingAuth()
		? m.session_refreshing()
		: hasEverConnected && !isWebSocketConnected
			? m.connection_lost()
			: null
	if (!message) return null
	return (
		<styled.div
			role="status"
			aria-label={message}
			px="4"
			py="2"
			bg="orange.subtle.bg"
			color="orange.subtle.fg"
			textStyle="sm"
		>
			{message}
		</styled.div>
	)
}, 'ConnectionStatus')
