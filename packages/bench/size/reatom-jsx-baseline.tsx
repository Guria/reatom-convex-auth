/** @jsxImportSource @reatom/jsx */
// Baseline: Reatom with @reatom/jsx, no React.
import { atom, clearStack, context } from '@reatom/core'
import { mount } from '@reatom/jsx'

clearStack()
const frame = context.start()
const label = atom('baseline', 'label')

frame.run(() => mount(document.getElementById('root')!, <p>{label}</p>))
