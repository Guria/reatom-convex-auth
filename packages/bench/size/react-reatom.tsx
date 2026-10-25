// Baseline: React with Reatom, for apps that already use it.
import { atom, clearStack, context } from '@reatom/core'
import { reatomComponent, reatomContext } from '@reatom/react'
import { createRoot } from 'react-dom/client'

clearStack()
const frame = context.start()
const label = atom('baseline', 'label')
const App = reatomComponent(() => <p>{label()}</p>, 'App')

createRoot(document.getElementById('root')!).render(
	<reatomContext.Provider value={frame}>
		<App />
	</reatomContext.Provider>,
)
