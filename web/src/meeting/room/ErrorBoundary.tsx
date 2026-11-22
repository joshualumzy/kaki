import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
}

/** Shows a plain sentence and a Reload button instead of a blank page when a child component throws; the detail goes to the console. */
export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false
  };

  public static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      // Reloading rejoins the same seat: the tab remembers its join (see rejoinSession).
      return (
        <div role="alert" style={{ padding: '20px', height: '100%', width: '100%' }}>
          <p>Something went wrong in the meeting.</p>
          <button type="button" className="kd-go" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
