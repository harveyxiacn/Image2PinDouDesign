import { useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

export type InspectorTab = "size" | "color" | "effects" | "beads";

export const INSPECTOR_TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: "size", label: "尺寸" },
  { id: "color", label: "颜色" },
  { id: "effects", label: "效果" },
  { id: "beads", label: "用豆" }
];

type InspectorProps = {
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  header?: ReactNode;
  children: ReactNode;
};

/**
 * 右侧检查器：按“尺寸 / 颜色 / 效果 / 用豆”分标签页，只渲染当前页，
 * 避免一整列超长设置。标签遵循 WAI-ARIA tabs：左右方向键 / Home / End 切换并聚焦。
 */
export function Inspector({ tab, onTabChange, header, children }: InspectorProps) {
  const tabRefs = useRef(new Map<InspectorTab, HTMLButtonElement>());
  const index = INSPECTOR_TABS.findIndex((item) => item.id === tab);

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = INSPECTOR_TABS.length - 1;
    const next = event.key === "ArrowRight" ? (index + 1) % INSPECTOR_TABS.length
      : event.key === "ArrowLeft" ? (index - 1 + INSPECTOR_TABS.length) % INSPECTOR_TABS.length
        : event.key === "Home" ? 0
          : event.key === "End" ? last
            : -1;
    if (next < 0) return;
    event.preventDefault();
    const target = INSPECTOR_TABS[next].id;
    onTabChange(target);
    tabRefs.current.get(target)?.focus();
  };

  return (
    <section className="inspector" id="inspector" aria-label="图纸设置与用豆">
      {header}
      <div
        className="inspector-tabs"
        role="tablist"
        aria-label="设置分类"
        onKeyDown={move}
        style={{ "--index": index, "--count": INSPECTOR_TABS.length } as React.CSSProperties}
      >
        {INSPECTOR_TABS.map((item) => (
          <button
            key={item.id}
            ref={(element) => {
              if (element) tabRefs.current.set(item.id, element);
              else tabRefs.current.delete(item.id);
            }}
            type="button"
            role="tab"
            id={`inspector-tab-${item.id}`}
            aria-selected={item.id === tab}
            aria-controls={`inspector-panel-${item.id}`}
            tabIndex={item.id === tab ? 0 : -1}
            onClick={() => onTabChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        key={tab}
        className="inspector-panel"
        role="tabpanel"
        id={`inspector-panel-${tab}`}
        aria-labelledby={`inspector-tab-${tab}`}
      >
        {children}
      </div>
    </section>
  );
}
