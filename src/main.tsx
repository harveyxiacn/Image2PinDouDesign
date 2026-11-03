import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { announceUpdate } from "./domain/appUpdate";
import "./styles.css";
import "./components/design-preview.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

// PWA：发现新版本时提示用户刷新（registerType: "prompt"），每小时检查一次更新。
if ("serviceWorker" in navigator) {
  void import("virtual:pwa-register").then(({ registerSW }) => {
    const updateSW = registerSW({
      onNeedRefresh() {
        announceUpdate(() => updateSW(true));
      },
      onRegisteredSW(_url, registration) {
        if (!registration) return;
        window.setInterval(() => { void registration.update(); }, 60 * 60 * 1000);
      }
    });
  });
}
