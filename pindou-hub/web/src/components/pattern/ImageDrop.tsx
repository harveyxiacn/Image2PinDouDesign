import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui";
import "./pattern.css";

/** 图片选择区：点击 / 拖入 / 粘贴 / 手机相机。onFile 收到的一定是 image/*。 */
export default function ImageDrop({ onFile, onFiles, title, hint, compact }: {
  onFile: (file: File) => void;
  /** 传了就允许一次选多张：选了 2 张以上时调用它（单张仍走 onFile） */
  onFiles?: (files: File[]) => void;
  title?: string; hint?: string; compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const item = Array.from(event.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      const file = item?.getAsFile();
      if (file) { event.preventDefault(); onFile(file); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [onFile]);

  const take = (files: FileList | null | undefined) => {
    const imgs = Array.from(files ?? []).filter((f) => f.type.startsWith("image/"));
    if (imgs.length > 1 && onFiles) onFiles(imgs);
    else if (imgs[0]) onFile(imgs[0]);
  };

  return (
    <div
      className={`pt-drop pegboard${compact ? " compact" : ""}`}
      role="button"
      tabIndex={0}
      data-over={over}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.current?.click(); } }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
    >
      <span className="pt-drop-icon"><Icon name="upload" /></span>
      <div>
        <h3>{title ?? "拖入、点击选择或粘贴图片"}</h3>
        {hint ? <p className="meta">{hint}</p> : null}
      </div>
      <input ref={input} type="file" accept="image/*" multiple={!!onFiles} hidden onChange={(e) => { take(e.target.files); e.target.value = ""; }} />
    </div>
  );
}
