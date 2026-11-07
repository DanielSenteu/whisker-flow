import * as THREE from 'three'

interface Profile {
  name: string
  species: 'dog' | 'cat'
  coat: { primary: string; secondary: string; eye: string }
}

const canvas = document.getElementById('c') as HTMLCanvasElement
const bubble = document.getElementById('bubble') as HTMLDivElement
const cmds = document.getElementById('cmds') as HTMLDivElement

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setClearColor(0x000000, 0)
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50)
camera.position.set(0, 1.6, 7.2)
camera.lookAt(0, 1.1, 0)
scene.add(new THREE.HemisphereLight(0xffffff, 0x9988aa, 1.15))
const sun = new THREE.DirectionalLight(0xffffff, 1.6)
sun.position.set(3, 5, 4)
scene.add(sun)

function resize(): void {
  renderer.setSize(window.innerWidth, window.innerHeight, false)
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
}
window.addEventListener('resize', resize)
resize()

// ---------- the pet ----------
interface Pet {
  root: THREE.Group
  body: THREE.Group
  head: THREE.Group
  tail: THREE.Group
  lids: THREE.Mesh[]
}

function ball(r: number, mat: THREE.Material, sx = 1, sy = 1, sz = 1): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 24), mat)
  m.scale.set(sx, sy, sz)
  return m
}

function buildPet(p: Profile): Pet {
  const fur = new THREE.MeshStandardMaterial({ color: p.coat.primary, roughness: 0.9 })
  const light = new THREE.MeshStandardMaterial({ color: p.coat.secondary, roughness: 0.9 })
  const eyeMat = new THREE.MeshStandardMaterial({ color: p.coat.eye, roughness: 0.3 })
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2 })
  const nose = new THREE.MeshStandardMaterial({ color: 0x2a1a22, roughness: 0.4 })
  const isCat = p.species === 'cat'

  const root = new THREE.Group()
  const body = new THREE.Group()
  root.add(body)

  const torso = ball(0.95, fur, 1.2, 0.9, 0.9)
  torso.position.set(0, 0.95, 0)
  body.add(torso)
  const belly = ball(0.7, light, 1.1, 0.7, 0.8)
  belly.position.set(0.1, 0.72, 0.28)
  body.add(belly)

  // legs
  for (const [x, z] of [[-0.7, 0.35], [0.7, 0.35], [-0.65, -0.35], [0.65, -0.35]]) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.5, 8, 12), fur)
    leg.position.set(x, 0.38, z)
    body.add(leg)
    const paw = ball(0.24, light, 1, 0.6, 1.2)
    paw.position.set(x, 0.1, z + 0.08)
    body.add(paw)
  }

  // head
  const head = new THREE.Group()
  head.position.set(0, 1.85, 0.85)
  body.add(head)
  head.add(ball(0.72, fur, 1.05, 0.95, 0.95))
  const muzzle = ball(0.36, light, 1, 0.8, 0.9)
  muzzle.position.set(0, -0.2, 0.55)
  head.add(muzzle)
  const n = ball(0.1, nose, 1.2, 0.8, 1)
  n.position.set(0, -0.08, 0.86)
  head.add(n)

  const lids: THREE.Mesh[] = []
  for (const s of [-1, 1]) {
    const eye = ball(0.13, eyeMat)
    eye.position.set(s * 0.3, 0.1, 0.62)
    head.add(eye)
    const shine = ball(0.04, white)
    shine.position.set(s * 0.3 + 0.04, 0.15, 0.73)
    head.add(shine)
    const lid = ball(0.15, fur, 1, 0.01, 1)
    lid.position.set(s * 0.3, 0.1, 0.63)
    head.add(lid)
    lids.push(lid)
    // ears
    if (isCat) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.6, 4), fur)
      ear.position.set(s * 0.42, 0.72, 0)
      ear.rotation.z = -s * 0.25
      ear.rotation.y = Math.PI / 4
      head.add(ear)
    } else {
      const ear = ball(0.3, fur, 0.6, 1.2, 0.35)
      ear.position.set(s * 0.68, 0.2, -0.05)
      ear.rotation.z = s * 0.35
      head.add(ear)
    }
  }
  if (isCat) {
    // whiskers
    const wm = new THREE.MeshBasicMaterial({ color: 0xffffff })
    for (const s of [-1, 1]) {
      for (const dy of [-0.04, 0.06]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.6), wm)
        w.rotation.z = Math.PI / 2 + s * dy * 3
        w.position.set(s * 0.55, -0.12 + dy, 0.7)
        head.add(w)
      }
    }
  }

  // tail pivots at its base so it can wag
  const tail = new THREE.Group()
  tail.position.set(0, 1.1, -0.95)
  const tl = new THREE.Mesh(new THREE.CapsuleGeometry(isCat ? 0.11 : 0.15, isCat ? 1.1 : 0.7, 8, 12), fur)
  tl.position.set(0, isCat ? 0.55 : 0.3, 0)
  tail.rotation.x = isCat ? -0.3 : -0.9
  tail.add(tl)
  body.add(tail)

  root.position.y = -0.1
  scene.add(root)
  return { root, body, head, tail, lids }
}

// ---------- behaviour ----------
type Action = 'idle' | 'sit' | 'jump' | 'speak'
let pet: Pet
let profile: Profile
let action: Action = 'idle'
let actionT = 0
let blinkAt = 2
let sitAmount = 0

function say(text: string, ms = 3500, voice = true): void {
  bubble.textContent = text
  bubble.classList.add('show')
  window.clearTimeout((say as unknown as { t?: number }).t)
  ;(say as unknown as { t?: number }).t = window.setTimeout(() => bubble.classList.remove('show'), ms)
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
  u.pitch = profile?.species === 'cat' ? 1.7 : 1.5
  u.rate = 1.05
  speechSynthesis.speak(u)
}

function run(cmd: string): void {
  switch (cmd) {
    case 'sit':
      action = action === 'sit' ? 'idle' : 'sit'
      say(action === 'sit' ? 'Sitting pretty!' : 'Back up!')
      break
    case 'jump':
      action = 'jump'
      actionT = 0
      say('Wheee!')
      break
    case 'speak':
      action = 'speak'
      actionT = 0
      say(profile.species === 'cat' ? 'Meow!' : 'Woof woof!')
      break
    case 'sleep':
      action = 'sit'
      say('Zzz… five more minutes.')
      break
    case 'dance':
      action = 'jump'
      actionT = 0
      say('Look at my moves!')
      break
    case 'good_boy':
      action = 'speak'
      actionT = 0
      say(profile.species === 'cat' ? 'Purr… I know.' : 'Who, me? Best day ever!')
      break
    case 'ball':
      say('Ball play is coming soon!')
      break
  }
}

// ---------- hold the pet to talk ----------
let recorder: MediaRecorder | null = null
let chunks: Blob[] = []
let stream: MediaStream | null = null
let holdTimer = 0
let listening = false

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
  const intent = await window.wf.interpret(b64, (blob.type || 'audio/webm').split(';')[0])
  handleIntent(intent)
}

function handleIntent(i: Awaited<ReturnType<typeof window.wf.interpret>>): void {
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

document.querySelectorAll<HTMLButtonElement>('#cmds button').forEach((b) => {
  b.onclick = (e) => {
    e.stopPropagation()
    run(b.dataset.cmd as string)
  }
})

let cmdTimer = 0
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

const clock = new THREE.Clock()
function frame(): void {
  const dt = Math.min(clock.getDelta(), 0.05)
  const t = clock.elapsedTime
  actionT += dt

  // sit blends smoothly
  sitAmount += ((action === 'sit' ? 1 : 0) - sitAmount) * Math.min(1, dt * 6)
  let y = -0.1 - sitAmount * 0.25
  let tilt = -sitAmount * 0.5

  // idle breathing + head look
  const breathe = Math.sin(t * 2) * 0.025
  pet.body.scale.y = 1 + breathe
  pet.head.rotation.y = Math.sin(t * 0.7) * 0.25
  pet.head.rotation.x = Math.sin(t * 0.9) * 0.06

  // tail wag
  pet.tail.rotation.z = Math.sin(t * (action === 'speak' ? 14 : 5)) * 0.5

  if (action === 'jump') {
    const k = actionT / 0.7
    if (k >= 1) action = 'idle'
    else y += Math.sin(k * Math.PI) * 1.1
  }
  if (action === 'speak') {
    pet.head.rotation.x = -0.25 + Math.sin(actionT * 22) * 0.12
    if (actionT > 1.1) action = 'idle'
  }

  pet.root.position.y = y
  pet.root.rotation.x = tilt
  pet.root.rotation.y = Math.sin(t * 0.5) * 0.15 - 0.2

  // blink
  if (t > blinkAt) {
    const k = (t - blinkAt) / 0.14
    const lidY = k < 1 ? k : Math.max(0, 2 - k)
    for (const l of pet.lids) l.scale.y = 0.01 + lidY * 1.2
    if (k >= 2) {
      blinkAt = t + 2 + Math.random() * 3
      for (const l of pet.lids) l.scale.y = 0.01
    }
  }

  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}

void (async () => {
  const p = await window.wf.getProfile()
  profile = p ?? {
    name: 'Buddy',
    species: 'dog',
    coat: { primary: '#c8864b', secondary: '#f3e3cf', eye: '#3b2a1a' }
  }
  pet = buildPet(profile)
  frame()
  // little hello when the pet arrives on the screen edge
  window.setTimeout(() => say(`Hi, I'm ${profile.name}! Tap me anytime.`, 4500), 700)
})()
