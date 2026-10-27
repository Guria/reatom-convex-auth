/** @jsxImportSource @reatom/jsx */
// The features the app uses, through the Atoms SDK API and @reatom/jsx.
import { mount } from '@reatom/jsx'

import { frame, onClick, summary } from './atomsApiApp'

frame.run(() =>
	mount(document.getElementById('root')!, <button on:click={onClick}>{summary}</button>),
)
