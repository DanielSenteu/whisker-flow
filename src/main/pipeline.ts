import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { generateClip, generateStill, poseFromStandPrompt, standPrompt } from './gemini'

export const petDir = (): string => join(app.getPath('userData'), 'pet')
const stillPath = (n: string): string => join(petDir(), 'stills', `${n}.jpg`)
const clipPath = (n: string): string => join(petDir(), 'clips', `${n}.mp4`)

export function resetPetFiles(): void {
  rmSync(petDir(), { recursive: true, force: true })
}

export function hasBase(): boolean {
  return existsSync(stillPath('stand'))
}

/** Names of everything already generated, e.g. ["still:stand", "clip:stand2sit"]. */
export function listAssets(): string[] {
  const out: string[] = []
  for (const n of ['stand', 'sit', 'lie']) if (existsSync(stillPath(n))) out.push(`still:${n}`)
  for (const c of CLIPS) if (existsSync(clipPath(c.name))) out.push(`clip:${c.name}`)
  return out
}

export function readAsset(kind: 'still' | 'clip', name: string): Buffer | null {
  if (!/^[a-z0-9_]+$/.test(name)) return null
  const p = kind === 'still' ? stillPath(name) : clipPath(name)
  return existsSync(p) ? readFileSync(p) : null
}

function save(path: string, data: Buffer): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, data)
}

/** Photo in, standing character out. Written to disk; the base64 JPEG is returned for the reveal. */
export async function createBase(photoDataUrl: string, species: string): Promise<string> {
  resetPetFiles()
  const b64 = await generateStill(standPrompt(species), [photoDataUrl])
  save(join(petDir(), 'photo.jpg'), Buffer.from(photoDataUrl.split(',')[1], 'base64'))
  save(stillPath('stand'), Buffer.from(b64, 'base64'))
  return b64
}

interface ClipSpec {
  name: string
  from: string[] // keyframe names: one = animate it, two = first frame -> last frame
  seconds: number
  prompt: string
}

// Ordered by how soon the pet needs them.
const CLIPS: ClipSpec[] = [
  {
    name: 'idle_stand',
    from: ['stand'],
    seconds: 4,
    prompt:
      'The pet stands in place breathing gently, blinks softly, its ears twitch slightly and its tail sways slowly. Very subtle lifelike idle motion, it stays in the same position.'
  },
  {
    name: 'stand2sit',
    from: ['stand', 'sit'],
    seconds: 4,
    prompt:
      'Animate from the first image to the second: the pet is standing, then smoothly and naturally sits down on its haunches, ending in exactly the pose of the second image. Natural weight shift, tail swishing as it sits.'
  },
  {
    name: 'sit2lie',
    from: ['sit', 'lie'],
    seconds: 4,
    prompt:
      'Animate from the first image to the second: the pet is sitting, then lowers itself, lies on its belly and rests its head on its front paws, closing its eyes, ending in exactly the pose of the second image.'
  },
  {
    name: 'bark',
    from: ['stand'],
    seconds: 4,
    prompt:
      'The pet stands in place, perks its ears, lifts its head and speaks out happily twice with its mouth opening, tail wagging, then settles back into the starting pose.'
  },
  {
    name: 'idle_sit',
    from: ['sit'],
    seconds: 4,
    prompt:
      'The pet sits in place breathing gently, blinks softly, its ears twitch slightly and its tail tip sways. Very subtle lifelike idle motion, it stays in the same position.'
  },
  {
    name: 'idle_lie',
    from: ['lie'],
    seconds: 4,
    prompt:
      'The pet sleeps peacefully, slow deep breathing with its body gently rising and falling, an ear twitching once. Very subtle motion, it stays in the same position.'
  },
  {
    name: 'sit2stand',
    from: ['sit', 'stand'],
    seconds: 4,
    prompt:
      'Animate from the first image to the second: the pet is sitting, then stands up smoothly and naturally on all four legs, ending in exactly the pose of the second image.'
  },
  {
    name: 'lie2sit',
    from: ['lie', 'sit'],
    seconds: 4,
    prompt:
      'Animate from the first image to the second: the pet is lying down asleep, then wakes, lifts its head and pushes itself up into a sitting position, ending in exactly the pose of the second image.'
  },
  {
    name: 'jump',
    from: ['stand'],
    seconds: 4,
    prompt:
      'The pet crouches slightly then jumps joyfully straight up with all four paws leaving the ground, and lands back in exactly the same spot, finishing in the starting pose.'
  },
  {
    name: 'dance',
    from: ['stand'],
    seconds: 5,
    prompt:
      'The pet does a happy wiggle dance in place: bouncing on its paws, tail wagging fast, head bobbing side to side, then settles back into the starting pose.'
  }
]

let running = false

/**
 * Generate the rest of the pet in the background: sit + lie keyframes, then every clip (3 at a time).
 * Everything is cached on disk, so re-running only fills the gaps. Progress is pushed to the pet window.
 */
export async function runPipeline(species: string, getWin: () => BrowserWindow | null): Promise<void> {
  if (running || !hasBase()) return
  running = true
  const send = (ch: string, payload: unknown): void => {
    const w = getWin()
    if (w && !w.isDestroyed()) w.webContents.send(ch, payload)
  }
  const total = CLIPS.length + 2
  const progress = (): void => send('pet:progress', { done: listAssets().length - 1, total })
  try {
    const photoUrl = `data:image/jpeg;base64,${readFileSync(join(petDir(), 'photo.jpg')).toString('base64')}`
    const standUrl = `data:image/jpeg;base64,${readFileSync(stillPath('stand')).toString('base64')}`

    const poses: [string, string][] = [
      ['sit', 'but sitting on its haunches, front legs straight, head up, happy and alert'],
      ['lie', 'but lying down on the ground, front paws stretched forward, head resting on them, eyes closed, sleeping peacefully']
    ]
    await Promise.all(
      poses.map(async ([name, desc]) => {
        if (existsSync(stillPath(name))) return
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const b64 = await generateStill(poseFromStandPrompt(desc), [photoUrl, standUrl])
            save(stillPath(name), Buffer.from(b64, 'base64'))
            send('pet:asset-ready', `still:${name}`)
            progress()
            return
          } catch (e) {
            console.warn(`[pipeline] still ${name} attempt ${attempt + 1}:`, (e as Error).message)
          }
        }
      })
    )

    const queue = CLIPS.filter((c) => !existsSync(clipPath(c.name)))
    const worker = async (): Promise<void> => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        if (!c.from.every((k) => existsSync(stillPath(k)))) continue // a keyframe failed, skip its clips
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const imgs = c.from.map((k) => readFileSync(stillPath(k)).toString('base64'))
            save(clipPath(c.name), await generateClip(imgs, c.prompt, c.seconds))
            send('pet:asset-ready', `clip:${c.name}`)
            progress()
            break
          } catch (e) {
            console.warn(`[pipeline] clip ${c.name} attempt ${attempt + 1}:`, (e as Error).message)
          }
        }
      }
    }
    await Promise.all([worker(), worker(), worker()])
  } finally {
    running = false
    send('pet:progress', { done: listAssets().length - 1, total, finished: true })
  }
}
