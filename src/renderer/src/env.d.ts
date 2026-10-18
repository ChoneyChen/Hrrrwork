import type { HrrrworkApi } from '../../shared/types'

declare global {
  interface Window {
    hrrrwork: HrrrworkApi
  }
}

export {}
