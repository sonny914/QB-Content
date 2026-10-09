// Starts the local render service and the Vite front-end together.
//   node scripts/dev.mjs          -> render service + Vite dev server (http://localhost:5173)
//   node scripts/dev.mjs preview  -> render service + Vite preview of the built app (http://localhost:4173)
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2] === 'preview' ? 'preview' : 'dev'
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const viteArgs = mode === 'preview' ? [viteBin, 'preview', '--port', '4173', '--strictPort'] : [viteBin]

const children = [
  spawn(process.execPath, [path.join(root, 'server', 'index.mjs')], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, viteArgs, { cwd: root, stdio: 'inherit' }),
]

let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill()
  setTimeout(() => process.exit(code), 200)
}
for (const child of children) child.on('exit', (code) => stop(code ?? 0))
process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
