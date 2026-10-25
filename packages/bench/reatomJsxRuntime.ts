// @reatom/jsx compiles with the classic `h`/`hf`: its `jsx-runtime` entry
// exports neither `jsx` nor `Fragment`. TypeScript reads the package's JSX
// types through `@jsxImportSource`; the bench builds alias the runtime here.
import { h, hf } from '@reatom/jsx'

type Props = Record<string, unknown> & { children?: unknown }

export const Fragment = hf

export const jsx = (type: unknown, { children, ...props }: Props) =>
	h(type, props, ...(children === undefined ? [] : Array.isArray(children) ? children : [children]))

export const jsxs = jsx
