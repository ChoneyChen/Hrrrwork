import type { QuotaWindow } from '../../shared/types'

// The provider reports usage; only the presentation converts it to remaining quota.
export function remainingQuota(window?: QuotaWindow | null): number | null {
  if (!window || window.usageKnown === false || !Number.isFinite(window.usedPercent)) return null
  return Math.min(100, Math.max(0, 100 - window.usedPercent))
}

export function QuotaCard({ title, window, accent }: { title: string; window?: QuotaWindow | null; accent: 'coral' | 'blue' }): React.JSX.Element {
  const remaining = remainingQuota(window)
  const label = remaining === null ? '—' : remaining > 0 && remaining < 1 ? '<1%' : `${Math.round(remaining)}%`
  const status = remaining === null ? '用量尚未同步' : remaining === 0 ? '额度已用尽，等待刷新' : remaining < 10 ? '余量不多，留意刷新' : '仍可安心工作'
  const resetKnown = window && Number.isFinite(window.resetsAt) && window.resetsAt > 0
  return (
    <article className={`quota-card ${accent}`}>
      <div className="quota-heading">
        <span>{title}</span>
        <strong><small>剩余</small>{label}</strong>
      </div>
      <div className="meter" role="progressbar" aria-label={`${title}剩余额度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining ?? undefined} aria-valuetext={remaining === null ? '用量尚未同步' : `剩余 ${label}`}>
        <i style={{ width: `${remaining ?? 0}%` }} />
      </div>
      <div className="quota-footer">
        <span>{status}</span>
        <time>{resetKnown ? `${new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(window.resetsAt * 1000)} 刷新` : '等待额度信息'}</time>
      </div>
    </article>
  )
}
