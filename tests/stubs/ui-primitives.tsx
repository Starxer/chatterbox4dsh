/**
 * Test-only stand-in for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * DSH rc.1 moved this component library's runtime dependencies (clsx, katex,
 * shiki, micromark-*, mdast-util-*, ...) into that package's own
 * `devDependencies`, on the premise that the host Web app already provides
 * them. A plugin installed standalone therefore cannot resolve them, so the
 * real package cannot be loaded from a unit test at all.
 *
 * The alias in `vitest.config.ts` points at this module instead. It mirrors the
 * four components' observable contract (role / aria-label / disabled / value),
 * so the settings panel's *own* behaviour stays under test: which toggles it
 * renders, how the disabled state propagates, and what it posts on save. The
 * components themselves belong to DSH and are verified there.
 */
import { createElement as h } from 'react'

type AnyProps = Record<string, any>

/** Real Button renders a plain <button>; `variant` must not leak to the DOM. */
export function Button(props: AnyProps) {
  const { variant, ...rest } = props
  void variant
  return h('button', rest)
}

/** Real Input is a controlled native input. */
export function Input(props: AnyProps) {
  return h('input', props)
}

/** Real Switch renders role="switch" with the accessible name from `label`. */
export function Switch(props: AnyProps) {
  const { checked, onChange, label, disabled, ...rest } = props
  return h('button', {
    ...rest,
    type: 'button',
    role: 'switch',
    'aria-checked': checked === true ? 'true' : 'false',
    'aria-label': label,
    disabled: disabled === true,
    onClick: () => {
      if (disabled !== true) onChange?.(checked !== true)
    },
  })
}

/** Real StateDot reports its state through `data-state`. */
export function StateDot(props: AnyProps) {
  const { state, size, ...rest } = props
  return h('span', { ...rest, 'data-state': state, 'data-size': size })
}
