import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./error-boundary";
import "./styles.css";

// Forward otherwise-silent renderer failures (uncaught errors, unhandled promise
// rejections) to the main process log. Without this, a renderer crash leaves no
// trace anywhere on an unattended server.
function reportRendererError(report: Parameters<typeof window.rd.reportRendererError>[0]): void {
  try {
    window.rd?.reportRendererError(report);
  } catch {
  }
}

window.addEventListener("error", (event) => {
  reportRendererError({
    kind: "error",
    message: event.message || String(event.error || "Unbekannter Fehler"),
    stack: event.error instanceof Error ? event.error.stack : undefined,
    source: event.filename || undefined,
    line: typeof event.lineno === "number" ? event.lineno : undefined,
    column: typeof event.colno === "number" ? event.colno : undefined
  });
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  reportRendererError({
    kind: "unhandledrejection",
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined
  });
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element fehlt");
}

createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
