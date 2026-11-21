import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Full-screen fallback shown when the app fails to render. Kept intentionally generic
 * (a configuration error is the most common cause — e.g. missing Supabase env vars)
 * and styled to match the login/landing shell.
 */
export function AppErrorScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-3 text-center">
        <img src="/nac-logo.png" alt="NAC" width={40} height={40} className="mx-auto rounded" />
        <h1 className="text-lg font-bold">OAC Cashbook</h1>
        <p role="alert" className="text-sm text-destructive">
          The app could not start — configuration error. Please contact the administrator.
        </p>
      </div>
    </div>
  );
}

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Catches any render error in the routed app (including a missing-config / broken
 * Supabase client error) and shows a readable fallback instead of a blank screen.
 * The landing page renders inside this boundary but never calls Supabase, so it keeps
 * working even when configuration is missing.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Diagnostics only. error.message may name a missing config KEY but never its
    // value, so this does not leak secrets.
    console.error("App render error:", error.message, info.componentStack);
  }

  render() {
    if (this.state.hasError) return <AppErrorScreen />;
    return this.props.children;
  }
}
