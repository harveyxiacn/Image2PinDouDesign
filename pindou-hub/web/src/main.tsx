import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initDb } from "./lib/db";
import { startAutoSync, tryLocalAutoPair } from "./lib/sync";
import "./styles.css";
import { applyStoredTheme } from "./components/stock/theme";

applyStoredTheme();

async function boot() {
  await initDb();
  await tryLocalAutoPair();
  startAutoSync();
  if (navigator.storage?.persist) void navigator.storage.persist().catch(() => false);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
void boot();
