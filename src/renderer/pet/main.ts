import type { Intent, PetProfile } from '../../shared/types'

const canvas = document.getElementById('pet') as HTMLCanvasElement
const ctx = canvas.getContext('2d', { willReadFrequently: true })!
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

let profile: PetProfile

// ======================================================================
//  Keying: remove the flat green background from a frame
// ======================================================================
function sampleKey(): number {
  // how "green-dominant" the background is, measured from the four corners
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
const clipUrl = new Map<string, string>()

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
  if (current === state) mode = { kind: 'idle' }
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
      if (blob) clipUrl.set(name, URL.createObjectURL(blob))
    }
  }
}

// ======================================================================
//  Playback + state machine
// ======================================================================
let current: State = 'stand'
type Mode = { kind: 'idle' } | { kind: 'video'; v: HTMLVideoElement; dKey: number }
let mode: Mode = { kind: 'idle' }
let hop = 0 // procedural fallback when a clip is missing (seconds into the hop, 0 = off)

const video = document.createElement('video')
video.muted = true
video.playsInline = true

// playback speed per clip: transitions and actions run faster than the raw 4 s so the pet feels snappy
const RATE: Record<string, number> = {
  stand2sit: 1.6, sit2stand: 1.6, sit2lie: 1.5, lie2sit: 1.5,
  bark: 1.4, jump: 1.3, dance: 1.25
}

let epoch = 0 // bumped by every new command: the old one stops and the new one takes over
let cancelPlay: (() => void) | null = null
let landing: State | null = null // pose the running transition ends in (applied instantly if it is cut short)

/** Play a clip with live keying. Resolves false if the clip isn't generated yet. Can be cut short by a new command. */
async function playClip(name: string): Promise<boolean> {
  const url = clipUrl.get(name)
  if (!url) return false
  const my = epoch
  video.src = url
  video.playbackRate = RATE[name] ?? 1.4
  await waitFor(video, 'loadeddata')
  if (my !== epoch) return true // cut while loading
  bctx.drawImage(video, 0, 0, W, H)
  const dKey = sampleKey()
  const ended = new Promise<void>((res) => {
    video.addEventListener('ended', () => res(), { once: true })
    cancelPlay = () => {
      video.pause()
      res()
    }
  })
  mode = { kind: 'video', v: video, dKey }
  await video.play()
  await ended
  cancelPlay = null
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
    mode = { kind: 'idle' }
  }
}

async function action(name: string, my: number): Promise<void> {
  await goTo('stand', my)
  if (my !== epoch) return
  const ok = await playClip(name)
  if (!ok) hop = 0.001
  mode = { kind: 'idle' }
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
  mode = { kind: 'idle' }
  void job(epoch).catch((e) => console.warn('[anim]', e))
}

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
    case 'chat':
      say(i.reply, 5000)
      break
    case 'browser_task':
      say(i.ack, 4000)
      console.log('[task]', i.goal) // the browser agent plugs in here
      break
    case 'look_at_screen':
      say('Let me take a look…', 3000) // screen glance plugs in here
      break
    default:
      say("Hmm, I didn't catch that. Try again?", 3000)
      console.warn('[intent]', i.message)
  }
}

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
  say(`Hey! I'm ${profile.name}. How may I help you?`, 4500)
  cmds.classList.add('show')
  window.clearTimeout(cmdTimer)
  cmdTimer = window.setTimeout(() => cmds.classList.remove('show'), 12000)
})

// ---------- click-through: only the pet itself (and its bubbles/buttons) catches the mouse ----------
let solid = false
document.addEventListener('mousemove', (e) => {
  const r = canvas.getBoundingClientRect()
  let hit = false
  if (e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom) {
    const x = Math.floor(((e.clientX - r.left) / r.width) * W)
    const y = Math.floor(((e.clientY - r.top) / r.height) * H)
    hit = ctx.getImageData(x, y, 1, 1).data[3] > 30
  }
  const el = document.elementFromPoint(e.clientX, e.clientY)
  if (el && el !== document.body && el !== document.documentElement && el !== canvas && el.closest('#cmds.show')) hit = true
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

  ctx.clearRect(0, 0, W, H)
  let fx = ''

  if (mode.kind === 'video') {
    bctx.drawImage(mode.v, 0, 0, W, H)
    ctx.putImageData(keyBuffer(mode.dKey), 0, 0)
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
      // no idle clip yet: breathe procedurally
      const br = Math.sin(t * 2.2) * 0.012
      fx += ` scale(${1 - br * 0.5}, ${1 + br})`
    }
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
  canvas.style.transform = `translateY(${y}px)${fx}`
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
      "Hmm, I didn't catch that. Try again?"
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
