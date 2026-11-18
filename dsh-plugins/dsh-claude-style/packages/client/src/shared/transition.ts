/**
 * Write a start state with the transitions held back, so the change after it is
 * the one that travels.
 *
 * A pill arriving at its day, a preview card replaying from the top and a slider
 * knob taking a new stop all write that place, read it back once, and hand the
 * element its stylesheet's transition again: the frame that paints carries the
 * written values, and the next change moves from there.
 *
 * @param elements - the elements whose transitions are held back, restored together.
 * @param write - the start state, written while every transition is off.
 */
export function withoutTransition(elements: readonly HTMLElement[], write: () => void) {
  for (const element of elements) element.style.transition = 'none'
  write()
  for (const element of elements) void element.offsetWidth
  for (const element of elements) element.style.transition = ''
}
