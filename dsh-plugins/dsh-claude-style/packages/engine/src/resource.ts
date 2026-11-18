import { notifyAll } from './notify'

/** A JSON answer from one of the host half's routes: an object whose fields the adopter checks one by one. */
export type HostAnswer = Record<string, unknown> | null

/**
 * A one-shot JSON resource the host half serves (the model copy document,
 * the OS user, the HDSL contract): one GET per arming, the answer adopted
 * into the caller's own state, and a listener list told once that happens.
 *
 * The fetch is armed by load(); a failure means the host half did not answer,
 * and the caller's defaults simply stay (D12 * — a Promise rejection that says "the host half did not answer"). A failed
 * fetch disarms the resource again, so the next load() retries; reset() does
 * the same for a new host context.
 *
 * An unusable answer is not a failure: adopt() answers undefined and nothing
 * is adopted. A throw from adopt() is the caller's own bug and is left to
 * surface — it must never be read as a host that did not answer.
 *
 * @param route - the host route to GET.
 * @param adopt - `adopt(data)` stores what the answer carries and returns
 *   the value listeners are called with, or undefined when the answer is
 *   not usable (nothing is adopted, no listener hears anything).
 * @returns `{ load, onLoaded, reset }`.
 */
export function createHostResource<T>(route: string, adopt: (data: HostAnswer) => T | undefined) {
  let requested = false
  const listeners: ((value: T) => void)[] = []

  function load() {
    if (requested) return
    requested = true
    fetch(route, { credentials: 'same-origin' })
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      })
      // The fetch chain's rejection is handled here and only here: the host
      // half did not answer, so the defaults stay and the resource is armed
      // again for the next load(). adopt() runs in the fulfilment branch beside
      // it, which this handler does not cover — its throw is a program error
      // and surfaces rather than being read as a missing answer.
      .then(data => {
        const value = adopt(data)
        if (value !== undefined) notifyAll(listeners, value)
      }, () => {
        requested = false
      })
  }

  /** Register a listener for the adoption; the returned call removes it. */
  function onLoaded(listener: (value: T) => void) {
    listeners.push(listener)
    return () => {
      const index = listeners.indexOf(listener)
      if (index !== -1) listeners.splice(index, 1)
    }
  }

  /** Re-arm: the next load() fetches again (a new host context). */
  function reset() {
    requested = false
  }

  return { load, onLoaded, reset }
}
