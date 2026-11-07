import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/** Tiny .env loader (no dependency). Real environment variables win over the file. */
export function loadEnv(): void {
  const file = join(process.cwd(), '.env')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m || m[1] in process.env) continue
    process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
}
