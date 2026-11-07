import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/** Tiny .env loader (no dependency). Real environment variables win over the file. */
export function loadEnv(): void {
  // when launched as an app (not from a terminal) the working directory is "/", so also look next to the project
  for (const dir of [process.cwd(), app.getAppPath()]) {
    const file = join(dir, '.env')
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (!m || m[1] in process.env) continue
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  }
}
