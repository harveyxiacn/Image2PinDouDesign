import type { ChangeEvent, DragEvent } from "react";

type UploadPanelProps = {
  onFiles: (files: File[]) => void;
  isProcessing: boolean;
};

export function UploadPanel({ onFiles, isProcessing }: UploadPanelProps) {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
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
        className="dropzone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
      >
        <input
          aria-label="选择图片文件"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          onChange={handleChange}
        />
        <span className="dropzone-icon">+</span>
        <strong>{isProcessing ? "正在读取图片..." : "拖拽图片到这里，或点击选择"}</strong>
        <small>一次可处理多张图，系统会自动汇总用豆数量。</small>
      </label>
    </section>
  );
}
