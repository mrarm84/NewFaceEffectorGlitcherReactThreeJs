import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

// COEP/COOP headers required for MediaPipe wasm (SharedArrayBuffer)
const coepPlugin = () => ({
  name: 'coep-coop',
  configureServer(server) {
    const shaderDir = path.join(process.cwd(), 'public', 'shaders')

    const titleize = (value) => value
      .replace(/\.[^.]+$/, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, c => c.toUpperCase()) || 'Shader'

    const readShaderFiles = () => {
      const exts = new Set(['.json', '.glsl', '.frag', '.fs'])
      const entries = []
      if (!fs.existsSync(shaderDir)) return entries

      for (const file of fs.readdirSync(shaderDir)) {
        if (!exts.has(path.extname(file).toLowerCase())) continue
        const full = path.join(shaderDir, file)
        const ext = path.extname(file).toLowerCase()
        const stem = path.basename(file, ext)
        try {
          if (ext === '.json') {
            const parsed = JSON.parse(fs.readFileSync(full, 'utf-8'))
            const list = Array.isArray(parsed) ? parsed : [parsed]
            for (const item of list) {
              if (!item?.code) continue
              entries.push({
                name: item.name ?? titleize(stem),
                file,
                code: item.code,
              })
            }
          } else {
            entries.push({
              name: titleize(stem),
              file,
              code: fs.readFileSync(full, 'utf-8'),
            })
          }
        } catch (e) {
          console.error(`Error reading shader file ${file}`, e)
        }
      }

      return entries.sort((a, b) => a.name.localeCompare(b.name))
    }

    server.middlewares.use(async (req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
      
      if (req.url === '/api/shaders' && req.method === 'GET') {
        const shaders = readShaderFiles()
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(shaders))
        return
      }

      if (req.url === '/api/shaders' && req.method === 'POST') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          try {
            const shader = JSON.parse(body)
            let shaders = []
            if (fs.existsSync(shaderDir)) {
              shaders = readShaderFiles().map(({ name, code }) => ({ name, code }))
            }
            const idx = shaders.findIndex(s => s.name === shader.name)
            if (idx >= 0) shaders[idx] = shader
            else shaders.push(shader)
            fs.mkdirSync(shaderDir, { recursive: true })
            const safeName = shader.name
              .toString()
              .trim()
              .replace(/[^a-z0-9]+/gi, '-')
              .replace(/^-+|-+$/g, '')
              .toLowerCase() || 'shader'
            fs.writeFileSync(path.join(shaderDir, `${safeName}.json`), JSON.stringify({ name: shader.name, code: shader.code }, null, 2))
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ success: true }))
          } catch (e) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: e.message }))
          }
        })
        return
      }

      next()
    })
  },
})

export default defineConfig({
  plugins: [react(), coepPlugin()],
})
