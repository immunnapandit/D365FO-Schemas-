import { useSyncExternalStore } from 'react'

const QUERY = '(max-width: 860px)'

/** True on small screens, where the menu slides in and out instead of collapsing to a rail. */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(QUERY)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    () => window.matchMedia(QUERY).matches,
    () => false,
  )
}
