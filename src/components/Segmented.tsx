import type { CSSProperties, ReactNode } from "react";

export type SegmentedOption<T extends string | number> = {
  value: T;
  label: ReactNode;
  title?: string;
};

type SegmentedProps<T extends string | number> = {
  label: string;
  value: T;
  options: Array<SegmentedOption<T>>;
  onChange: (value: T) => void;
  size?: "regular" | "compact";
  className?: string;
};

/**
 * 分段选择：按钮组 + aria-pressed（与统计口径切换保持同一语义）。
 * 选中滑块由 CSS 变量 --index / --count 定位，切换时只做 transform 过渡，
 * 中断时直接落到新位置，状态不依赖 transitionend。
 */
export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  size = "regular",
  className = ""
}: SegmentedProps<T>) {
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  const hasSelection = options.some((option) => option.value === value);
  const style = { "--index": index, "--count": options.length } as CSSProperties;
  return (
    <div
      className={`segmented segmented-${size} ${hasSelection ? "has-selection" : ""} ${className}`.trim()}
      role="group"
      aria-label={label}
      style={style}
    >
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
