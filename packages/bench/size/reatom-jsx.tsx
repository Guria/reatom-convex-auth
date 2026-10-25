/** @jsxImportSource @reatom/jsx */
// The features the app uses, through the binding and @reatom/jsx.
import { mount } from '@reatom/jsx'

import { frame, onClick, summary } from './bindingApp'

frame.run(() =>
	mount(document.getElementById('root')!, <button on:click={onClick}>{summary}</button>),
)
