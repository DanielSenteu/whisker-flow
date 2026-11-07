type Species = 'dog' | 'cat'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const steps = Array.from(document.querySelectorAll<HTMLElement>('.step'))
const dots = $('dots')
steps.forEach(() => dots.appendChild(document.createElement('i')))

const state = {
  name: '',
  species: null as Species | null,
  photo: '',
  coat: { primary: '#c8864b', secondary: '#f3e3cf', eye: '#3b2a1a' }
}

function go(n: number): void {
  steps.forEach((s, i) => s.classList.toggle('active', i === n))
  Array.from(dots.children).forEach((d, i) => d.classList.toggle('on', i === n))
}
go(0)

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
function takeFile(f: File | undefined): void {
  if (!f || !f.type.startsWith('image/')) return
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
  'Fitting a 3D body…',
  'Teaching them to say hi…'
]

$('photoNext').onclick = async () => {
  $('nameB').textContent = state.name
  $<HTMLImageElement>('scanImg').src = state.photo
  go(4)
  const coatP = readCoat(state.photo).catch(() => state.coat)
  const bar = $('barFill')
  const text = $('stageText')
  for (let i = 0; i < STAGES.length; i++) {
    text.textContent = STAGES[i]
    bar.style.width = `${((i + 1) / STAGES.length) * 100}%`
    await new Promise((r) => setTimeout(r, 900))
  }
  state.coat = await coatP
  $('nameC').textContent = state.name
  $('doneEmoji').textContent = state.species === 'cat' ? '🐱' : '🐶'
  const sw = $('swatches')
  sw.innerHTML = ''
  for (const col of [state.coat.primary, state.coat.secondary, state.coat.eye]) {
    const b = document.createElement('b')
    b.style.background = col
    sw.appendChild(b)
  }
  go(5)
}

$('finish').onclick = async () => {
  await window.wf.saveProfile({
    name: state.name,
    species: state.species ?? 'dog',
    coat: state.coat
  })
  await window.wf.finishOnboarding()
}
