import { DEFAULT_QUOTA_WAKE, type RelaySnapshot } from '../../shared/types'
const now = Date.now()
const quota = (id: string, used: number, weekly: number) => ({ rateLimits: { limitId: id, primary: { usedPercent: used, windowDurationMins: 300, resetsAt: now / 1000 + 4320 }, secondary: { usedPercent: weekly, windowDurationMins: 10080, resetsAt: now / 1000 + 432000 } } })
export const demoSnapshot: RelaySnapshot = {
  providers: [
    { id: 'codex', name: 'Codex', installed: true, connected: true, message: '已连接', executable: '/usr/local/bin/codex', quota: quota('codex', 32, 34), lastCheckedAt: now, models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna' }, { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }] },
    { id: 'claude-code', name: 'Claude Code', installed: true, connected: true, message: '已连接', executable: '/usr/local/bin/claude', quota: quota('claude-code', 64, 22), lastCheckedAt: now }
  ],
  connection: 'connected', connectionMessage: '已连接', codexPath: '/usr/local/bin/codex', quota: quota('codex', 32, 34),
  threads: [
    { id: 'demo-1', name: '完善登录页面的测试与边界处理', cwd: '/projects/orbit', createdAt: 0, updatedAt: now / 1000 - 180 },
    { id: 'demo-2', name: '重构数据同步模块', cwd: '/projects/orbit', createdAt: 0, updatedAt: now / 1000 - 1600 },
    { id: 'demo-3', name: '整理新版本发布说明', cwd: '/projects/hrrrwork', createdAt: 0, updatedAt: now / 1000 - 5200 }
  ],
  queue: [], events: [{ id: 'e1', at: now - 120000, kind: 'success', message: '已连接，开始巡夜。' }],
  settings: { enabled: true, autoWatchRecent: true, continuePrompt: 'continue', graceSeconds: 60, pollIntervalSeconds: 45, startAtLogin: false, watchedThreadIds: ['demo-2'], codexPath: '', claudePath: '', updates: { autoCheck: true, autoDownload: true }, quotaWake: structuredClone(DEFAULT_QUOTA_WAKE) },
  wakePlans: {}, lastCheckedAt: now
}
export function previewSnapshot(daily = false): RelaySnapshot {
  const snapshot = structuredClone(demoSnapshot)
  if (daily) {
    const first = new Date(); first.setHours(6, 0, 0, 0)
    if (first.getTime() < now + 4320000) first.setDate(first.getDate() + 1)
    snapshot.settings.quotaWake.codex = { ...snapshot.settings.quotaWake.codex, enabled: true, timing: 'daily', firstWakeAt: first.getTime() }
    snapshot.wakePlans.codex = { resetAt: now / 1000 + 4320, scheduledFor: first.getTime(), status: 'waiting', message: '等待定时唤醒' }
  }
  return snapshot
}
