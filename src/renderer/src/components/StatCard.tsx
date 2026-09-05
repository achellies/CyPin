import type { ReactNode } from 'react'

interface Props {
  label: string
  value: ReactNode
  sub?: string
  accent?: boolean
}

export function StatCard({ label, value, sub, accent }: Props) {
  return (
    <div className={`stat-card${accent ? ' accent' : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}
