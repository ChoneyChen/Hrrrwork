import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DEFAULT_QUOTA_WAKE, type ProviderId, type RelayEvent, type RelayQueueItem, type RelaySettings, type WakePlan } from '../shared/types'

export interface PersistedState {
  timingVersion?: number
  dispatched: string[]
  wakePlans: Partial<Record<ProviderId, WakePlan>>
  wakeReceipts: string[]
  settings: RelaySettings
  queue: RelayQueueItem[]
  events: RelayEvent[]
}

export const DEFAULT_SETTINGS: RelaySettings = {
  enabled: true,
  autoWatchRecent: true,
  continuePrompt: 'continue',
  graceSeconds: 0,
  pollIntervalSeconds: 45,
  startAtLogin: false,
  watchedThreadIds: [],
  codexPath: '',
  claudePath: '',
  updates: { autoCheck: true, autoDownload: true },
  quotaWake: structuredClone(DEFAULT_QUOTA_WAKE)
}

const DEFAULT_STATE: PersistedState = {
  timingVersion: 1,
  dispatched: [],
  wakePlans: {},
  wakeReceipts: [],
  settings: DEFAULT_SETTINGS,
  queue: [],
  events: []
}

function restoreWakePlans(raw: PersistedState['wakePlans'] = {}): PersistedState['wakePlans'] {
  const plans: PersistedState['wakePlans'] = {}
  for (const id of ['codex', 'claude-code'] as ProviderId[]) {
    const plan = raw[id]
    if (!plan || !Number.isFinite(plan.resetAt) || !Number.isFinite(plan.scheduledFor) || !['waiting', 'dispatching', 'submitted', 'completed', 'skipped', 'failed'].includes(plan.status)) continue
    plans[id] = { ...plan }
    if (plan.status === 'dispatching' || plan.status === 'submitted') {
      plans[id]!.status = 'failed'
      plans[id]!.message = '上次唤醒已提交或结果未知，本窗口不会重复发送。'
    }
  }
  return plans
}

export class JsonStore {
  private state: PersistedState = structuredClone(DEFAULT_STATE)
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async load(): Promise<PersistedState> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<PersistedState>
      const oldDefault = !parsed.timingVersion && parsed.settings?.graceSeconds === 60
      this.state = {
        timingVersion: 1,
        dispatched: Array.isArray(parsed.dispatched) ? parsed.dispatched.slice(-200) : [],
        wakePlans: restoreWakePlans(parsed.wakePlans),
        wakeReceipts: Array.isArray(parsed.wakeReceipts) ? parsed.wakeReceipts.slice(-200) : [],
        settings: { ...DEFAULT_SETTINGS, ...parsed.settings, updates: { ...DEFAULT_SETTINGS.updates, ...parsed.settings?.updates }, quotaWake: {
          codex: { ...DEFAULT_QUOTA_WAKE.codex, ...parsed.settings?.quotaWake?.codex },
          'claude-code': { ...DEFAULT_QUOTA_WAKE['claude-code'], ...parsed.settings?.quotaWake?.['claude-code'] }
        } },
        queue: Array.isArray(parsed.queue) ? parsed.queue.filter(item => !parsed.dispatched?.includes(item.id)).map(item => ({ ...item, status: 'waiting', scheduledFor: item.scheduledFor - (oldDefault ? 60000 : 0) })) : [],
        events: Array.isArray(parsed.events) ? parsed.events.slice(0, 80) : []
      }
      if (oldDefault) {
        this.state.settings.graceSeconds = 0
        for (const plan of Object.values(this.state.wakePlans)) if (plan.status === 'waiting' && (plan.scheduleKey ?? 'reset') === 'reset') plan.scheduledFor -= 60000
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
    const contents = `${JSON.stringify(this.state, null, 2)}\n`
    const write = this.writes.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.tmp`
      await fs.writeFile(temporary, contents, 'utf8')
      await fs.rename(temporary, this.filePath)
    })
    this.writes = write
    await write
  }
}
