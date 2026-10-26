/** @jsxImportSource @reatom/jsx */
// The features the app uses, through the native client and @reatom/jsx.
import { mount } from '@reatom/jsx'

import { frame, onClick, summary } from './nativeApp'

frame.run(() =>
	mount(document.getElementById('root')!, <button on:click={onClick}>{summary}</button>),
)
