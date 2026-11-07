import type { Intent, PetProfile, PoseName } from '../../shared/types'
import { keyOutGreen, onGreen } from '../shared/chroma'

const img = document.getElementById('pet') as HTMLImageElement
const bubble = document.getElementById('bubble') as HTMLDivElement
const cmds = document.getElementById('cmds') as HTMLDivElement

let profile: PetProfile
let pose: PoseName = 'idle'
type Action = 'none' | 'arrive' | 'jump' | 'dance' | 'speak'
let action: Action = 'arrive'
let actionT = 0

// ---------- poses ----------
const EXTRA_POSES: { name: PoseName; prompt: string }[] = [
  {
    name: 'happy',
    prompt: 'standing on all four legs, mouth open in a big joyful smile, tail up and wagging, one front paw lifted, full of energy'
  },
  { name: 'sleep', prompt: 'curled up asleep on the ground, eyes closed, peaceful, head resting on its front paws' }
]

function setPose(p: PoseName): void {
  pose = profile.sprites[p] ? p : 'idle'
  img.src = profile.sprites[pose] as string
}

/** Generate any missing poses one by one in the background and save them as they land. */
async function fillPoses(): Promise<void> {
  for (const { name, prompt } of EXTRA_POSES) {
    if (profile.sprites[name] || !profile.photo) continue
    try {
      const ref = await onGreen(profile.sprites.idle as string)
      const r = await window.wf.generateCharacter(profile.photo, profile.species, prompt, ref)
      if (!r.ok) throw new Error(r.error)
      profile.sprites[name] = await keyOutGreen(`data:${r.image.mimeType};base64,${r.image.base64}`)
      await window.wf.saveProfile(profile)
    } catch (e) {
      console.warn(`[pose:${name}]`, (e as Error).message)
    }
  }
}

// ---------- speech ----------
let bubbleTimer = 0
function say(text: string, ms = 3500, voice = true): void {
  bubble.textContent = text
  bubble.classList.add('show')
  window.clearTimeout(bubbleTimer)
  bubbleTimer = window.setTimeout(() => bubble.classList.remove('show'), ms)
  if (voice) void talk(text)
}

let currentAudio: HTMLAudioElement | null = null
/** ElevenLabs voice when available; falls back to the browser voice so the pet is never mute. */
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

// ---------- commands ----------
function start(a: Action): void {
  action = a
  actionT = 0
}

function run(cmd: string): void {
  const cat = profile.species === 'cat'
  switch (cmd) {
    case 'sit':
      setPose('idle')
      say('Sitting pretty!')
      break
    case 'jump':
      setPose('happy')
      start('jump')
      say('Wheee!')
      break
    case 'speak':
      setPose('happy')
      start('speak')
      say(cat ? 'Meow meow!' : 'Woof woof!')
      break
    case 'dance':
      setPose('happy')
      start('dance')
      say('Watch my moves!')
      break
    case 'sleep':
      setPose('sleep')
      start('none')
      say('Okay… nap time. Zzz.')
      break
    case 'good_boy':
      setPose('happy')
      start('speak')
      say(cat ? 'Purr. I know.' : 'Who, me? Best day ever!')
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
  setPose('idle')
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
      setPose('idle')
      say(i.reply, 5000)
      start('speak')
      break
    case 'browser_task':
      setPose('happy')
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
img.addEventListener('pointerdown', () => {
  holdTimer = window.setTimeout(() => void startListening(), 350)
})
img.addEventListener('pointerup', () => {
  if (listening) {
    void stopListening()
    return
  }
  window.clearTimeout(holdTimer)
  setPose('idle')
  start('speak')
  say(`Hey! I'm ${profile.name}. How may I help you?`, 4500)
  cmds.classList.add('show')
  window.clearTimeout(cmdTimer)
  cmdTimer = window.setTimeout(() => cmds.classList.remove('show'), 12000)
})

// ---------- animation: everything is transforms on the sprite ----------
let last = performance.now()
function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.05)
  last = now
  const t = now / 1000
  actionT += dt

  const asleep = pose === 'sleep'
  const br = Math.sin(t * (asleep ? 1.2 : 2.2)) * (asleep ? 0.03 : 0.016)
  let y = 0
  let sx = 1 - br * 0.5
  let sy = 1 + br
  let rot = asleep ? 0 : Math.sin(t * 0.8) * 1.2

  switch (action) {
    case 'arrive': {
      const k = Math.min(actionT / 0.9, 1)
      // drop in from above and bounce once
      y = k < 0.7 ? -320 * (1 - (k / 0.7) ** 2) : -Math.sin(((k - 0.7) / 0.3) * Math.PI) * 28
      if (k < 0.7) sy += 0.08
      else if (k > 0.72) sy -= 0.1 * Math.sin(((k - 0.7) / 0.3) * Math.PI)
      if (k >= 1) action = 'none'
      break
    }
    case 'jump': {
      const k = actionT / 0.75
      if (k >= 1) {
        action = 'none'
        setPose('idle')
        break
      }
      const s = Math.sin(k * Math.PI)
      y = -s * 95
      sy += 0.1 * s
      sx -= 0.05 * s
      if (k > 0.88) sy -= 0.12 * ((k - 0.88) / 0.12)
      break
    }
    case 'dance': {
      if (actionT > 2.6) {
        action = 'none'
        setPose('idle')
        break
      }
      const s = Math.sin(actionT * 7)
      y = -Math.abs(s) * 26
      rot += s * 7
      sy += Math.abs(s) * 0.05
      break
    }
    case 'speak': {
      if (actionT > 1.2) {
        action = 'none'
        if (pose === 'happy') setPose('idle')
        break
      }
      y = -Math.abs(Math.sin(actionT * 14)) * 9
      sy += Math.sin(actionT * 28) * 0.018
      break
    }
  }

  img.style.transform = `translateX(-50%) translateY(${y}px) rotate(${rot}deg) scale(${sx}, ${sy})`
  requestAnimationFrame(frame)
}

void (async () => {
  const p = await window.wf.getProfile()
  if (!p) return
  profile = p
  setPose('idle')
  requestAnimationFrame(frame)
  window.setTimeout(() => say(`Hi, I'm ${profile.name}! Tap me, or hold me to talk.`, 4500), 1000)
  void fillPoses()
})()
