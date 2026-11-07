import { contextBridge, ipcRenderer } from 'electron'

export interface PetProfile {
  name: string
  species: 'dog' | 'cat'
  coat: { primary: string; secondary: string; eye: string }
}

const api = {
  getProfile: (): Promise<PetProfile | null> => ipcRenderer.invoke('profile:get'),
  saveProfile: (p: PetProfile): Promise<boolean> => ipcRenderer.invoke('profile:save', p),
  finishOnboarding: (): Promise<void> => ipcRenderer.invoke('onboarding:finish'),
  resetProfile: (): Promise<void> => ipcRenderer.invoke('profile:reset'),
  keysStatus: (): Promise<{ gemini: boolean; elevenlabs: boolean }> => ipcRenderer.invoke('keys:status'),
  interpret: (audio: string, mime: string): Promise<Intent> => ipcRenderer.invoke('voice:interpret', { audio, mime }),
  speak: (text: string): Promise<{ ok: true; audio: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('voice:speak', text),
  generateCharacter: (
    photo: string,
    species: string,
    pose: string
  ): Promise<{ ok: true; image: { base64: string; mimeType: string } } | { ok: false; error: string }> =>
    ipcRenderer.invoke('character:generate', { photo, species, pose })
}

export type Intent =
  | { kind: 'pet_command'; command: 'sit' | 'jump' | 'sleep' | 'dance' | 'speak' | 'good_boy'; heard: string }
  | { kind: 'browser_task'; goal: string; ack: string; heard: string }
  | { kind: 'look_at_screen'; heard: string }
  | { kind: 'chat'; reply: string; heard: string }
  | { kind: 'error'; message: string }

contextBridge.exposeInMainWorld('wf', api)

export type WfApi = typeof api
