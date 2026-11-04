import type { AssistantStep } from "../../lib/recognize/types";
import { Icon } from "../ui";
import "./pattern.css";

const ICON: Record<string, string> = { ok: "check", warn: "alert", fail: "x", skip: "chevron" };

/** “豆探”助手的步骤时间线；running 为仍在进行的一行。 */
export default function AssistantTimeline({ steps, running }: { steps: AssistantStep[]; running?: boolean }) {
  return (
    <ol className="pt-steps" aria-live="polite">
      {steps.map((s) => (
        <li key={s.id} className={s.status}>
          <span className="pt-step-ic"><Icon name={ICON[s.status] ?? "check"} /></span>
          <div><b>{s.label}</b>{s.detail ? <div className="meta">{s.detail}</div> : null}</div>
        </li>
      ))}
      {running ? (
        <li className="running"><span className="pt-step-ic"><Icon name="sparkle" /></span><div className="meta">豆探正在看图…</div></li>
      ) : null}
    </ol>
  );
}
