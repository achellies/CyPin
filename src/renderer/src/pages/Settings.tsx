import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import type { StravaStatus, FtpEstimate } from '@shared/api'

export function SettingsPage({ onChanged }: { onChanged: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [status, setStatus] = useState<StravaStatus | null>(null)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [ftpEst, setFtpEst] = useState<FtpEstimate | null>(null)
  const [manualFtp, setManualFtp] = useState('')
  const [progress, setProgress] = useState<{ current: number; total: number; message: string } | null>(null)
  const [msg, setMsg] = useState('')
  const [proxy, setProxy] = useState('')
  const [autoSync, setAutoSync] = useState(false)

  const load = () => {
    window.api.getSettings().then((s) => {
      setSettings(s)
      setClientId(s.strava?.clientId ?? '')
      setClientSecret(s.strava?.clientSecret ?? '')
      setManualFtp(s.ftp.manual ? String(s.ftp.manual) : '')
      setProxy(s.proxy ?? '')
      setAutoSync(!!s.autoSync)
    })
    window.api.stravaStatus().then(setStatus)
    window.api.estimateFtp().then(setFtpEst)
  }

  useEffect(() => {
    load()
    return window.api.onSyncProgress((p) => setProgress(p))
  }, [])

  const save = async (patch: Partial<AppSettings>) => {
    const s = await window.api.saveSettings(patch)
    setSettings(s)
    onChanged()
  }

  const flash = (m: string) => {
    setMsg(m)
    setTimeout(() => setMsg(''), 4000)
  }

  return (
    <>
      <h1 className="page-title">设置</h1>
      <p className="page-sub">{msg && <span style={{ color: 'var(--green)' }}>{msg}</span>}</p>

      {/* ---------- Strava ---------- */}
      <div className="card">
        <h3>Strava 连接</h3>
        <p className="hint" style={{ marginTop: 0 }}>
          1. 打开 <b>strava.com/settings/api</b> 创建一个 API 应用（名称随意，授权回调域填 <b>localhost</b>）
          <br />
          2. 把得到的 Client ID 和 Client Secret 填在下面并保存
          <br />
          3. 点击「连接 Strava」，浏览器会弹出授权页面
        </p>
        <div className="row">
          <label className="field" style={{ width: 240 }}>
            <span>Client ID</span>
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} style={{ width: '100%' }} />
          </label>
          <label className="field" style={{ width: 340 }}>
            <span>Client Secret</span>
            <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} style={{ width: '100%' }} />
          </label>
        </div>
        <div className="row">
          <button
            className="btn"
            onClick={async () => {
              await save({ strava: { clientId, clientSecret } })
              flash('凭据已保存')
            }}
          >
            保存凭据
          </button>
          <button
            className="btn primary"
            disabled={!clientId || !clientSecret || !!status?.connected}
            onClick={async () => {
              flash('等待浏览器授权…')
              const r = await window.api.stravaConnect()
              flash(r.ok ? '连接成功！' : `连接失败：${r.error}`)
              load()
            }}
          >
            {status?.connected ? `已连接 ${status.connectedAs ?? ''}` : '连接 Strava'}
          </button>
          {status?.connected && (
            <button
              className="btn"
              onClick={async () => {
                await window.api.stravaDisconnect()
                load()
              }}
            >
              断开
            </button>
          )}
          <button
            className="btn"
            disabled={!status?.connected}
            onClick={async () => {
              flash('正在同步活动列表…')
              const r = await window.api.syncActivities()
              flash(r.ok ? `同步完成：新增 ${r.added}，更新 ${r.updated}，共 ${r.total} 次` : r.error || '同步失败')
              load()
              onChanged()
            }}
          >
            同步活动列表
          </button>
          <button
            className="btn"
            disabled={!status?.connected}
            onClick={async () => {
              flash('正在后台同步详细数据（streams）…')
              const r = await window.api.syncAllStreams()
              flash(r.ok ? `streams 同步完成：成功 ${r.synced}，失败 ${r.failed}` : r.error || '同步失败')
              onChanged()
            }}
          >
            同步全部详细数据
          </button>
        </div>
        {progress && progress.total > 0 && (
          <div className="progress-bar">
            <div style={{ width: `${Math.round((progress.current / progress.total) * 100)}%` }} />
          </div>
        )}
        {progress && progress.total > 0 && <div className="progress-text">{progress.message}</div>}
      </div>

      {/* ---------- 网络 ---------- */}
      <div className="card">
        <h3>网络与自动同步</h3>
        <label className="field" style={{ maxWidth: 420 }}>
          <span>HTTP 代理（留空跟随系统；国内访问 Strava 可填如 http://127.0.0.1:7890）</span>
          <input
            value={proxy}
            placeholder="http://127.0.0.1:7890"
            onChange={(e) => setProxy(e.target.value)}
            onBlur={() => save({ proxy })}
            style={{ width: '100%' }}
          />
        </label>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={autoSync} onChange={(e) => { setAutoSync(e.target.checked); save({ autoSync: e.target.checked }) }} />
          <span style={{ color: 'var(--text)' }}>启动应用时自动同步 Strava 活动列表</span>
        </label>
      </div>

      {/* ---------- FTP ---------- */}
      <div className="card">
        <h3>FTP（功能阈值功率）</h3>
        <div className="row" style={{ marginBottom: 12 }}>
          <label className="row" style={{ gap: 6 }}>
            <input
              type="radio"
              checked={settings?.ftp.mode === 'auto'}
              onChange={() => save({ ftp: { ...settings!.ftp, mode: 'auto' } })}
            />
            <span style={{ color: 'var(--text)' }}>自动估算</span>
          </label>
          <label className="row" style={{ gap: 6 }}>
            <input
              type="radio"
              checked={settings?.ftp.mode === 'manual'}
              onChange={() => save({ ftp: { ...settings!.ftp, mode: 'manual' } })}
            />
            <span style={{ color: 'var(--text)' }}>手动指定</span>
          </label>
          {settings?.ftp.mode === 'manual' && (
            <>
              <input
                placeholder="FTP (W)"
                value={manualFtp}
                onChange={(e) => setManualFtp(e.target.value)}
                style={{ width: 100 }}
              />
              <button
                className="btn small"
                onClick={async () => {
                  const v = Number(manualFtp)
                  if (v > 50 && v < 800) {
                    await save({ ftp: { ...settings!.ftp, manual: v } })
                    flash(`FTP 已设为 ${v}W`)
                  }
                }}
              >
                应用
              </button>
            </>
          )}
          <button
            className="btn small"
            onClick={async () => {
              flash('正在根据历史功率数据重新估算…')
              await window.api.recomputeFtp()
              load()
              flash('估算完成，TSS 已重算')
              onChanged()
            }}
          >
            重新估算并重算 TSS
          </button>
        </div>
        {ftpEst && (
          <div className="row" style={{ color: 'var(--muted)', fontSize: 13 }}>
            <span>当前生效：<b style={{ color: 'var(--accent)' }}>{settings ? (settings.ftp.mode === 'manual' ? settings.ftp.manual : settings.ftp.auto) ?? '未设置' : '—'} W</b></span>
            <span>· 20min 最佳 {ftpEst.best20 ? Math.round(ftpEst.best20) + 'W' : '—'}</span>
            <span>· 20min 法推算 {ftpEst.from20min ?? '—'}W</span>
            <span>· CP {ftpEst.cp ?? '—'}W</span>
            <span>· W′ {ftpEst.wPrime ?? '—'}kJ</span>
            <span>· 依据 {ftpEst.basedOn} 次功率数据</span>
          </div>
        )}
        <div className="hint" style={{ marginTop: 8 }}>
          自动模式：取「20 分钟最佳功率 × 0.95」与「3/12 分钟临界功率 CP 模型」中的较大值。
          注意：日常骑行没有全力输出时，估算值偏低（下限估计）；建议定期做一次 20 分钟全力测试校准，或直接手动指定。
        </div>
      </div>

      {/* ---------- 生理参数 ---------- */}
      <div className="card">
        <h3>生理参数（用于心率区间与建议）</h3>
        <div className="row">
          <NumField label="体重 (kg)" value={settings?.weightKg} onCommit={(v) => save({ weightKg: v })} />
          <NumField label="最大心率 (bpm)" value={settings?.maxHr} onCommit={(v) => save({ maxHr: v })} />
          <NumField label="乳酸阈心率 LTHR" value={settings?.lthr} onCommit={(v) => save({ lthr: v })} />
        </div>
        <div className="hint" style={{ marginTop: 8 }}>
          心率区间优先使用 LTHR（Z1&lt;68% / Z2 68-83% / Z3 83-94% / Z4 94-105% / Z5&gt;105%），未填则用最大心率百分比；两者都未填时从历史最大心率推断。
        </div>
      </div>

      {/* ---------- 骑行类型 ---------- */}
      <div className="card">
        <h3>纳入分析的骑行类型</h3>
        <div className="row">
          {[
            ['Ride', '公路'],
            ['VirtualRide', '骑行台'],
            ['GravelRide', '砾石'],
            ['MountainBikeRide', '山地'],
            ['EBikeRide', '电助力']
          ].map(([v, label]) => (
            <label key={v} className="row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={settings?.rideTypes.includes(v) ?? false}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...settings!.rideTypes, v]
                    : settings!.rideTypes.filter((t) => t !== v)
                  save({ rideTypes: next })
                }}
              />
              <span style={{ color: 'var(--text)' }}>{label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* ---------- 导入 ---------- */}
      <div className="card">
        <h3>本地文件导入</h3>
        <div className="row">
          <button
            className="btn"
            onClick={async () => {
              const r = await window.api.importFiles()
              flash(r.imported > 0 ? `成功导入 ${r.imported} 个文件${r.failed.length ? `，失败 ${r.failed.length}` : ''}` : '没有导入文件')
              if (r.imported > 0) onChanged()
            }}
          >
            选择 FIT / GPX 文件…
          </button>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>
          支持 Strava 导出的 .fit 与 .gpx。导入的活动与 Strava 数据合并存储。
        </div>
      </div>

      {/* ---------- 数据管理 ---------- */}
      <div className="card danger-zone">
        <h3 style={{ color: 'var(--red)' }}>数据管理</h3>
        <div className="row">
          <button
            className="btn danger"
            onClick={async () => {
              if (window.confirm('确定清空全部骑行活动与详细数据？\n此操作不可恢复（Strava 数据可重新同步，本地导入文件需重新导入）。设置与授权会保留。')) {
                await window.api.clearData()
                flash('已清空全部骑行数据')
                onChanged()
              }
            }}
          >
            清空全部骑行数据
          </button>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>
          清空后可在「训练建议」页的引导下重新同步；删除单次活动可在活动详情页操作。
        </div>
      </div>
    </>
  )
}

function NumField({ label, value, onCommit }: { label: string; value?: number; onCommit: (v: number | undefined) => void }) {
  const [text, setText] = useState(value != null ? String(value) : '')
  useEffect(() => {
    setText(value != null ? String(value) : '')
  }, [value])
  return (
    <label className="field" style={{ width: 160 }}>
      <span>{label}</span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const v = Number(text)
          onCommit(text.trim() === '' ? undefined : Number.isFinite(v) && v > 0 ? v : undefined)
        }}
        style={{ width: '100%' }}
      />
    </label>
  )
}
