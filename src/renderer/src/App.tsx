import {
  BellRing,
  Check,
  ChevronDown,
  Clock3,
  History,
  MoonStar,
  Play,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  WifiOff
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ProviderId, QuotaWindow, RelaySettings, RelaySnapshot, ThreadSummary } from '../../shared/types'
import { Moon } from './Moon'

const demoSnapshot: RelaySnapshot = {
  providers: [
    { id: 'codex', name: 'Codex', installed: true, connected: true, message: '已连接', executable: '/usr/local/bin/codex', quota: { rateLimits: { limitId: 'codex', primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 4320 }, secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: Date.now() / 1000 + 432000 } } }, lastCheckedAt: Date.now() },
    { id: 'claude-code', name: 'Claude Code', installed: true, connected: true, message: '已连接 · 本地桥接', executable: '/usr/local/bin/claude', quota: { rateLimits: { limitId: 'claude-code', primary: { usedPercent: 64, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 4320 }, secondary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: Date.now() / 1000 + 432000 } } }, lastCheckedAt: Date.now() }
  ],
  connection: 'connected',
  connectionMessage: 'Codex 已连接',
  codexPath: '/usr/local/bin/codex',
  quota: {
    ordinaryUsageAllowed: true,
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 60 * 72 },
      secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: Date.now() / 1000 + 86400 * 5 },
      planType: 'plus'
    }
  },
  threads: [
    { id: 'demo-1', name: '给登录页面补齐测试并修复边界情况', preview: '继续完善测试覆盖率', source: 'vscode', createdAt: 0, updatedAt: Date.now() / 1000 - 180 },
    { id: 'demo-2', name: '重构数据同步模块', preview: '梳理同步策略', source: 'vscode', createdAt: 0, updatedAt: Date.now() / 1000 - 1600 },
    { id: 'demo-3', name: '整理发布说明', preview: '生成 changelog', source: 'cli', createdAt: 0, updatedAt: Date.now() / 1000 - 5200 }
  ],
  queue: [],
  events: [
    { id: 'event-1', at: Date.now() - 120000, kind: 'success', message: '已连接 Codex，开始巡夜。' },
    { id: 'event-2', at: Date.now() - 520000, kind: 'info', message: '额度充足，一切安静。' }
  ],
  settings: {
    enabled: true,
    autoWatchRecent: true,
    continuePrompt: 'continue',
    graceSeconds: 60,
    pollIntervalSeconds: 45,
    startAtLogin: false,
    watchedThreadIds: ['demo-2'],
    codexPath: '',
    claudePath: ''
  },
  lastCheckedAt: Date.now()
}

export function App(): React.JSX.Element {
  const isCapture = new URLSearchParams(location.search).has('capture')
  const [snapshot, setSnapshot] = useState<RelaySnapshot | null>(isCapture ? demoSnapshot : null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>(new URLSearchParams(location.search).has('claude') ? 'claude-code' : 'codex')
  const [errorMessage, setErrorMessage] = useState('')
  const provider = snapshot?.providers.find(item => item.id === selectedProvider)
  const providerThreads = snapshot?.threads.filter(thread => (thread.provider ?? 'codex') === selectedProvider) ?? []

  useEffect(() => {
    if (isCapture) return
    void window.hrrrwork.getSnapshot().then(setSnapshot)
    return window.hrrrwork.onSnapshot(setSnapshot)
  }, [isCapture])

  const limits = useMemo(() => {
    const quota = provider?.quota
    if (!quota) return null
    return quota.rateLimitsByLimitId?.codex
      ?? quota.rateLimits
      ?? Object.values(quota.rateLimitsByLimitId ?? {})[0]
      ?? null
  }, [provider])

  if (!snapshot) return <LoadingScreen />

  const refresh = async (): Promise<void> => {
    setBusy(true)
    try {
      setSnapshot(await window.hrrrwork.refresh())
      setErrorMessage('')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const updateSettings = async (patch: Partial<RelaySettings>): Promise<void> => {
    try { setSnapshot(await window.hrrrwork.updateSettings(patch)); setErrorMessage('') }
    catch (error) { setErrorMessage(error instanceof Error ? error.message : String(error)) }
  }

  const connectClaude = async (): Promise<void> => {
    setBusy(true)
    try { setSnapshot(await window.hrrrwork.connectClaude()); setErrorMessage('') }
    catch (error) { setErrorMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const statusText = snapshot.settings.enabled ? '安心睡吧，我在巡夜' : '接力暂时休息中'

  return (
    <main className="app-shell">
      <div className="window-titlebar"><span>Hrrrwork</span></div>
      <header className="topbar">
        <div className="brand">
          <LogoMark />
          <div>
            <strong>Hrrrwork</strong>
            <span>睡眠接力</span>
          </div>
        </div>
        <div className="top-actions">
          <span className={`connection ${provider?.connected ? 'connected' : 'disconnected'}`}>
            <i />
            {snapshot.providers.filter(item => item.connected).length} 个应用已连接
          </span>
          <button className="icon-button" aria-label="立即检查" onClick={() => void refresh()} disabled={busy}>
            <RefreshCw size={18} className={busy ? 'spin' : ''} />
          </button>
          <button className="icon-button" aria-label="设置" onClick={() => setSettingsOpen((open) => !open)}>
            <Settings2 size={18} />
          </button>
        </div>
      </header>

      <div className="provider-toolbar">
        <div className="provider-tabs" aria-label="选择要守护的应用">
          {snapshot.providers.map(item => <button key={item.id} className={`provider-tab ${selectedProvider === item.id ? 'selected' : ''}`} onClick={() => setSelectedProvider(item.id)} aria-pressed={selectedProvider === item.id}>
            <span className={`provider-symbol ${item.id}`}>{item.id === 'codex' ? '〉_' : '✳'}</span>
            <strong>{item.name}</strong><span className={`provider-state ${item.connected ? 'ready' : ''}`}>{item.connected ? '守护中' : item.installed ? '待连接' : '未检测到'}</span>
          </button>)}
        </div>
        <span className="provider-status">{provider?.message}</span>
        {selectedProvider === 'claude-code' && !provider?.connected && <button className="connect-provider" disabled={busy || !provider?.installed} onClick={() => void connectClaude()}>连接 Claude Code</button>}
        {selectedProvider === 'claude-code' && provider?.connected && <button className="disconnect-provider" onClick={async () => { try { setSnapshot(await window.hrrrwork.disconnectClaude()) } catch (error) { setErrorMessage(String(error)) } }}>断开</button>}
      </div>
      {errorMessage && <button className="error-toast" onClick={() => setErrorMessage('')}>{errorMessage} ×</button>}

      <section className="dashboard-grid">
        <article className={`hero-card ${snapshot.settings.enabled ? '' : 'paused'}`}>
          <div className="night-illustration" aria-hidden="true">
            <span className="star star-one">✦</span>
            <span className="star star-two">·</span>
            <span className="star star-three">✧</span>
            <Moon className="hero-moon" />
            <div className="relay-line"><i /><i /><i /></div>
          </div>
          <div className="hero-copy">
            <span className="eyebrow"><MoonStar size={15} /> NIGHT WATCH</span>
            <h1>{statusText}</h1>
            <p>
              {snapshot.settings.enabled
                ? `${provider?.name ?? '应用'} 因额度中断时，我会等到刷新，再稳稳递上 continue。`
                : '开启守护后，我会继续观察额度与任务状态。'}
            </p>
            <div className="hero-footer">
              <button
                className={`master-switch ${snapshot.settings.enabled ? 'on' : ''}`}
                onClick={() => void updateSettings({ enabled: !snapshot.settings.enabled })}
              >
                <span><ShieldCheck size={17} />自动接力</span>
                <i><b /></i>
              </button>
              <span className="last-check">上次巡查 {relativeTime(snapshot.lastCheckedAt)}</span>
            </div>
          </div>
        </article>

        <section className="quota-stack">
          <QuotaCard title="5 小时额度" window={limits?.primary} accent="coral" />
          <QuotaCard title="每周额度" window={limits?.secondary} accent="blue" />
        </section>

        <article className="panel tasks-panel">
          <PanelTitle
            icon={<Terminal size={18} />}
            title="最近任务"
            subtitle="点亮星标可固定守护多个任务"
            action={
              <label className="tiny-toggle">
                <input
                  type="checkbox"
                  checked={snapshot.settings.autoWatchRecent}
                  onChange={(event) => void updateSettings({ autoWatchRecent: event.target.checked })}
                />
                <span />自动守护最新任务
              </label>
            }
          />
          <div className="task-list">
            {providerThreads.map((thread, index) => (
              <TaskRow
                key={thread.id}
                thread={thread}
                latest={index === 0 && snapshot.settings.autoWatchRecent}
                watched={snapshot.settings.watchedThreadIds.includes(thread.id)}
                onToggle={async () => setSnapshot(await window.hrrrwork.toggleWatch(thread.id))}
              />
            ))}
            {!providerThreads.length && (
              <div className="empty-state"><WifiOff size={20} />{provider?.connected ? '等待下一轮会话同步' : `等待连接 ${provider?.name ?? '应用'}`}{selectedProvider === 'claude-code' && <small>连接后会同步额度，识别限额中断并接力原会话。</small>}</div>
            )}
          </div>
        </article>

        <article className="panel relay-panel">
          <PanelTitle
            icon={<Sparkles size={18} />}
            title="接力篮"
            subtitle={snapshot.queue.length ? `${snapshot.queue.length} 个任务在等待` : '今晚还没有掉棒'}
          />
          {snapshot.queue.length ? (
            <div className="queue-list">
              {snapshot.queue.map((item) => (
                <div className="queue-item" key={item.id}>
                  <div className="queue-dot"><Clock3 size={16} /></div>
                  <div>
                    <strong>{item.threadName}</strong>
                    <span>{item.provider === 'claude-code' ? 'Claude Code' : 'Codex'} · {formatDate(item.scheduledFor)} 接力</span>
                  </div>
                  <button
                    className="play-button"
                    title="立即发送"
                    onClick={async () => setSnapshot(await window.hrrrwork.sendNow(item.id))}
                  ><Play size={15} fill="currentColor" /></button>
                </div>
              ))}
            </div>
          ) : (
            <div className="basket-empty">
              <div className="basket-icon"><Check size={24} /></div>
              <strong>没有等待中的接力</strong>
              <span>{limits ? '任务都在自己的轨道上。' : '等待应用同步额度与会话。'}</span>
            </div>
          )}
          <div className="activity">
            <div className="activity-title"><History size={15} />最近动态</div>
            {snapshot.events.slice(0, 3).map((event) => (
              <div className={`event ${event.kind}`} key={event.id}>
                <i />
                <span>{event.message}</span>
                <time>{relativeTime(event.at)}</time>
              </div>
            ))}
          </div>
        </article>
      </section>

      {settingsOpen && (
        <SettingsDrawer
          settings={snapshot.settings}
          codexPath={snapshot.codexPath}
          claudePath={snapshot.providers.find(item => item.id === 'claude-code')?.executable ?? ''}
          onClose={() => setSettingsOpen(false)}
          onUpdate={updateSettings}
          onRevealLogs={() => void window.hrrrwork.revealLogs()}
        />
      )}
    </main>
  )
}

function LoadingScreen(): React.JSX.Element {
  return <div className="loading"><LogoMark /><span>正在叫醒巡夜员…</span></div>
}

function LogoMark(): React.JSX.Element {
  return <div className="logo-mark"><Moon /></div>
}

function QuotaCard({ title, window, accent }: { title: string; window?: QuotaWindow | null; accent: 'coral' | 'blue' }): React.JSX.Element {
  const percent = Math.min(100, Math.max(0, Math.round(window?.usedPercent ?? 0)))
  return (
    <article className={`quota-card ${accent}`}>
      <div className="quota-heading">
        <span>{title}</span>
        <strong>{window ? `${percent}%` : '—'}</strong>
      </div>
      <div className="meter"><i style={{ width: `${percent}%` }} /></div>
      <div className="quota-footer">
        <span>{!window ? '尚未同步' : percent >= 100 ? '等待刷新' : '仍可安心工作'}</span>
        <time>{window ? `${formatDate(window.resetsAt * 1000)} 刷新` : '等待额度信息'}</time>
      </div>
    </article>
  )
}

function PanelTitle({ icon, title, subtitle, action }: { icon: React.ReactNode; title: string; subtitle: string; action?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="panel-title">
      <div className="panel-title-icon">{icon}</div>
      <div><h2>{title}</h2><p>{subtitle}</p></div>
      {action && <div className="panel-action">{action}</div>}
    </div>
  )
}

function TaskRow({ thread, latest, watched, onToggle }: { thread: ThreadSummary; latest: boolean; watched: boolean; onToggle: () => void }): React.JSX.Element {
  const title = thread.name || thread.preview || '未命名任务'
  return (
    <div className="task-row">
      <div className="task-status"><i /></div>
      <div className="task-copy">
        <strong>{title}</strong>
        <span>{thread.provider === 'claude-code' ? 'Claude Code · ' : ''}{thread.cwd ? compactPath(thread.cwd) : thread.source === 'cli' ? 'Codex CLI' : 'Codex 桌面端'} · {relativeTime(thread.updatedAt * 1000)}</span>
      </div>
      {latest && <span className="latest-pill">自动</span>}
      <button className={`watch-button ${watched ? 'active' : ''}`} onClick={onToggle} title={watched ? '取消固定守护' : '固定守护'}>
        <Sparkles size={17} fill={watched ? 'currentColor' : 'none'} />
      </button>
    </div>
  )
}

function SettingsDrawer({ settings, codexPath, claudePath, onClose, onUpdate, onRevealLogs }: {
  settings: RelaySettings
  codexPath: string
  claudePath: string
  onClose: () => void
  onUpdate: (patch: Partial<RelaySettings>) => Promise<void>
  onRevealLogs: () => void
}): React.JSX.Element {
  const [draftPrompt, setDraftPrompt] = useState(settings.continuePrompt)
  const [draftPath, setDraftPath] = useState(settings.codexPath)
  const [draftClaudePath, setDraftClaudePath] = useState(settings.claudePath)
  return (
    <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="settings-drawer">
        <div className="drawer-head"><div><span>SETTINGS</span><h2>巡夜设置</h2></div><button onClick={onClose}>完成</button></div>
        <label className="setting-row">
          <div><strong>开机自动巡夜</strong><span>登录系统后静默驻留托盘</span></div>
          <input type="checkbox" checked={settings.startAtLogin} onChange={(event) => void onUpdate({ startAtLogin: event.target.checked })} />
        </label>
        <label className="field">
          <span>接力口令</span>
          <div className="input-with-action">
            <input value={draftPrompt} onChange={(event) => setDraftPrompt(event.target.value)} />
            <button onClick={() => void onUpdate({ continuePrompt: draftPrompt })}>保存</button>
          </div>
          <small>额度刷新且原任务仍中断时发送。</small>
        </label>
        <label className="field">
          <span>刷新后缓冲</span>
          <div className="select-wrap">
            <select value={settings.graceSeconds} onChange={(event) => void onUpdate({ graceSeconds: Number(event.target.value) })}>
              <option value={30}>30 秒</option>
              <option value={60}>1 分钟</option>
              <option value={120}>2 分钟</option>
              <option value={300}>5 分钟</option>
            </select>
            <ChevronDown size={15} />
          </div>
        </label>
        <label className="field">
          <span>Codex 可执行文件</span>
          <div className="input-with-action">
            <input value={draftPath} onChange={(event) => setDraftPath(event.target.value)} placeholder={codexPath} />
            <button onClick={() => void onUpdate({ codexPath: draftPath })}>应用</button>
          </div>
          <small>已自动发现：{codexPath}</small>
        </label>
        <button className="log-button" onClick={onRevealLogs}><BellRing size={16} />打开数据与日志目录</button>
        <label className="field">
          <span>Claude Code 可执行文件</span>
          <div className="input-with-action"><input value={draftClaudePath} onChange={event => setDraftClaudePath(event.target.value)} placeholder={claudePath || '自动检测'} /><button onClick={() => void onUpdate({ claudePath: draftClaudePath })}>应用</button></div>
          <small>连接后同步状态栏与额度中断事件，保留已有状态栏。更新或移动应用后请重新连接。</small>
        </label>
        <div className="privacy-note"><ShieldCheck size={17} /><span>本地运行；不读取对话正文，不保存账号令牌。</span></div>
      </aside>
    </div>
  )
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value)
}

function relativeTime(value: number | null): string {
  if (!value) return '尚未'
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000))
  if (seconds < 45) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86400)} 天前`
}

function compactPath(value: string): string {
  const parts = value.replaceAll('\\', '/').split('/').filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : value
}
