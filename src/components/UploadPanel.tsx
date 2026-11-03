import type { ChangeEvent } from "react";
import { IconPlus, IconUpload } from "./icons";

type UploadPanelProps = {
  onFiles: (files: File[]) => void;
  isProcessing: boolean;
  // hero：欢迎页的大投放区；compact：工作台图纸栏里的“添加图片”按钮。
  variant?: "hero" | "compact";
};

const ACCEPT = "image/png,image/jpeg,image/webp";

/** 选择图片入口。拖放由整窗 DropOverlay 统一处理，这里只负责点击选择。 */
export function UploadPanel({ onFiles, isProcessing, variant = "hero" }: UploadPanelProps) {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };
  const input = (
    <input aria-label="选择图片文件" type="file" accept={ACCEPT} multiple onChange={handleChange} disabled={isProcessing} />
  );

  if (variant === "compact") {
    return (
      <label className={`upload-compact ${isProcessing ? "is-busy" : ""}`}>
        {input}
        {isProcessing
          ? <span className="bead-loader" aria-hidden="true"><i /><i /><i /><i /></span>
          : <IconPlus aria-hidden="true" />}
        <span aria-live="polite">{isProcessing ? "正在读取…" : "添加图片"}</span>
      </label>
    );
  }

  return (
    <label className={`dropzone ${isProcessing ? "is-busy" : ""}`} id="upload-title">
      {input}
      <span className="dropzone-icon">
        {isProcessing
          ? <span className="bead-loader" aria-hidden="true"><i /><i /><i /><i /></span>
          : <IconUpload aria-hidden="true" />}
      </span>
      <strong aria-live="polite">{isProcessing ? "正在读取图片…" : "拖入图片，或点击选择"}</strong>
      <small>JPG / PNG / WebP，可一次选择多张；图片只在本机浏览器处理，不会上传。</small>
    </label>
  );
}
