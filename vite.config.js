import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// COEP/COOP headers required for MediaPipe wasm (SharedArrayBuffer)
const coepPlugin = () => ({
  name: 'coep-coop',
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
      next()
    })
  },
})

export default defineConfig({
  plugins: [react(), coepPlugin()],
})
