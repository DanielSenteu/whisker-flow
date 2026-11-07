import type { Species } from '../../shared/types'
import { downscale, keyOutGreen } from '../shared/chroma'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const steps = Array.from(document.querySelectorAll<HTMLElement>('.step'))
const dots = $('dots')
steps.forEach(() => dots.appendChild(document.createElement('i')))

const state = {
  name: '',
  species: null as Species | null,
  photo: '',
  hash: '',
  coat: { primary: '#c8864b', secondary: '#f3e3cf', eye: '#3b2a1a' }
}

function go(n: number): void {
  steps.forEach((s, i) => s.classList.toggle('active', i === n))
  Array.from(dots.children).forEach((d, i) => d.classList.toggle('on', i === n))
}
go(0)

// pets that are already generated (free to bring back)
void window.wf.savedPets().then((pets) => {
  const box = $('saved')
  for (const p of pets) {
    const b = document.createElement('button')
    b.className = 'ghost'
    b.textContent = `Use saved ${p.species === 'cat' ? 'cat' : 'dog'}: ${p.name} (free)`
    b.onclick = async () => {
      b.disabled = true
      b.textContent = 'Loading…'
      await window.wf.useSavedPet(p.id)
    }
    box.appendChild(b)
    box.appendChild(document.createElement('br'))
  }
})

$('start').onclick = () => {
  go(1)
  $<HTMLInputElement>('name').focus()
}

const nameInput = $<HTMLInputElement>('name')
nameInput.oninput = () => {
  state.name = nameInput.value.trim()
  $<HTMLButtonElement>('nameNext').disabled = state.name.length === 0
}
nameInput.onkeydown = (e) => {
  if (e.key === 'Enter' && state.name) go(2)
}
$('nameNext').onclick = () => go(2)

document.querySelectorAll<HTMLElement>('.choice').forEach((el) => {
  el.onclick = () => {
    document.querySelectorAll('.choice').forEach((c) => c.classList.remove('sel'))
    el.classList.add('sel')
    state.species = el.dataset.species as Species
    $<HTMLButtonElement>('speciesNext').disabled = false
  }
})
$('speciesNext').onclick = () => {
  $('nameA').textContent = state.name
  go(3)
}

// ---- photo ----
const drop = $('drop')
const fileInput = $<HTMLInputElement>('file')
async function takeFile(f: File | undefined): Promise<void> {
  if (!f || !f.type.startsWith('image/')) return
  // fingerprint of the original file: the same photo again brings back its saved pet for free
  const digest = await crypto.subtle.digest('SHA-1', await f.arrayBuffer())
  state.hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
  const reader = new FileReader()
  reader.onload = () => {
    state.photo = String(reader.result)
    drop.innerHTML = ''
    const img = document.createElement('img')
    img.src = state.photo
    drop.appendChild(img)
    $<HTMLButtonElement>('photoNext').disabled = false
  }
  reader.readAsDataURL(f)
}
fileInput.onchange = () => takeFile(fileInput.files?.[0])
drop.ondragover = (e) => {
  e.preventDefault()
  drop.classList.add('over')
}
drop.ondragleave = () => drop.classList.remove('over')
drop.ondrop = (e) => {
  e.preventDefault()
  drop.classList.remove('over')
  takeFile(e.dataTransfer?.files[0])
}

// ---- coat colours from the photo (local stand-in until Gemini reads the photo) ----
const hex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

async function readCoat(dataUrl: string): Promise<typeof state.coat> {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const S = 48
  const c = document.createElement('canvas')
  c.width = c.height = S
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  // centre crop: the pet is usually in the middle of the frame
  const side = Math.min(img.width, img.height) * 0.6
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S)
  const px = ctx.getImageData(0, 0, S, S).data
  const lum: { r: number; g: number; b: number; l: number }[] = []
  for (let i = 0; i < px.length; i += 4) {
    lum.push({ r: px[i], g: px[i + 1], b: px[i + 2], l: 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] })
  }
  lum.sort((a, b) => a.l - b.l)
  const avg = (arr: typeof lum): [number, number, number] => [
    arr.reduce((s, p) => s + p.r, 0) / arr.length,
    arr.reduce((s, p) => s + p.g, 0) / arr.length,
    arr.reduce((s, p) => s + p.b, 0) / arr.length
  ]
  const n = lum.length
  const mid = avg(lum.slice(Math.floor(n * 0.25), Math.floor(n * 0.6)))
  const light = avg(lum.slice(Math.floor(n * 0.8)))
  const dark = avg(lum.slice(0, Math.floor(n * 0.08)))
  return { primary: hex(...mid), secondary: hex(...light), eye: hex(...dark) }
}

const STAGES = [
  'Scanning your photo…',
  'Measuring ears and snout…',
  'Matching fur colours…',
  'Sculpting a 3D body…',
  'Fluffing up the fur…',
  'Teaching them to say hi…'
]

let sprite = ''
let smallPhoto = ''

async function build(): Promise<void> {
  $('nameB').textContent = state.name
  $<HTMLImageElement>('scanImg').src = state.photo
  $<HTMLButtonElement>('retry').hidden = true
  go(4)
  const bar = $('barFill')
  const text = $('stageText')
  bar.style.width = '4%'

  // the staged text keeps the wait fun; the bar creeps toward 92% until the real result lands
  let i = 0
  let pct = 4
  text.textContent = STAGES[0]
  const ticker = window.setInterval(() => {
    i = Math.min(i + 1, STAGES.length - 1)
    text.textContent = STAGES[i]
  }, 2600)
  const creep = window.setInterval(() => {
    pct += (92 - pct) * 0.06
    bar.style.width = `${pct}%`
  }, 300)

  try {
    smallPhoto = await downscale(state.photo)
    const r = await window.wf.createBase(smallPhoto, state.species ?? 'dog', state.hash)
    if (!r.ok) throw new Error(r.error)
    sprite = await keyOutGreen(`data:image/jpeg;base64,${r.stand}`)
    bar.style.width = '100%'
    $<HTMLImageElement>('reveal').src = sprite
    $('nameC').textContent = state.name
    await new Promise((res) => setTimeout(res, 500))
    go(5)
  } catch (e) {
    text.textContent = `Something went wrong: ${(e as Error).message.slice(0, 120)}`
    $<HTMLButtonElement>('retry').hidden = false
  } finally {
    window.clearInterval(ticker)
    window.clearInterval(creep)
  }
}

$('photoNext').onclick = () => void build()
$('retry').onclick = () => void build()

$('finish').onclick = async () => {
  await window.wf.saveProfile({ name: state.name, species: state.species ?? 'dog' })
  await window.wf.finishOnboarding()
}
