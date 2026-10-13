import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isChunkLoadError } from '../state/chunk-reload';
import { Button } from './Button';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Catches render errors in a page so the rest of the app (top bar, nav) keeps working. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Page crashed', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    // A missing build chunk (the app was updated) can't be retried in place: React.lazy caches the failure.
    const outdated = isChunkLoadError(error);
    return (
      <section className="card crash" role="alert">
        <h2>{outdated ? 'This page could not be loaded' : 'Something went wrong on this page'}</h2>
        <p className="muted" style={{ marginTop: 6 }}>
          {outdated
            ? 'The app was probably updated since this tab was opened. Reload the page to get the new version.'
            : 'Try again, or reload the page. If it keeps happening, check the browser console and the container logs.'}
        </p>
        <pre>{error.message}</pre>
        <div className="form-actions" style={{ marginTop: 14 }}>
          {outdated ? (
            <Button variant="primary" onClick={() => location.reload()}>
              Reload
            </Button>
          ) : (
            <>
              <Button variant="primary" onClick={() => this.setState({ error: null })}>
                Try again
              </Button>
              <Button onClick={() => location.reload()}>Reload</Button>
            </>
          )}
        </div>
      </section>
    );
  }
}
