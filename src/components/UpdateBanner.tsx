import { useEffect, useState } from "react";
import { applyPendingUpdate, isUpdateReady, subscribeUpdate } from "../domain/appUpdate";

/** 有新版本时在底部提示，用户点“刷新”才切换，避免编辑到一半被强制刷新。 */
export function UpdateBanner() {
  const [ready, setReady] = useState(isUpdateReady);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => subscribeUpdate(() => { setReady(true); setDismissed(false); }), []);

  if (!ready || dismissed) return null;
  return (
    <div className="update-banner" role="status" aria-live="polite">
      <span>网站有新版本。保存好正在编辑的图纸后刷新即可使用。</span>
      <button
        type="button"
        className="button small primary"
        disabled={busy}
        onClick={() => { setBusy(true); void applyPendingUpdate(); }}
      >
        {busy ? "正在更新…" : "刷新到新版本"}
      </button>
      <button type="button" className="button small" onClick={() => setDismissed(true)}>稍后</button>
    </div>
  );
}
