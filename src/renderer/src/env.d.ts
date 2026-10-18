import type { SleepRelayApi } from '../../shared/types'

declare global {
  interface Window {
    sleepRelay: SleepRelayApi
  }
}

export {}
