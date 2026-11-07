import { contextBridge, ipcRenderer } from 'electron'
import type { Intent, PetProfile } from '../shared/types'

type GenResult = { ok: true; image: { base64: string; mimeType: string } } | { ok: false; error: string }

const api = {
  getProfile: (): Promise<PetProfile | null> => ipcRenderer.invoke('profile:get'),
  saveProfile: (p: PetProfile): Promise<boolean> => ipcRenderer.invoke('profile:save', p),
  finishOnboarding: (): Promise<void> => ipcRenderer.invoke('onboarding:finish'),
  resetProfile: (): Promise<void> => ipcRenderer.invoke('profile:reset'),
  keysStatus: (): Promise<{ gemini: boolean; elevenlabs: boolean }> => ipcRenderer.invoke('keys:status'),
  interpret: (audio: string, mime: string): Promise<Intent> => ipcRenderer.invoke('voice:interpret', { audio, mime }),
  speak: (text: string): Promise<{ ok: true; audio: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('voice:speak', text),
  generateCharacter: (photo: string, species: string, pose: string, reference?: string): Promise<GenResult> =>
    ipcRenderer.invoke('character:generate', { photo, species, pose, reference })
}

contextBridge.exposeInMainWorld('wf', api)

export type WfApi = typeof api
