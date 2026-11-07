import type { WfApi } from '../preload/index'

declare global {
  interface Window {
    wf: WfApi
  }
}
export {}
