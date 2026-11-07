import type { Intent, PetProfile } from '../../shared/types'

const canvas = document.getElementById('pet') as HTMLCanvasElement
const ctx = canvas.getContext('2d', { willReadFrequently: true })!
const dogEl = document.getElementById('dog') as HTMLDivElement
const ballEl = document.getElementById('ball') as HTMLDivElement
const bubble = document.getElementById('bubble') as HTMLDivElement
const cmds = document.getElementById('cmds') as HTMLDivElement
const learn = document.getElementById('learn') as HTMLDivElement
const W = canvas.width
const H = canvas.height

// off-screen buffer used to key video frames
const buf = document.createElement('canvas')
buf.width = W
buf.height = H
const bctx = buf.getContext('2d', { willReadFrequently: true })!

// snapshot of the previous frame: crossfaded away whenever the pose/clip changes, so nothing ever "snaps"
const snap = document.createElement('canvas')
snap.width = W
snap.height = H
const sctx = snap.getContext('2d')!
let fadeT = 0
const FADE = 0.18

let profile: PetProfile

// ---- the stage: the pet walks along the bottom edge of the screen ----
const winW = window.innerWidth
const winH = window.innerHeight
const HALF = 190 // half the width of the #dog container: keeps bubbles on screen
const FLOOR = 62 // px between the window bottom and the pet's feet / the ball's resting line
const MOUTH_DX = 62 // mouth is this far in front of the dog's centre
const MOUTH_H = 265 // ...and this high above the floor
let dogX = winW - 260 // centre of the dog
let face = 1 // 1 = facing right, -1 = facing left

// ======================================================================
//  Keying: remove the flat green background from a frame
// ======================================================================
function sampleKey(): number {
  let sum = 0
  let n = 0
  for (const [x, y] of [[2, 2], [W - 10, 2], [2, H - 10], [W - 10, H - 10]]) {
    const d = bctx.getImageData(x, y, 8, 8).data
    for (let i = 0; i < d.length; i += 4) {
      sum += d[i + 1] - Math.max(d[i], d[i + 2])
      n++
    }
  }
  const k = sum / n
  return k > 60 ? k : 160
}

function keyBuffer(dKey: number): ImageData {
  const id = bctx.getImageData(0, 0, W, H)
  const px = id.data
  const lo = dKey * 0.3
  const hi = dKey * 0.62
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i]
    const b = px[i + 2]
    const d = px[i + 1] - (r > b ? r : b)
    if (d >= hi) {
      px[i + 3] = 0
    } else {
      if (d > lo) px[i + 3] = (255 * (hi - d)) / (hi - lo)
      if (d > 6) px[i + 1] -= d * 0.85 // despill the green fringe on fur edges
    }
  }
  return id
}

// ======================================================================
//  Assets (loaded from disk through the main process)
// ======================================================================
type State = 'stand' | 'sit' | 'lie'
const STATES: State[] = ['stand', 'sit', 'lie'] // order along the "ladder"

const stills: Partial<Record<State, ImageBitmap>> = {}
const idle: Partial<Record<State, ImageBitmap[]>> = {}
const clipVid = new Map<string, HTMLVideoElement>()
const clipKey = new Map<string, number>()

async function fileBlob(kind: 'still' | 'clip', name: string, type: string): Promise<Blob | null> {
  const bytes = await window.wf.file(kind, name)
  return bytes ? new Blob([bytes as Uint8Array<ArrayBuffer>], { type }) : null
}

async function loadStill(name: State): Promise<void> {
  const blob = await fileBlob('still', name, 'image/jpeg')
  if (!blob) return
  const img = new Image()
  img.src = URL.createObjectURL(blob)
  await img.decode()
  bctx.clearRect(0, 0, W, H)
  bctx.drawImage(img, 0, 0, W, H)
  stills[name] = await createImageBitmap(keyBuffer(sampleKey()))
}

function waitFor(el: HTMLVideoElement, ev: string): Promise<void> {
  return new Promise((res) => el.addEventListener(ev, () => res(), { once: true }))
}

/** Decode an idle clip once into keyed frames so it can be played forward + backward with no seam. */
async function predecodeIdle(state: State): Promise<void> {
  const blob = await fileBlob('clip', `idle_${state}`, 'video/mp4')
  if (!blob) return
  const v = document.createElement('video')
  v.muted = true
  v.src = URL.createObjectURL(blob)
  await waitFor(v, 'loadeddata')
  const fps = 12
  const count = Math.max(2, Math.floor(v.duration * fps))
  const frames: ImageBitmap[] = []
  let dKey = 0
  for (let i = 0; i < count; i++) {
    v.currentTime = Math.min(i / fps, v.duration - 0.05)
    await waitFor(v, 'seeked')
    bctx.drawImage(v, 0, 0, W, H)
    if (i === 0) dKey = sampleKey()
    frames.push(await createImageBitmap(keyBuffer(dKey)))
  }
  idle[state] = frames
  URL.revokeObjectURL(v.src)
}

async function registerAsset(asset: string): Promise<void> {
  const [kind, name] = asset.split(':')
  if (kind === 'still' && (STATES as string[]).includes(name)) {
    await loadStill(name as State)
  } else if (kind === 'clip') {
    if (name.startsWith('idle_')) {
      await predecodeIdle(name.slice(5) as State)
    } else {
      const blob = await fileBlob('clip', name, 'video/mp4')
      if (blob) {
        // one preloaded element per clip: starting a clip is instant, no src swap, no frozen first frame
        const v = document.createElement('video')
        v.muted = true
        v.playsInline = true
        v.preload = 'auto'
        v.src = URL.createObjectURL(blob)
        clipVid.set(name, v)
      }
    }
  } else if (kind === 'anchor') {
    const a = await window.wf.anchor()
    if (a) mouth.y = a.y * H
    if (a) mouth.x = a.x * W
  }
}

// ======================================================================
//  Playback + state machine
// ======================================================================
let current: State = 'stand'
type Mode = { kind: 'idle' } | { kind: 'video'; v: HTMLVideoElement; dKey: number; loopFrom?: number }
let mode: Mode = { kind: 'idle' }
let hop = 0 // procedural fallback when a clip is missing (seconds into the hop, 0 = off)

/** Change what is on screen, crossfading from whatever was showing. */
function setMode(m: Mode): void {
  sctx.clearRect(0, 0, W, H)
  sctx.drawImage(canvas, 0, 0)
  fadeT = FADE
  mode = m
}

// playback speed per clip: transitions and actions run faster than the raw 4 s so the pet feels snappy
const RATE: Record<string, number> = {
  stand2sit: 1.6, sit2stand: 1.6, sit2lie: 1.5, lie2sit: 1.5,
  bark: 1.4, jump: 1.3, dance: 1.25
}

let epoch = 0 // bumped by every new command: the old one stops and the new one takes over
let cancelPlay: (() => void) | null = null
let landing: State | null = null // pose the running transition ends in (applied instantly if it is cut short)
let activeVideo: HTMLVideoElement | null = null

function keyFor(name: string, v: HTMLVideoElement): number {
  let k = clipKey.get(name)
  if (k === undefined) {
    bctx.drawImage(v, 0, 0, W, H)
    k = sampleKey()
    clipKey.set(name, k)
  }
  return k
}

/** Play a clip with live keying. Resolves false if the clip isn't generated yet. Can be cut short by a new command. */
async function playClip(name: string): Promise<boolean> {
  const v = clipVid.get(name)
  if (!v) return false
  const my = epoch
  v.loop = false
  v.playbackRate = RATE[name] ?? 1.4
  v.currentTime = 0
  if (v.readyState < 2) await waitFor(v, 'loadeddata')
  if (my !== epoch) return true // cut while loading
  const ended = new Promise<void>((res) => {
    v.addEventListener('ended', () => res(), { once: true })
    cancelPlay = () => {
      v.pause()
      res()
    }
  })
  activeVideo = v
  await v.play()
  if (my !== epoch) return true
  setMode({ kind: 'video', v, dKey: keyFor(name, v) }) // switch only once frames are really flowing
  await ended
  cancelPlay = null
  return true
}

/** Start a clip that repeats until stopped (walk / run cycles). */
async function startLoop(name: string, my: number): Promise<boolean> {
  const v = clipVid.get(name)
  if (!v) return false
  v.loop = false
  v.playbackRate = 0.6
  v.currentTime = 0
  if (v.readyState < 2) await waitFor(v, 'loadeddata')
  if (my !== epoch) return false
  activeVideo = v
  await v.play()
  if (my !== epoch) return false
  setMode({ kind: 'video', v, dKey: keyFor(name, v), loopFrom: 0.8 }) // skip the stand-pose lead-in on repeat
  return true
}

async function goTo(target: State, my: number): Promise<void> {
  while (current !== target && my === epoch) {
    const i = STATES.indexOf(current)
    const next = STATES[i + (STATES.indexOf(target) > i ? 1 : -1)]
    landing = next
    const ok = await playClip(`${current}2${next}`)
    if (!ok) hop = 0.001 // no clip yet: hop to the new pose instead
    if (landing) current = landing
    landing = null
    setMode({ kind: 'idle' })
  }
}

async function action(name: string, my: number): Promise<void> {
  await goTo('stand', my)
  if (my !== epoch) return
  const ok = await playClip(name)
  if (!ok) hop = 0.001
  if (my === epoch) setMode({ kind: 'idle' })
}

/** Latest command wins: cut whatever is playing (snapping to its end pose) and start the new one right away. */
function begin(job: (my: number) => Promise<void>): void {
  epoch++
  if (landing) {
    current = landing
    landing = null
  }
  cancelPlay?.()
  cancelPlay = null
  activeVideo?.pause()
  if (walk) {
    const done = walk.done
    walk = null
    done()
  }
  if (ball.state === 'carried' || ball.state === 'grab') dropBall()
  setMode({ kind: 'idle' })
  void job(epoch).catch((e) => console.warn('[anim]', e))
}

// ======================================================================
//  Walking along the bottom of the screen
// ======================================================================
interface Walk {
  x: number
  speed: number // top ground speed (px/s); also the speed at which the gait clip plays at 1x
  track?: () => number // follow a moving target (the ball) instead of a fixed x
  until?: () => boolean // only count as arrived when this is true
  done: () => void
}
let walk: Walk | null = null
let vel = 0 // current ground speed, signed
let walkTx = 0 // smoothed chase target
let faceS = 1 // animated facing (passes through 0 when turning around)

async function moveTo(
  x: number,
  kind: 'walk' | 'run',
  my: number,
  opts: { track?: () => number; until?: () => boolean } = {}
): Promise<void> {
  await goTo('stand', my)
  if (my !== epoch) return
  const clip = clipVid.has(kind) ? kind : clipVid.has('walk') ? 'walk' : ''
  if (clip) await startLoop(clip, my)
  if (my !== epoch) return
  walkTx = opts.track ? opts.track() : x
  await new Promise<void>((res) => {
    walk = { x: Math.max(HALF, Math.min(winW - HALF, x)), speed: kind === 'run' ? 520 : 230, ...opts, done: res }
  })
  if (my !== epoch) return
  activeVideo?.pause()
  setMode({ kind: 'idle' })
}

async function resolveTarget(t: string): Promise<number> {
  switch (t) {
    case 'left_edge': return HALF
    case 'right_edge': return winW - HALF
    case 'center': return winW / 2
    case 'a_bit_left': return dogX - 320
    case 'a_bit_right': return dogX + 320
    default: return (await window.wf.cursorX()) ?? winW / 2 // 'cursor': come here
  }
}

// ======================================================================
//  The ball: drag + release to throw. The dog chases it, picks it up, brings it back.
// ======================================================================
const ball = {
  x: winW - 70, y: 0, vx: 0, vy: 0, rot: 0,
  state: 'rest' as 'rest' | 'drag' | 'fly' | 'grab' | 'carried',
  gt: 0, gx: 0, gy: 0, onGrab: null as (() => void) | null
}

// where the dog's mouth is, in canvas pixels of the (unflipped) sprite; tracked from the pixels while a clip plays
const mouth = { x: 0.78 * W, y: 0.285 * H }
const SC = 270 / W // canvas px -> screen px

/** World position (x along the strip, y up from the window bottom) of the dog's mouth right now. */
function mouthWorld(): { x: number; y: number } {
  const mx = face > 0 ? mouth.x : W - mouth.x
  return { x: dogX - 135 + mx * SC, y: (H - mouth.y) * SC }
}

/** Find the nose tip: the right-most solid pixel in a thin band around the last known mouth height. */
function trackMouth(d: Uint8ClampedArray): void {
  const my = Math.round(mouth.y)
  let bestX = -1
  let bestY = my
  for (let y = Math.max(0, my - 24); y <= Math.min(H - 1, my + 24); y += 2) {
    for (let x = W - 1; x > bestX + 2; x -= 3) {
      if (d[(y * W + x) * 4 + 3] > 128) {
        bestX = x
        bestY = y
        break
      }
    }
  }
  if (bestX > 0) {
    mouth.x += (bestX - mouth.x) * 0.5
    mouth.y += (bestY - mouth.y) * 0.3
  }
}

function dropBall(): void {
  const m = mouthWorld()
  ball.x = m.x
  ball.y = Math.max(0, m.y - FLOOR - 19)
  ball.vx = face * 90
  ball.vy = 0
  ball.state = 'fly'
}

function stepBall(dt: number): void {
  let scale = 1
  if (ball.state === 'carried' || ball.state === 'grab') {
    const m = mouthWorld()
    const tx = m.x - face * 9 // tucked just inside the mouth
    const ty = m.y - 8 - FLOOR - 19
    if (ball.state === 'grab') {
      ball.gt = Math.min(1, ball.gt + dt / 0.3)
      const e = 1 - (1 - ball.gt) ** 2
      ball.x = ball.gx + (tx - ball.gx) * e
      ball.y = ball.gy + (ty - ball.gy) * e + Math.sin(Math.PI * ball.gt) * 60 // it hops up into the mouth
      if (ball.gt >= 1) {
        ball.state = 'carried'
        ball.onGrab?.()
        ball.onGrab = null
      }
    } else {
      ball.x = tx
      ball.y = ty
    }
    scale = 0.82
  } else if (ball.state === 'fly') {
    if (!(ball.y === 0 && ball.vy === 0)) {
      ball.vy -= 2400 * dt
      ball.y += ball.vy * dt
      if (ball.y <= 0) {
        ball.y = 0
        ball.vy = Math.abs(ball.vy) > 170 ? -ball.vy * 0.55 : 0
        ball.vx *= 0.9
      }
    } else {
      ball.vx *= 1 - 2.4 * dt // rolling friction
    }
    ball.x += ball.vx * dt
    if (ball.x < 22) { ball.x = 22; ball.vx = Math.abs(ball.vx) * 0.7 }
    if (ball.x > winW - 22) { ball.x = winW - 22; ball.vx = -Math.abs(ball.vx) * 0.7 }
    ball.rot += ball.vx * dt * 1.4
    if (ball.y === 0 && ball.vy === 0 && Math.abs(ball.vx) < 14) {
      ball.vx = 0
      ball.state = 'rest'
    }
  }
  ballEl.style.transform = `translate(${ball.x}px, ${-(FLOOR + ball.y)}px) rotate(${ball.rot}deg) scale(${scale})`
}

const sleep = (ms: number, my: number): Promise<void> =>
  new Promise((res) => setTimeout(res, ms)).then(() => {
    if (my !== epoch) return
  })

async function fetchFlow(my: number, homeX: number): Promise<void> {
  await goTo('stand', my)
  if (my !== epoch) return
  // chase the ball (it may still be flying), then wait until it has stopped
  await moveTo(0, 'run', my, { track: () => ball.x, until: () => ball.state === 'rest' })
  if (my !== epoch) return
  // pick it up: the ball hops from the floor into the mouth
  ball.gx = ball.x
  ball.gy = ball.y
  ball.gt = 0
  ball.state = 'grab'
  say('Got it!', 1800)
  await new Promise<void>((res) => (ball.onGrab = res))
  if (my !== epoch) return
  await sleep(150, my)
  if (my !== epoch) return
  await moveTo(homeX, 'run', my)
  if (my !== epoch) return
  dropBall()
  say('Here you go!', 2500)
}

function throwBall(vx: number, vy: number, homeX: number): void {
  ball.vx = vx
  ball.vy = vy
  ball.state = 'fly'
  begin((my) => fetchFlow(my, Math.max(HALF, Math.min(winW - HALF, homeX))))
}

/** "Fetch": throw the ball from where it lies, away from the nearest screen edge. */
function autoThrow(): void {
  if (ball.state === 'carried' || ball.state === 'grab') dropBall()
  const dir = ball.x > winW / 2 ? -1 : 1
  const home = ball.x
  ball.y = Math.max(ball.y, 20)
  throwBall(dir * (1100 + Math.random() * 500), 760 + Math.random() * 240, home)
}

// drag + flick
let dragging = false
let samples: { t: number; x: number; y: number }[] = []
ballEl.addEventListener('pointerdown', (e) => {
  if (ball.state === 'carried' || ball.state === 'grab') return
  ballEl.setPointerCapture(e.pointerId)
  dragging = true
  ball.state = 'drag'
  ballEl.classList.add('drag')
  samples = [{ t: performance.now(), x: e.clientX, y: e.clientY }]
})
ballEl.addEventListener('pointermove', (e) => {
  if (!dragging) return
  ball.x = e.clientX
  ball.y = Math.max(0, winH - e.clientY - 19 - FLOOR)
  ball.vx = ball.vy = 0
  samples.push({ t: performance.now(), x: e.clientX, y: e.clientY })
})
ballEl.addEventListener('pointerup', (e) => {
  if (!dragging) return
  dragging = false
  ballEl.classList.remove('drag')
  const now = performance.now()
  const recent = samples.filter((s) => now - s.t < 110)
  const a = recent[0] ?? samples[0]
  const b = samples[samples.length - 1]
  const dt = Math.max((b.t - a.t) / 1000, 0.016)
  let vx = (b.x - a.x) / dt
  let vy = -(b.y - a.y) / dt
  const sp = Math.hypot(vx, vy)
  if (sp > 2800) { vx *= 2800 / sp; vy *= 2800 / sp }
  if (sp < 120) { vx = 0; vy = 0 } // just put it down
  if (sp < 120 && ball.y === 0) {
    ball.state = 'rest'
    return
  }
  throwBall(vx, vy, e.clientX)
})

// ======================================================================
//  Speech bubble + voice
// ======================================================================
let bubbleTimer = 0
function say(text: string, ms = 3500, voice = true): void {
  bubble.textContent = text
  bubble.classList.add('show')
  window.clearTimeout(bubbleTimer)
  bubbleTimer = window.setTimeout(() => bubble.classList.remove('show'), ms)
  if (voice) void talk(text)
}

let currentAudio: HTMLAudioElement | null = null
async function talk(text: string): Promise<void> {
  currentAudio?.pause()
  speechSynthesis.cancel()
  try {
    const r = await window.wf.speak(text)
    if (r.ok) {
      currentAudio = new Audio(`data:audio/mpeg;base64,${r.audio}`)
      await currentAudio.play()
      return
    }
  } catch {
    /* fall through to the browser voice */
  }
  const u = new SpeechSynthesisUtterance(text)
  u.pitch = 1.5
  u.rate = 1.05
  speechSynthesis.speak(u)
}

// ======================================================================
//  Commands
// ======================================================================
const MOVE_LINES: Record<string, string> = {
  cursor: 'Coming!',
  left_edge: 'Heading left!',
  right_edge: 'Heading right!',
  center: 'To the middle!',
  a_bit_left: 'Okay, a little left.',
  a_bit_right: 'Okay, a little right.'
}

function moveCommand(target: string): void {
  say(MOVE_LINES[target] ?? 'On my way!', 2200)
  begin(async (my) => {
    const x = await resolveTarget(target)
    if (my !== epoch) return
    await moveTo(x, Math.abs(x - dogX) > 600 ? 'run' : 'walk', my)
  })
}

function run(cmd: string): void {
  const cat = profile.species === 'cat'
  switch (cmd) {
    case 'sit':
      say('Sitting pretty!')
      begin((my) => goTo('sit', my))
      break
    case 'sleep':
      say('Okay… nap time. Zzz.')
      begin((my) => goTo('lie', my))
      break
    case 'jump':
      say('Wheee!')
      begin((my) => action('jump', my))
      break
    case 'dance':
      say('Watch my moves!')
      begin((my) => action('dance', my))
      break
    case 'speak':
      say(cat ? 'Meow meow!' : 'Woof woof!')
      begin((my) => action('bark', my))
      break
    case 'good_boy':
      say(cat ? 'Purr. I know.' : 'Who, me? Best day ever!')
      begin((my) => action('bark', my))
      break
    case 'fetch':
      say('Fetch! Here I go!', 2000)
      autoThrow()
      break
    case 'come':
      moveCommand('cursor')
      break
  }
}

document.querySelectorAll<HTMLButtonElement>('#cmds button').forEach((b) => {
  b.onclick = (e) => {
    e.stopPropagation()
    run(b.dataset.cmd as string)
  }
})

// ---------- hold the pet to talk ----------
let recorder: MediaRecorder | null = null
let chunks: Blob[] = []
let stream: MediaStream | null = null
let holdTimer = 0
let listening = false
let cmdTimer = 0

async function startListening(): Promise<void> {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    say('I need microphone access to hear you.', 4000, false)
    return
  }
  chunks = []
  recorder = new MediaRecorder(stream)
  recorder.ondataavailable = (e) => chunks.push(e.data)
  recorder.start()
  listening = true
  bubble.textContent = 'Listening…'
  bubble.classList.add('show')
}

async function stopListening(): Promise<void> {
  if (!recorder || !listening) return
  listening = false
  const rec = recorder
  const done = new Promise<void>((r) => (rec.onstop = () => r()))
  rec.stop()
  stream?.getTracks().forEach((t) => t.stop())
  await done
  const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
  if (blob.size < 2000) {
    bubble.classList.remove('show')
    return
  }
  bubble.textContent = 'Thinking…'
  const b64 = await new Promise<string>((res) => {
    const fr = new FileReader()
    fr.onload = () => res(String(fr.result).split(',')[1] ?? '')
    fr.readAsDataURL(blob)
  })
  handleIntent(await window.wf.interpret(b64, (blob.type || 'audio/webm').split(';')[0]))
}

function handleIntent(i: Intent): void {
  switch (i.kind) {
    case 'pet_command':
      run(i.command)
      break
    case 'move_to':
      moveCommand(i.target)
      break
    case 'play_ball':
      run('fetch')
      break
    case 'chat':
      say(i.reply, 5000)
      break
    case 'browser_task':
      say(i.ack, 4000)
      startTask(i.goal)
      break
    case 'look_at_screen':
      say('Let me take a look…', 3000) // screen glance plugs in here
      break
    default:
      say("Hmm, I didn't catch that. Try again?", 3000)
      console.warn('[intent]', i.message)
  }
}

// ---------- the browser agent: the pet sits "at work", narrates each step, then reports back ----------
let taskRunning = false
function startTask(goal: string): void {
  taskRunning = true
  begin((my) => goTo('sit', my))
  void window.wf.runTask(goal)
}
window.wf.onAgent((e) => {
  if (!taskRunning && e.type !== 'done') return
  if (e.type === 'step') {
    say(e.text, 4200)
  } else if (e.type === 'done') {
    taskRunning = false
    begin((my) => action('jump', my))
    say(e.text, Math.max(6000, e.text.length * 90))
  } else if (e.type === 'ask') {
    taskRunning = false
    say(e.text, Math.max(6000, e.text.length * 90))
  } else {
    taskRunning = false
    say('Oops, I got stuck on that one. Want to try again?', 5000)
    console.warn('[agent]', e.text)
  }
})

// Tap = greet + show commands. Hold (>350 ms) = talk to the pet.
canvas.addEventListener('pointerdown', () => {
  holdTimer = window.setTimeout(() => void startListening(), 350)
})
canvas.addEventListener('pointerup', () => {
  if (listening) {
    void stopListening()
    return
  }
  window.clearTimeout(holdTimer)
  if (taskRunning) {
    taskRunning = false
    window.wf.stopTask()
    say('Okay, stopping!', 2500)
    return
  }
  say(`Hey! I'm ${profile.name}. How may I help you?`, 4500)
  cmds.classList.add('show')
  window.clearTimeout(cmdTimer)
  cmdTimer = window.setTimeout(() => cmds.classList.remove('show'), 12000)
})

// ---------- click-through: only the pet, the ball and the buttons catch the mouse ----------
let solid = false
document.addEventListener('mousemove', (e) => {
  let hit = dragging
  if (!hit) {
    const r = canvas.getBoundingClientRect()
    if (e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom) {
      let x = Math.floor(((e.clientX - r.left) / r.width) * W)
      const y = Math.floor(((e.clientY - r.top) / r.height) * H)
      if (faceS < 0) x = W - 1 - x
      hit = ctx.getImageData(Math.max(0, Math.min(W - 1, x)), y, 1, 1).data[3] > 30
    }
  }
  if (!hit) {
    const b = ballEl.getBoundingClientRect()
    hit = e.clientX > b.left - 6 && e.clientX < b.right + 6 && e.clientY > b.top - 6 && e.clientY < b.bottom + 6
  }
  if (!hit) {
    const el = document.elementFromPoint(e.clientX, e.clientY)
    if (el && el.closest('#cmds.show')) hit = true
  }
  if (hit !== solid) {
    solid = hit
    window.wf.setClickThrough(!hit)
  }
})

// ======================================================================
//  Render loop
// ======================================================================
let last = performance.now()
let arriveT = 0
let idleI = 0
let idleDir = 1
let idleClock = 0

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.05)
  last = now
  arriveT += dt
  const t = now / 1000

  // walking: real acceleration, slowing down on arrival, gait clip speed tied to ground speed
  if (walk) {
    const w = walk
    const raw = w.track ? w.track() : w.x
    walkTx += (raw - walkTx) * Math.min(1, dt * 14) // smooth the chase target so it never jerks
    if (w.track ? Math.abs(raw - dogX) > 22 : Math.abs(w.x - dogX) > 2) face = (w.track ? raw : w.x) > dogX ? 1 : -1
    const m = mouthWorld()
    const aim = w.track ? Math.max(HALF, Math.min(winW - HALF, walkTx - (m.x - dogX) - face * 4)) : walkTx
    const diff = aim - dogX
    const dist = Math.abs(diff)
    const accel = w.speed * 2.4
    const vWant = Math.sign(diff) * Math.min(w.speed, Math.sqrt(2 * accel * 0.65 * dist))
    const dv = vWant - vel
    vel += Math.max(-accel * dt, Math.min(accel * dt, dv))
    dogX += vel * dt
    if (activeVideo) activeVideo.playbackRate = Math.max(0.4, Math.min(2, Math.abs(vel) / w.speed + 0.15))
    if (dist < 5 && Math.abs(vel) < 25 && (!w.until || w.until())) {
      walk = null
      vel = 0
      w.done()
    }
  } else {
    vel = 0
  }
  faceS += (face - faceS) * Math.min(1, dt * 16)
  dogEl.style.transform = `translateX(${dogX - HALF}px)`
  stepBall(dt)

  ctx.clearRect(0, 0, W, H)
  let fx = ''

  if (mode.kind === 'video') {
    const v = mode.v
    if (mode.loopFrom !== undefined && v.duration && v.currentTime >= v.duration - 0.1) v.currentTime = mode.loopFrom
    bctx.drawImage(v, 0, 0, W, H)
    const id = keyBuffer(mode.dKey)
    ctx.putImageData(id, 0, 0)
    trackMouth(id.data)
  } else {
    const frames = idle[current]
    if (frames && frames.length > 1) {
      // seamless ping-pong loop
      idleClock += dt
      if (idleClock > 1 / 12) {
        idleClock = 0
        idleI += idleDir
        if (idleI >= frames.length - 1) idleDir = -1
        if (idleI <= 0) idleDir = 1
        idleI = Math.max(0, Math.min(frames.length - 1, idleI))
      }
      ctx.drawImage(frames[idleI], 0, 0)
    } else if (stills[current]) {
      ctx.drawImage(stills[current] as ImageBitmap, 0, 0)
      const br = Math.sin(t * 2.2) * 0.012 // no idle clip yet: breathe procedurally
      fx += ` scale(${1 - br * 0.5}, ${1 + br})`
    }
  }

  // crossfade from the previous pose/clip so changes never snap
  if (fadeT > 0) {
    ctx.globalAlpha = Math.min(1, fadeT / FADE)
    ctx.drawImage(snap, 0, 0)
    ctx.globalAlpha = 1
    fadeT -= dt
  }

  // procedural extras: drop-in arrival, and a hop standing in for any clip that hasn't generated yet
  let y = 0
  if (arriveT < 0.9) {
    const k = arriveT / 0.9
    y = k < 0.7 ? -520 * (1 - (k / 0.7) ** 2) : -Math.sin(((k - 0.7) / 0.3) * Math.PI) * 30
  }
  if (hop > 0) {
    hop += dt
    if (hop > 0.7) hop = 0
    else y -= Math.sin((hop / 0.7) * Math.PI) * 70
  }
  canvas.style.transform = `translateY(${y}px) scaleX(${faceS})${fx}`
  requestAnimationFrame(frame)
}

// ======================================================================
//  Boot
// ======================================================================
void (async () => {
  const p = await window.wf.getProfile()
  if (!p) return
  profile = p

  // wait for the standing still so the very first frame is already the pet
  await loadStill('stand')
  const anchor = await window.wf.anchor()
  if (anchor) {
    mouth.x = anchor.x * W
    mouth.y = anchor.y * H
  }
  for (const a of await window.wf.assets()) await registerAsset(a)
  requestAnimationFrame(frame)
  window.setTimeout(() => say(`Hi, I'm ${profile.name}! Tap me, or hold me to talk.`, 4500), 1000)

  // pre-generate the pet's stock lines so they play instantly (cached on disk by the main process)
  void (async () => {
    const cat = profile.species === 'cat'
    for (const line of [
      `Hey! I'm ${profile.name}. How may I help you?`,
      `Hi, I'm ${profile.name}! Tap me, or hold me to talk.`,
      'Sitting pretty!', 'Wheee!', 'Watch my moves!', 'Okay… nap time. Zzz.',
      cat ? 'Meow meow!' : 'Woof woof!',
      cat ? 'Purr. I know.' : 'Who, me? Best day ever!',
      "Hmm, I didn't catch that. Try again?",
      'Fetch! Here I go!', 'Got it!', 'Here you go!',
      ...Object.values(MOVE_LINES)
    ]) await window.wf.speak(line).catch(() => null)
  })()

  window.wf.onAssetReady((a) => void registerAsset(a))
  window.wf.onProgress((pr) => {
    if (pr.finished) {
      learn.textContent = pr.done >= pr.total ? 'All tricks learned!' : `Learned ${pr.done}/${pr.total} tricks`
      window.setTimeout(() => learn.classList.remove('show'), 3000)
    } else {
      learn.textContent = `Learning tricks… ${pr.done}/${pr.total}`
      learn.classList.add('show')
    }
  })
})()
