import "./pattern.css";

/** 细的确定进度条（0–1）。宽度用 transform 过渡，减少动态时直接跳到位。 */
export default function Progress({ value, label, className }: { value: number; label: string; className?: string }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className={`pt-progress${className ? ` ${className}` : ""}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)}>
      <i style={{ transform: `scaleX(${v})` }} />
    </div>
  );
}
