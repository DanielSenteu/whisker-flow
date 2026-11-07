import { app, BrowserWindow, desktopCapturer, ipcMain, screen, shell, systemPreferences } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { loadEnv } from './env'
import { describeScreen, interpretAudio } from './gemini'
import { speak } from './eleven'
import { closeBrowser, runTask, stopTask } from './agent'
import { runPack, stopPack } from './pack'
import { activate, archiveCurrent, createBase, demoBase, hasBase, listAssets, listSaved, petDir, readAnchor, readAsset, runPipeline } from './pipeline'
import type { PetProfile } from '../shared/types'

loadEnv()
if (process.env.WF_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.WF_DEBUG_PORT)

const profilePath = (): string => join(app.getPath('userData'), 'pet-profile.json')

function loadProfile(): PetProfile | null {
  try {
    if (!existsSync(profilePath()) || !hasBase()) return null
    return JSON.parse(readFileSync(profilePath(), 'utf-8')) as PetProfile | null
  } catch {
    return null
  }
}

let onboardingWin: BrowserWindow | null = null
let petWin: BrowserWindow | null = null

function load(win: BrowserWindow, page: 'onboarding' | 'pet'): void {
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/${page}/index.html`)
  } else {
    void win.loadFile(join(__dirname, `../renderer/${page}/index.html`))
  }
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

const PET_H = 540

/** The pet's home: a transparent strip on the bottom-right of the screen. Clicks pass through except on the pet. */
function createPet(): void {
  const { workArea } = screen.getPrimaryDisplay()
  petWin = new BrowserWindow({
    width: workArea.width, // the whole bottom edge of the screen: the pet walks along it
    height: PET_H,
    x: workArea.x,
    y: workArea.y + workArea.height - PET_H,
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
  petWin.setIgnoreMouseEvents(true, { forward: true })
  load(petWin, 'pet')
  petWin.on('closed', () => (petWin = null))
  // fill in any missing keyframes/clips in the background (cached, so this only generates the gaps)
  petWin.webContents.once('did-finish-load', () => {
    const p = loadProfile()
    if (p) void runPipeline(p.species, () => petWin)
  })
}

app.whenReady().then(() => {
  ipcMain.handle('profile:get', () => loadProfile())
  ipcMain.handle('profile:save', (_e, profile: PetProfile) => {
    writeFileSync(profilePath(), JSON.stringify(profile, null, 2))
    try {
      writeFileSync(join(petDir(), 'profile.json'), JSON.stringify(profile)) // travels with the pet when archived
    } catch { /* no pet folder yet */ }
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

  // ---- the pet's body ----
  ipcMain.handle('pet:createBase', async (_e, v: { photo: string; species: string; hash: string }) => {
    try {
      const r = await createBase(v.photo, v.species, v.hash, loadProfile)
      return { ok: true as const, stand: r.stand, reused: r.reused }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })
  // ---- screen glance: one screenshot, sent to Gemini only when asked, never stored ----
  ipcMain.handle('screen:glance', async () => {
    try {
      const before = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'
      console.log('[glance] screen access status:', before)
      if (before === 'denied') {
        void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
        return { ok: false as const, error: `permission (${before})` }
      }
      petWin?.setContentProtection(true) // keep the pet itself out of the screenshot
      let jpeg: Buffer
      try {
        const primary = String(screen.getPrimaryDisplay().id)
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1400, height: 900 } })
        const src = sources.find((s) => s.display_id === primary) ?? sources[0]
        if (!src) return { ok: false as const, error: 'no screen' }
        jpeg = src.thumbnail.toJPEG(68)
      } finally {
        petWin?.setContentProtection(false)
      }
      const after = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'
      if (after !== 'granted') {
        void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
        return { ok: false as const, error: `permission (${after})` }
      }
      const p = loadProfile()
      return { ok: true as const, text: await describeScreen(jpeg.toString('base64'), p?.name ?? 'Buddy', p?.species ?? 'dog') }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })

  // ---- the browser agent ----
  const agentSend = (type: string, text: string): void => {
    if (petWin && !petWin.isDestroyed()) petWin.webContents.send('agent:event', { type, text })
  }
  ipcMain.handle('agent:run', (_e, goal: string) => {
    const p = loadProfile()
    void runTask(String(goal).slice(0, 500), p?.name ?? 'Buddy', p?.species ?? 'dog', {
      step: (t) => agentSend('step', t),
      done: (t) => agentSend('done', t),
      ask: (t) => agentSend('ask', t),
      error: (t) => agentSend('error', t)
    })
    return true
  })
  ipcMain.on('agent:stop', () => stopTask())

  // ---- the pack: the lead dog plans, helper pups work in parallel ----
  const packSend = (payload: unknown): void => {
    if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pack:event', payload)
  }
  ipcMain.handle('pack:run', (_e, goal: string) => {
    const p = loadProfile()
    void runPack(String(goal).slice(0, 600), p?.name ?? 'Buddy', p?.species ?? 'dog', {
      plan: (intro, pups) => packSend({ type: 'plan', intro, pups }),
      pup: (id, u) => packSend({ type: 'pup', id, ...u }),
      final: (text) => packSend({ type: 'final', text }),
      error: (message) => packSend({ type: 'error', message })
    })
    return true
  })
  ipcMain.on('pack:stop', () => stopPack())

  ipcMain.handle('pets:demo', () => {
    const r = demoBase(loadProfile)
    return r ? { ok: true as const, stand: r.stand } : { ok: false as const, error: 'No saved pet to use for the demo' }
  })
  ipcMain.handle('pets:list', () => listSaved(loadProfile))
  ipcMain.handle('pets:use', (_e, id: string) => {
    const prof = activate(id, loadProfile)
    if (prof?.name) writeFileSync(profilePath(), JSON.stringify({ name: prof.name, species: prof.species }, null, 2))
    onboardingWin?.close()
    if (!petWin) createPet()
    return !!prof
  })
  ipcMain.handle('pet:assets', () => listAssets())
  ipcMain.handle('pet:anchor', () => readAnchor())
  ipcMain.handle('pet:file', (_e, v: { kind: 'still' | 'clip'; name: string }) => {
    const buf = readAsset(v.kind, v.name)
    return buf ? new Uint8Array(buf) : null
  })
  ipcMain.handle('screen:cursorX', () => {
    const b = petWin?.getBounds()
    return b ? screen.getCursorScreenPoint().x - b.x : null
  })
  ipcMain.on('pet:clickThrough', (_e, ignore: boolean) => {
    petWin?.setIgnoreMouseEvents(!!ignore, { forward: true })
  })

  ipcMain.handle('onboarding:finish', () => {
    onboardingWin?.close()
    if (!petWin) createPet()
  })
  ipcMain.handle('profile:reset', () => {
    archiveCurrent(loadProfile) // never delete a paid-for pet: it can be brought back from the welcome screen
    writeFileSync(profilePath(), 'null')
    petWin?.close()
    if (!onboardingWin) createOnboarding()
  })

  if (loadProfile()) createPet()
  else createOnboarding()
})

app.on('before-quit', () => void closeBrowser())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
