// The @reatom/react renderer of the size app.
import { wrap, type Frame } from '@reatom/core'
import { reatomComponent, reatomContext } from '@reatom/react'
import { createRoot } from 'react-dom/client'

export function renderSizeApp(frame: Frame, onClick: () => void, summary: () => string) {
	const App = reatomComponent(() => <button onClick={wrap(onClick)}>{summary()}</button>, 'App')
	createRoot(document.getElementById('root')!).render(
		<reatomContext.Provider value={frame}>
			<App />
		</reatomContext.Provider>,
	)
}
