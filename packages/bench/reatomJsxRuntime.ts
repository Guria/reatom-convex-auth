// An automatic JSX runtime over the classic `h`/`hf`: @reatom/jsx's
// `jsx-runtime` entry exports neither `jsx` nor `Fragment`. run.ts resolves
// `@reatom/jsx/jsx-runtime` here.
import { h, hf } from '@reatom/jsx'

type Props = Record<string, unknown> & { children?: unknown }

export const Fragment = hf

export const jsx = (type: unknown, { children, ...props }: Props) =>
	h(type, props, ...(children === undefined ? [] : Array.isArray(children) ? children : [children]))

export const jsxs = jsx
