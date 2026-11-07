import { app, BrowserWindow, ipcMain, screen, systemPreferences } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { loadEnv } from './env'
import { generateCharacterImage, interpretAudio } from './gemini'
import { speak } from './eleven'

loadEnv()

import type { PetProfile } from '../shared/types'

const profilePath = (): string => join(app.getPath('userData'), 'pet-profile.json')

function loadProfile(): PetProfile | null {
  try {
    if (!existsSync(profilePath())) return null
    const p = JSON.parse(readFileSync(profilePath(), 'utf-8')) as PetProfile | null
    // profiles from before character generation have no sprite: send them back through onboarding
    return p?.sprites?.idle ? p : null
  } catch {
    return null
  }
}

let onboardingWin: BrowserWindow | null = null
let petWin: BrowserWindow | null = null

function pageUrl(page: 'onboarding' | 'pet'): { url?: string; file?: string } {
  if (process.env['ELECTRON_RENDERER_URL']) {
    return { url: `${process.env['ELECTRON_RENDERER_URL']}/${page}/index.html` }
  }
  return { file: join(__dirname, `../renderer/${page}/index.html`) }
}

function load(win: BrowserWindow, page: 'onboarding' | 'pet'): void {
  const t = pageUrl(page)
  if (t.url) void win.loadURL(t.url)
  else void win.loadFile(t.file as string)
}

function createOnboarding(): void {
  onboardingWin = new BrowserWindow({
    width: 980,
    height: 680,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#120d1f',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  load(onboardingWin, 'onboarding')
  onboardingWin.on('closed', () => (onboardingWin = null))
}

/** The pet's home: a transparent strip sitting on the bottom edge of the screen, above the Dock. */
function createPet(): void {
  const { workArea } = screen.getPrimaryDisplay()
  const w = 420
  const h = 340
  petWin = new BrowserWindow({
    width: w,
    height: h,
    x: workArea.x + workArea.width - w - 24,
    y: workArea.y + workArea.height - h,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  if (process.platform === 'darwin') void systemPreferences.askForMediaAccess('microphone')
  petWin.setAlwaysOnTop(true, 'floating')
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  load(petWin, 'pet')
  petWin.on('closed', () => (petWin = null))
}

app.whenReady().then(() => {
  ipcMain.handle('profile:get', () => loadProfile())
  ipcMain.handle('profile:save', (_e, profile: PetProfile) => {
    writeFileSync(profilePath(), JSON.stringify(profile, null, 2))
    return true
  })
  ipcMain.handle('keys:status', () => ({
    gemini: !!process.env.GEMINI_API_KEY,
    elevenlabs: !!process.env.ELEVENLABS_API_KEY
  }))
  ipcMain.handle('voice:interpret', (_e, v: { audio: string; mime: string }) => {
    const p = loadProfile()
    return interpretAudio(v.audio, v.mime, p?.name ?? 'Buddy', p?.species ?? 'dog')
  })
  ipcMain.handle('voice:speak', async (_e, text: string) => {
    try {
      return { ok: true as const, audio: await speak(String(text).slice(0, 400)) }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })
  ipcMain.handle('character:generate', async (_e, v: { photo: string; species: string; pose: string; reference?: string }) => {
    try {
      return { ok: true as const, image: await generateCharacterImage(v.photo, v.species, v.pose, v.reference) }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })
  ipcMain.handle('onboarding:finish', () => {
    onboardingWin?.close()
    if (!petWin) createPet()
  })
  ipcMain.handle('profile:reset', () => {
    writeFileSync(profilePath(), 'null')
    petWin?.close()
    if (!onboardingWin) createOnboarding()
  })

  if (loadProfile()) createPet()
  else createOnboarding()
})

app.on('window-all-closed', () => {
  // The pet lives on after onboarding closes; quit only when nothing is left.
  if (process.platform !== 'darwin') app.quit()
})
