/** @jsxImportSource @reatom/jsx */
// The features the app uses, through @reatomized/convex and @reatom/jsx.
import { mount } from '@reatom/jsx'

import { frame, onClick, summary } from './app'

frame.run(() =>
	mount(document.getElementById('root')!, <button on:click={onClick}>{summary}</button>),
)
