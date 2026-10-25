// The features the app uses, through the binding and @reatom/react.
import { wrap } from '@reatom/core'
import { reatomComponent, reatomContext } from '@reatom/react'
import { createRoot } from 'react-dom/client'

import { frame, onClick, summary } from './bindingApp'

const App = reatomComponent(() => <button onClick={wrap(onClick)}>{summary()}</button>, 'App')

createRoot(document.getElementById('root')!).render(
	<reatomContext.Provider value={frame}>
		<App />
	</reatomContext.Provider>,
)
