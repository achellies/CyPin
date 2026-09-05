import { useCallback, useEffect, useState } from 'react'
import { Dashboard } from './pages/Dashboard'
import { Activities } from './pages/Activities'
import { Detail } from './pages/Detail'
import { Trends } from './pages/Trends'
import { Analysis } from './pages/Analysis'
import { Advice } from './pages/Advice'
import { Workouts } from './pages/Workouts'
import { SettingsPage } from './pages/Settings'
import { StravaStatus } from '@shared/api'

type Page = 'dashboard' | 'activities' | 'detail' | 'trends' | 'ability' | 'workouts' | 'advice' | 'settings'

const NAV: { key: Page; label: string; icon: string }[] = [
  { key: 'dashboard', label: '仪表盘', icon: '◧' },
  { key: 'activities', label: '活动', icon: '☰' },
  { key: 'trends', label: '趋势', icon: '↗' },
  { key: 'ability', label: '能力分析', icon: '◈' },
  { key: 'workouts', label: '训练课表', icon: '⟳' },
  { key: 'advice', label: '训练建议', icon: '✦' },
  { key: 'settings', label: '设置', icon: '⚙' }
]

export default function App() {
  const [page, setPage] = useState<Page>('dashboard')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [status, setStatus] = useState<StravaStatus | null>(null)
  const [version, setVersion] = useState(0)

  const refreshStatus = useCallback(() => {
    window.api.stravaStatus().then(setStatus)
  }, [])

  useEffect(refreshStatus, [refreshStatus, version])

  const openDetail = (id: string) => {
    setDetailId(id)
    setPage('detail')
  }

  const reload = () => setVersion((v) => v + 1)

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          <span className="logo-mark">⬡</span>
          <div>
            <div className="logo-name">骑评</div>
            <div className="logo-sub">骑行数据点评</div>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <button
              key={n.key}
              className={`nav-item${page === n.key || (n.key === 'activities' && page === 'detail') ? ' active' : ''}`}
              onClick={() => setPage(n.key)}
            >
              <span className="nav-icon">{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className={`conn-dot ${status?.connected ? 'on' : 'off'}`} />
          <span>{status?.connected ? `Strava: ${status.connectedAs || '已连接'}` : 'Strava 未连接'}</span>
        </div>
      </aside>
      <main className="content">
        {page === 'dashboard' && <Dashboard version={version} onOpenDetail={openDetail} onGoSettings={() => setPage('settings')} />}
        {page === 'activities' && <Activities version={version} onOpenDetail={openDetail} />}
        {page === 'detail' && detailId && <Detail id={detailId} onBack={() => setPage('activities')} />}
        {page === 'trends' && <Trends version={version} />}
        {page === 'ability' && <Analysis version={version} onOpenDetail={openDetail} />}
        {page === 'workouts' && <Workouts />}
        {page === 'advice' && <Advice version={version} />}
        {page === 'settings' && <SettingsPage onChanged={reload} />}
      </main>
    </div>
  )
}
