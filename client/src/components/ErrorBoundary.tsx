import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  resetKey?: unknown
}
interface State {
  error: Error | null
  key?: unknown
}

/** Stops a bad schema from crashing the whole page. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  static getDerivedStateFromProps(props: Props, state: State) {
    if (props.resetKey !== state.key) return { error: null, key: props.resetKey }
    return null
  }

  render() {
    if (this.state.error) {
      return (
        <div className="inline-error">
          <strong>Could not render this form.</strong>
          <div>{this.state.error.message}</div>
        </div>
      )
    }
    return this.props.children
  }
}
