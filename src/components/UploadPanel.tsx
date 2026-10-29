import { useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { IconUpload } from "./icons";

type UploadPanelProps = {
  onFiles: (files: File[]) => void;
  isProcessing: boolean;
};

export function UploadPanel({ onFiles, isProcessing }: UploadPanelProps) {
  const [isDragging, setIsDragging] = useState(false);
  // dragenter/dragleave 会在子元素之间反复触发，用计数判断指针是否真正离开投放区。
  const dragDepth = useRef(0);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    onFiles(Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/")));
  };

  return (
    <section className="panel upload-panel" aria-labelledby="upload-title">
      <div>
        <p className="eyebrow">Step 01</p>
        <h2 id="upload-title">上传图片</h2>
        <p className="muted">支持 JPG、PNG、WebP；图片只在本机浏览器处理，不上传服务器。</p>
      </div>
      <label
        className={`dropzone ${isDragging ? "is-dragging" : ""} ${isProcessing ? "is-busy" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          setIsDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setIsDragging(false);
        }}
        onDrop={handleDrop}
      >
        <input
          aria-label="选择图片文件"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          onChange={handleChange}
        />
        <span className="dropzone-icon">
          {isProcessing
            ? <span className="bead-loader" aria-hidden="true"><i /><i /><i /><i /></span>
            : <IconUpload aria-hidden="true" />}
        </span>
        <strong aria-live="polite">
          {isProcessing ? "正在读取图片…" : isDragging ? "松开即可添加" : "拖拽图片到这里，或点击选择"}
        </strong>
        <small>可一次选择多张；每张独立生成图纸，并自动汇总用豆数量。</small>
      </label>
    </section>
  );
}
