export type Species = 'dog' | 'cat'

export interface PetProfile {
  name: string
  species: Species
}

export interface Progress {
  done: number
  total: number
  finished?: boolean
}

export type Intent =
  | { kind: 'pet_command'; command: 'sit' | 'jump' | 'sleep' | 'dance' | 'speak' | 'good_boy'; heard: string }
  | { kind: 'browser_task'; goal: string; ack: string; heard: string }
  | { kind: 'look_at_screen'; heard: string }
  | { kind: 'chat'; reply: string; heard: string }
  | { kind: 'error'; message: string }
