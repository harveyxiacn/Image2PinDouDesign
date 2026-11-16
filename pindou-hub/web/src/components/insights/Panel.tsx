// 数据洞察的面板外壳：标题 + 一句结论（重点）+ 图表（证据）。
import type { ReactNode } from "react";

export function InsightPanel({ id, title, takeaway, aside, children }: { id: string; title: string; takeaway: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel ins-panel" aria-labelledby={`${id}-h`}>
      <div className="ins-head">
        <h2 id={`${id}-h`}>{title}</h2>
        {aside ? <div className="ins-aside">{aside}</div> : null}
      </div>
      <p className="ins-take">{takeaway}</p>
      {children}
    </section>
  );
}

export function InsightEmpty({ title, text, href, action }: { title: string; text: string; href?: string; action?: string }) {
  return (
    <div className="empty ins-empty">
      <h3>{title}</h3>
      <p>{text}</p>
      {href ? <a className="btn btn-sm" href={href}>{action}</a> : null}
    </div>
  );
}
