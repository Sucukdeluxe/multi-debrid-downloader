import React from "react";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

// Catches render-time errors in the component tree so a crash shows a minimal
// recovery surface instead of a silent white screen, and forwards the error to
// the main process log. Kept deliberately dead-simple and state-independent: an
// error inside the error path is how you get a second white screen or a loop.
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { hasError: true, message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    try {
      window.rd?.reportRendererError({
        kind: "react",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        componentStack: info?.componentStack || undefined
      });
    } catch {
    }
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }
    const overlay: React.CSSProperties = {
      position: "fixed",
      inset: 0,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: 16,
      padding: 32,
      background: "#070b14",
      color: "#e6edf6",
      fontFamily: "Segoe UI, system-ui, sans-serif",
      textAlign: "center"
    };
    const pre: React.CSSProperties = {
      maxWidth: 640,
      maxHeight: 200,
      overflow: "auto",
      padding: 12,
      background: "#0d1422",
      border: "1px solid #243049",
      borderRadius: 6,
      color: "#ff9a8c",
      fontSize: 12,
      whiteSpace: "pre-wrap",
      textAlign: "left"
    };
    const button: React.CSSProperties = {
      padding: "8px 20px",
      background: "#2d5cff",
      color: "#fff",
      border: "none",
      borderRadius: 6,
      cursor: "pointer",
      fontSize: 14
    };
    return (
      <div style={overlay}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Die Oberfläche hat einen Fehler ausgelöst</h1>
        <p style={{ margin: 0, maxWidth: 560, color: "#9aa7bd" }}>
          Die Anzeige wurde gestoppt, um Datenverlust zu vermeiden. Die laufenden Downloads im
          Hintergrund sind nicht betroffen. Der Fehler wurde ins Log geschrieben.
        </p>
        <pre style={pre}>{this.state.message}</pre>
        <button type="button" style={button} onClick={this.handleReload}>Oberfläche neu laden</button>
      </div>
    );
  }
}
