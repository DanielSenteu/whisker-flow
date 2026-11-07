// What the pups can do on your Mac. A small, fixed set of safe actions: nothing deletes, spends or logs in.
import { execFile } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const run = promisify(execFile)
const osa = async (script: string): Promise<string> => (await run('osascript', ['-e', script], { timeout: 20000 })).stdout.trim()
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- Spotify
export const MOODS: Record<string, { uri: string; label: string }> = {
  focus: { uri: 'spotify:playlist:37i9dQZF1DWZeKCadgRdKQ', label: 'Deep Focus' },
  lofi: { uri: 'spotify:playlist:37i9dQZF1DWWQRwui0ExPn', label: 'Lofi Beats' },
  chill: { uri: 'spotify:playlist:37i9dQZF1DX4WYpdgoIcn6', label: 'Chill Hits' },
  piano: { uri: 'spotify:playlist:37i9dQZF1DX4sWSpwq3LiO', label: 'Peaceful Piano' },
  happy: { uri: 'spotify:playlist:37i9dQZF1DXdPec7aLTmlC', label: 'Happy Hits' },
  workout: { uri: 'spotify:playlist:37i9dQZF1DX76Wlfdnj7AP', label: 'Beast Mode' },
  jazz: { uri: 'spotify:playlist:37i9dQZF1DX0SM0LYsmbMT', label: 'Jazz Vibes' }
}

async function spotifyRunning(): Promise<boolean> {
  return (await osa('tell application "System Events" to (name of processes) contains "Spotify"')) === 'true'
}

async function ensureSpotify(): Promise<void> {
  if (await spotifyRunning()) return
  await run('open', ['-a', 'Spotify'])
  for (let i = 0; i < 20 && !(await spotifyRunning()); i++) await sleep(500)
  await sleep(2500) // let it finish starting
}

export async function nowPlaying(): Promise<string> {
  const state = await osa('tell application "Spotify" to return player state as string')
  const track = await osa('tell application "Spotify" to return (name of current track) & " by " & (artist of current track)').catch(() => '')
  return track ? `${track} (${state})` : state
}

/** Start a mood playlist, e.g. "focus". Returns a short line saying what is playing. */
export async function playMood(mood: string): Promise<string> {
  const m = MOODS[mood] ?? MOODS.focus
  await ensureSpotify()
  await osa(`tell application "Spotify" to play track "${m.uri}"`)
  await sleep(1800)
  return `Playing ${m.label}: ${await nowPlaying()}`
}

export async function musicControl(action: 'pause' | 'play' | 'next' | 'previous' | 'volume_up' | 'volume_down'): Promise<string> {
  await ensureSpotify()
  switch (action) {
    case 'pause': await osa('tell application "Spotify" to pause'); return 'Paused the music'
    case 'play': await osa('tell application "Spotify" to play'); break
    case 'next': await osa('tell application "Spotify" to next track'); break
    case 'previous': await osa('tell application "Spotify" to previous track'); break
    case 'volume_up':
      await osa('tell application "Spotify" to set sound volume to ((sound volume) + 20)')
      return 'Turned the music up'
    case 'volume_down':
      await osa('tell application "Spotify" to set sound volume to ((sound volume) - 20)')
      return 'Turned the music down'
  }
  await sleep(800)
  return await nowPlaying()
}

// ---------------------------------------------------------------- apps
export async function openApp(name: string): Promise<string> {
  const clean = String(name).replace(/[^\w .+&-]/g, '').trim().slice(0, 60)
  if (!clean) throw new Error('No app name')
  await run('open', ['-a', clean], { timeout: 15000 })
  return `Opened ${clean}`
}

// ---------------------------------------------------------------- documents
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const inline = (s: string): string =>
  esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>')

/** A tiny markdown-to-HTML converter: headings, bullet lists, numbered lists, bold, italics, paragraphs. */
function markdownToHtml(md: string): string {
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  const close = (): void => {
    if (list) out.push(`</${list}>`)
    list = null
  }
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd()
    let m: RegExpMatchArray | null
    if (!line.trim()) { close(); continue }
    if ((m = line.match(/^(#{1,3})\s+(.*)/))) { close(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue }
    if ((m = line.match(/^\s*[-*]\s+(.*)/))) {
      if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul' }
      out.push(`<li>${inline(m[1])}</li>`)
      continue
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol' }
      out.push(`<li>${inline(m[1])}</li>`)
      continue
    }
    close()
    out.push(`<p>${inline(line)}</p>`)
  }
  close()
  return out.join('\n')
}

/** Save a document the pups wrote to ~/Desktop/Whisker Flow and open it. Returns the file path. */
export async function writeDocument(title: string, markdown: string, writtenBy: string, openAfter = true): Promise<string> {
  const dir = join(homedir(), 'Desktop', 'Whisker Flow')
  mkdirSync(dir, { recursive: true })
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'document'
  const file = join(dir, `${slug}.html`)
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body{font-family:-apple-system,'SF Pro Rounded',system-ui,sans-serif;max-width:720px;margin:56px auto;padding:0 24px;color:#2a1b3d;line-height:1.6;background:#fffaf5}
  h1{font-size:34px;margin-bottom:4px} h2{margin-top:32px;color:#b04a72} li{margin:6px 0}
  .by{color:#9a8aa8;font-size:14px;margin-bottom:28px} strong{color:#7a2d54}
</style></head><body>
<h1>${esc(title)}</h1><div class="by">Written by ${esc(writtenBy)} 🐾 with the Whisker Flow pack</div>
${markdownToHtml(markdown)}
</body></html>`
  writeFileSync(file, html)
  if (openAfter) await run('open', [file])
  return file
}
