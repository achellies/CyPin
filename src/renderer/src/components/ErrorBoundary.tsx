import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/** 全局渲染错误边界：任何页面渲染崩溃时显示错误占位+重试，而不是白屏 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('[骑评] 页面渲染错误:', error)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="empty-state" style={{ padding: 48, gap: 10 }}>
          <h2 style={{ fontSize: 17 }}>页面渲染出错了</h2>
          <p style={{ color: 'var(--muted)', fontSize: 12.5, maxWidth: 560, wordBreak: 'break-all' }}>{this.state.error.message}</p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn" onClick={() => this.setState({ error: null })}>
              重试
            </button>
            <button className="btn" onClick={() => location.reload()}>
              刷新应用
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
