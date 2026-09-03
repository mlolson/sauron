import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        external: ['electron', 'node-pty'],
        input: {
          index: resolve('src/main/index.ts'),
          cli: resolve('src/cli/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: { rollupOptions: { external: ['electron'], output: { entryFileNames: '[name].mjs' } } },
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: shared },
  },
})
