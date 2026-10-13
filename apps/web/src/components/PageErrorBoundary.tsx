import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

/**
 * A page that throws shows this instead of taking the whole app down to a blank
 * screen. Keyed by the route in Layout, so moving to another page starts fresh.
 */
export class PageErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('SupOps page error:', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="grid min-h-[60vh] place-items-center p-6">
        <div className="tile max-w-md p-6 text-center">
          <AlertTriangle size={28} className="mx-auto text-amber" />
          <h2 className="mt-3 text-base font-semibold text-ink">This page ran into a problem</h2>
          <p className="mt-1 text-sm text-muted">Nothing was lost: your runs, calls and approvals are saved on the server. Reload the page, or open another one from the menu.</p>
          <p className="mt-3 break-words font-mono text-[11px] text-dim">{error.message}</p>
          <button className="btn-primary mt-4" onClick={() => window.location.reload()}>
            <RotateCcw size={14} /> Reload
          </button>
        </div>
      </div>
    );
  }
}
