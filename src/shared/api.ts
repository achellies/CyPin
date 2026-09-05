import type {
  AbilityData,
  Activity,
  ActivityDetailData,
  AppSettings,
  DashboardData,
  AdviceItem,
  TrendsData
} from './types'

export interface ActivityRow extends Activity {
  tss?: number
  tssMethod?: string
}

export interface StravaStatus {
  connected: boolean
  connectedAs: string | null
  credentialsOk: boolean
  tokenExpired: boolean
}

export interface FtpEstimate {
  recommended: number | null
  from20min: number | null
  cp: number | null
  wPrime: number | null
  best20: number | null
  basedOn: number
}

export interface Api {
  getSettings(): Promise<AppSettings>
  saveSettings(s: Partial<AppSettings>): Promise<AppSettings>
  stravaStatus(): Promise<StravaStatus>
  stravaConnect(): Promise<{ ok: boolean; error?: string }>
  stravaDisconnect(): Promise<void>
  syncActivities(): Promise<{ ok: boolean; added?: number; updated?: number; total?: number; error?: string }>
  syncAllStreams(): Promise<{ ok: boolean; synced?: number; failed?: number; error?: string }>
  listActivities(filter?: {
    type?: string
    from?: string
    to?: string
    search?: string
  }): Promise<ActivityRow[]>
  getActivityDetail(id: string): Promise<ActivityDetailData | null>
  getDashboard(): Promise<DashboardData>
  getTrends(): Promise<TrendsData>
  getAbility(): Promise<AbilityData>
  getAdvice(): Promise<AdviceItem[]>
  estimateFtp(): Promise<FtpEstimate>
  recomputeFtp(): Promise<AppSettings>
  deleteActivity(id: string): Promise<{ ok: boolean }>
  clearData(): Promise<{ ok: boolean }>
  importFiles(): Promise<{ imported: number; failed: string[] }>
  onSyncProgress(cb: (p: { phase: string; current: number; total: number; message: string }) => void): () => void
}
