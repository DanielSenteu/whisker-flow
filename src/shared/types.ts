export type Species = 'dog' | 'cat'
export type PoseName = 'idle' | 'happy' | 'sleep'

export interface PetProfile {
  name: string
  species: Species
  coat: { primary: string; secondary: string; eye: string }
  /** Downscaled source photo (JPEG data URL), kept so more poses can be generated later. */
  photo: string
  /** Transparent PNG data URLs, one per pose. `idle` is required. */
  sprites: Partial<Record<PoseName, string>>
}

export type Intent =
  | { kind: 'pet_command'; command: 'sit' | 'jump' | 'sleep' | 'dance' | 'speak' | 'good_boy'; heard: string }
  | { kind: 'browser_task'; goal: string; ack: string; heard: string }
  | { kind: 'look_at_screen'; heard: string }
  | { kind: 'chat'; reply: string; heard: string }
  | { kind: 'error'; message: string }
