import { app } from 'electron'
import { createHash } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// A premade ElevenLabs voice; override with ELEVENLABS_VOICE_ID once a cuter one is picked.
const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'

/** Text in, mp3 (base64) out. Results are cached on disk so repeat lines play instantly. */
export async function speak(text: string): Promise<string> {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set')
  const voice = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE
  const model = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2'
  const settings = {
    stability: Number(process.env.ELEVENLABS_STABILITY ?? 0.38), // lower = more expressive, less monotone
    similarity_boost: 0.78,
    style: Number(process.env.ELEVENLABS_STYLE ?? 0.4),
    use_speaker_boost: true
  }
  const dir = join(app.getPath('userData'), 'tts-cache')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, createHash('sha1').update(`${voice}|${model}|${JSON.stringify(settings)}|${text}`).digest('hex') + '.mp3')
  const cached = existsSync(file)
  try {
    appendFileSync(join(dir, '..', 'tts.log'), `${new Date().toISOString()} voice=${voice} model=${model} cached=${cached} chars=${text.length}\n`)
  } catch { /* logging is best effort */ }
  if (cached) return readFileSync(file).toString('base64')

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: model, voice_settings: settings })
    }
  )
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(file, buf)
  return buf.toString('base64')
}
