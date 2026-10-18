import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { RelayEvent, RelayQueueItem, RelaySettings } from '../shared/types'

export interface PersistedState {
  settings: RelaySettings
  queue: RelayQueueItem[]
  events: RelayEvent[]
}

export const DEFAULT_SETTINGS: RelaySettings = {
  enabled: true,
  autoWatchRecent: true,
  continuePrompt: 'continue',
  graceSeconds: 60,
  pollIntervalSeconds: 45,
  startAtLogin: false,
  watchedThreadIds: [],
  codexPath: ''
}

const DEFAULT_STATE: PersistedState = {
  settings: DEFAULT_SETTINGS,
  queue: [],
  events: []
}

export class JsonStore {
  private state: PersistedState = structuredClone(DEFAULT_STATE)

  constructor(private readonly filePath: string) {}

  async load(): Promise<PersistedState> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<PersistedState>
      this.state = {
        settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
        queue: Array.isArray(parsed.queue) ? parsed.queue : [],
        events: Array.isArray(parsed.events) ? parsed.events.slice(0, 80) : []
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Could not read Hrrrwork state:', error)
      }
    }
    return this.get()
  }

  get(): PersistedState {
    return structuredClone(this.state)
  }

  async set(next: PersistedState): Promise<void> {
    this.state = structuredClone(next)
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
    await fs.rename(temporary, this.filePath)
  }
}
