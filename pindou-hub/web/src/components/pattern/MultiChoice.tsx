// 一次选了多张图：先问清楚是「同一张图纸的分段截图」还是「不同的图纸」。
import { Icon } from "../ui";
import "./stitch.css";

export default function MultiChoice({ count, onStitch, onBatch, onCancel }: { count: number; onStitch: () => void; onBatch: () => void; onCancel: () => void }) {
  return (
    <div className="panel panel-pad stack st-choice" role="group" aria-label="多张图片怎么处理" data-testid="multi-choice">
      <div><h3>选了 {count} 张图片，怎么处理？</h3><p className="meta">两种情况处理方式不一样，请选一个。</p></div>
      <div className="st-choice-grid">
        <button type="button" className="st-choice-card pressable" onClick={onStitch}>
          <Icon name="scan" size={22} />
          <b>是同一张图纸的分段截图</b>
          <span className="meta">自动找到重叠部分，拼成一张长图再识别</span>
          <span className="btn btn-iron btn-sm" aria-hidden="true">拼接成一张</span>
        </button>
        <button type="button" className="st-choice-card pressable" onClick={onBatch}>
          <Icon name="gallery" size={22} />
          <b>是不同的图纸</b>
          <span className="meta">每张单独识别，最后一起保存</span>
          <span className="btn btn-sm" aria-hidden="true">批量导入</span>
        </button>
      </div>
      <div className="row"><button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>重新选择</button></div>
    </div>
  );
}
