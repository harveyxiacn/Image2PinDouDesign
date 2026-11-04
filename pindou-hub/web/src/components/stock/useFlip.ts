// 列表重排动画（参考 uiux-prompt-playbook › 列表重排 FLIP）：筛选 / 排序 / 分组变化时，
// 留下的卡片从旧位置滑到新位置，新出现的卡片淡入。≤ 220ms，减少动态时不播放。
import { useLayoutEffect, useRef, type RefObject } from "react";
import { prefersReducedMotion } from "../ui";

export function useFlip(container: RefObject<HTMLElement | null>, signature: string): void {
  const prev = useRef<Map<string, { x: number; y: number }> | null>(null);
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-flip]"));
    const next = new Map<string, { x: number; y: number }>();
    const rootBox = root.getBoundingClientRect();
    const before = prev.current;
    const animate = Boolean(before) && !prefersReducedMotion();
    for (const el of nodes) {
      const key = el.dataset.flip!;
      // 去掉进行中的位移后再量，得到最终布局位置
      el.getAnimations().forEach((a) => a.cancel());
      const box = el.getBoundingClientRect();
      const pos = { x: box.left - rootBox.left, y: box.top - rootBox.top };
      next.set(key, pos);
      if (!animate || !el.animate) continue;
      const old = before!.get(key);
      if (old) {
        const dx = old.x - pos.x, dy = old.y - pos.y;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 220, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
        }
      } else {
        el.animate([{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
      }
    }
    prev.current = next;
  }, [container, signature]);
}
