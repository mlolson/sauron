import type { SauronApi } from '@shared/types'

declare global {
  interface Window {
    sauron: SauronApi
  }
}

export {}
