import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";
import { LanguageProvider } from "./lib/i18n.jsx";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient.js";
import { Toaster } from "react-hot-toast";
import { ErrorBoundary } from "react-error-boundary";

// Global safety net: if ANY render crashes, show a Reload screen instead of a blank white page
class BootBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { crashed: false, err: "" };
  }
  static getDerivedStateFromError(e) {
    return { crashed: true, err: String(e?.message || e) };
  }
  componentDidCatch(e, info) {
    try { console.error("BijliSathi crash:", e, info?.componentStack); } catch (e) {}
  }
  componentDidMount() {
    // Auto-recover when hash changes — prevents staying stuck on snag after navigating away from buggy route
    this._onHash = () => {
      if (this.state.crashed) this.setState({ crashed: false, err: "" });
    };
    try { window.addEventListener('hashchange', this._onHash); } catch (e) {}
  }
  componentWillUnmount() {
    try { window.removeEventListener('hashchange', this._onHash); } catch (e) {}
  }
  render() {
    if (this.state.crashed) {
      return (
        <div style={{ minHeight: "100vh", background: "#FAF7F0", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif", textAlign: "center", padding: "24px" }}>
          <p style={{ fontWeight: 700, fontSize: "20px", color: "#0A1B33", margin: 0 }}>BijliSathi hit a snag</p>
          <p style={{ color: "#5A6B8C", fontSize: "13px", margin: "10px 0 18px" }}>Tap reload to get the latest working version.</p>
          {this.state.err ? <p style={{ color: "#9A6B8C", fontSize: "11px", margin: "0 0 12px", maxWidth: 360, wordBreak: "break-word", fontFamily: "monospace" }}>{this.state.err.slice(0, 300)}</p> : null}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
            <button onClick={() => window.location.reload()} style={{ background: "#F2A93B", color: "#0A1B33", border: 0, padding: "12px 30px", borderRadius: "12px", fontSize: "15px", fontWeight: 700 }}>Reload BijliSathi</button>
            <button onClick={() => { try { localStorage.removeItem('bs_auth'); sessionStorage.clear(); } catch (e) {}; this.setState({ crashed: false, err: "" }); window.location.hash = '#/'; window.location.reload(); }} style={{ background: "#fff", color: "#0A1B33", border: "1px solid #E5E0D5", padding: "12px 20px", borderRadius: "12px", fontSize: "13px", fontWeight: 600 }}>Clear & Go Home</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function Fallback({ error, resetErrorBoundary }) {
  return (
    <div style={{ minHeight: "100vh", background: "#FAF7F0", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif", textAlign: "center", padding: "24px" }}>
      <p style={{ fontWeight: 700, fontSize: "20px", color: "#0A1B33", margin: 0 }}>BijliSathi hit a snag</p>
      <p style={{ color: "#5A6B8C", fontSize: "13px", margin: "10px 0 18px" }}>{String(error?.message || error).slice(0, 200)}</p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
        <button onClick={resetErrorBoundary} style={{ background: "#F2A93B", color: "#0A1B33", border: 0, padding: "12px 30px", borderRadius: "12px", fontSize: "15px", fontWeight: 700 }}>Try Again</button>
        <button onClick={() => { try { localStorage.removeItem('bs_auth'); sessionStorage.clear(); } catch (e) {}; window.location.hash = '#/'; window.location.reload(); }} style={{ background: "#fff", color: "#0A1B33", border: "1px solid #E5E0D5", padding: "12px 20px", borderRadius: "12px", fontSize: "13px", fontWeight: 600 }}>Clear & Go Home</button>
      </div>
    </div>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("Root element #root not found");
const root = createRoot(container);
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <ErrorBoundary FallbackComponent={Fallback} onReset={() => { try { window.location.hash = '#/'; } catch (e) {} }}>
          <BootBoundary>
            <App />
          </BootBoundary>
        </ErrorBoundary>
      </LanguageProvider>
      {/* Global toast — replaces all alert() calls with branded toasts */}
      <Toaster
        position="top-center"
        toastOptions={{
          duration: 3000,
          style: { background: "#0A1B33", color: "#fff", borderRadius: "12px", fontSize: "14px", padding: "12px 16px" },
          success: { iconTheme: { primary: "#2E9E6B", secondary: "#fff" } },
          error: { iconTheme: { primary: "#D64545", secondary: "#fff" } },
        }}
      />
    </QueryClientProvider>
  </React.StrictMode>
);

// Hide the inline boot screen from index.html once React has taken over
// (small delay so a first-render crash still triggers the recovery overlay)
if (typeof window !== "undefined" && typeof window.__BS_MOUNTED === "function") {
  setTimeout(() => { try { window.__BS_MOUNTED(); } catch (e) {} }, 150);
}
