import { Component, useRef, type ComponentType, type ReactNode } from 'react'
import type { Translate } from '../i18n'
import { useConversationSurface } from './useConversationSurface'

export function makeErrorBoundary(t: Translate): ComponentType<{ children?: ReactNode }> {
  function ErrorCard(props: { error: Error; retry: () => void }): ReactNode {
    const ref = useRef<HTMLDivElement | null>(null)
    useConversationSurface(ref)
    return (
      <div className="lc-root" ref={ref}>
        <div className="lc-empty lc-error">
          <span>{t('error')}</span>
          <code className="lc-error-msg">{props.error.message}</code>
          <button
            type="button"
            className="lc-error-retry hover:border-(--dsw-alias-label-primary)"
            onClick={props.retry}
          >{t('error.retry')}</button>
        </div>
      </div>
    )
  }

  return class ErrorBoundary extends Component<{ children?: ReactNode }, { error: Error | null }> {
    constructor(props: { children?: ReactNode }) {
      super(props)
      this.state = { error: null }
    }

    static getDerivedStateFromError(error: unknown): { error: Error | null } {
      return { error: error instanceof Error ? error : new Error(String(error)) }
    }

    render(): ReactNode {
      const error = this.state.error
      if (error === null) return this.props.children
      return <ErrorCard error={error} retry={() => { this.setState({ error: null }) }} />
    }
  }
}
