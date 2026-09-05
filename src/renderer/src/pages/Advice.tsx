import { useEffect, useState } from 'react'
import type { AdviceItem } from '@shared/types'

const LEVEL_LABEL: Record<AdviceItem['level'], string> = {
  danger: '重要警告',
  warn: '需要注意',
  info: '建议',
  good: '状态良好'
}

export function Advice({ version }: { version: number }) {
  const [items, setItems] = useState<AdviceItem[]>([])

  useEffect(() => {
    window.api.getAdvice().then(setItems)
  }, [version])

  if (items.length === 0) return <div className="empty-state">加载中…</div>

  return (
    <>
      <h1 className="page-title">训练建议</h1>
      <p className="page-sub">基于训练负荷（CTL/ATL/TSB）、强度分布、心率漂移与能力进展的规则引擎，随每次数据同步自动更新</p>

      {items.map((it, i) => (
        <div key={i} className={`card advice-card ${it.level}`}>
          <div className={`advice-level ${it.level}`}>
            {LEVEL_LABEL[it.level]} · {it.category}
          </div>
          <div className="advice-title">{it.title}</div>
          <div className="advice-detail">{it.detail}</div>
          {it.action && <div className="advice-action">{it.action}</div>}
        </div>
      ))}
    </>
  )
}
