import { defineConfig } from 'electron-vite'
import { resolve } from 'path'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: {
          onboarding: resolve(__dirname, 'src/renderer/onboarding/index.html'),
          pet: resolve(__dirname, 'src/renderer/pet/index.html')
        }
      }
    }
  }
})
