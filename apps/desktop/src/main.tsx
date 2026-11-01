import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ padding: 24, fontFamily: "Menlo, monospace", fontSize: 12, whiteSpace: "pre-wrap" }}>
        <strong>Something went wrong.</strong>
        {"\n\n" + error.message + "\n\n" + (error.stack ?? "")}
      </div>
    );
  }
}

if (import.meta.env.DEV && new URLSearchParams(location.search).has("preview")) await import("./dev/mock");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
