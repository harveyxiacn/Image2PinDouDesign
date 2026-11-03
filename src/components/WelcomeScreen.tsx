import { BOARD_PIN_OPTIONS } from "../domain/boards";
import type { PaletteKit } from "../domain/paletteKits";
import { Segmented } from "./Segmented";
import { UploadPanel } from "./UploadPanel";

type WelcomeScreenProps = {
  onFiles: (files: File[]) => void;
  isProcessing: boolean;
  boardPins: number;
  onBoardPinsChange: (pins: number) => void;
  kits: PaletteKit[];
  kitId: string;
  onKitChange: (id: string) => void;
  // 换设备 / 清缓存后，从之前导出的图纸文件恢复。
  onImportProject?: () => void;
};

const STEPS = [
  { title: "像素化", body: "按拼豆板针数把图片分成格子，每格取一个颜色，边缘不会混出脏色。" },
  { title: "匹配色号", body: "用感知色差逐格匹配到你手上的 MARD 套装，并清理零散杂豆。" },
  { title: "编辑与导出", body: "逐格修改、制作打卡，导出带坐标的高清图纸、分板 PDF 和采购清单。" }
];

/** 还没有任何图纸时的首屏：只突出“上传”，并让用户先确认拼豆板和色卡套装。 */
export function WelcomeScreen({ onFiles, isProcessing, boardPins, onBoardPinsChange, kits, kitId, onKitChange, onImportProject }: WelcomeScreenProps) {
  const pinOptions = BOARD_PIN_OPTIONS.some((option) => option.pins === boardPins)
    ? BOARD_PIN_OPTIONS
    : [...BOARD_PIN_OPTIONS, { pins: boardPins, label: `${boardPins} 针`, hint: "自定义" }];
  return (
    <main className="welcome" id="main">
      <div className="welcome-intro">
        <p className="eyebrow">Image → Bead Pattern</p>
        <h2 className="welcome-title">把一张图，变成能直接照着拼的拼豆图纸</h2>
        <p className="welcome-copy">上传角色原图或照片，自动生成带色号、坐标和用豆数量的图纸。每张图可以单独调整尺寸和颜色。</p>
      </div>

      <div className="welcome-upload">
        <UploadPanel onFiles={onFiles} isProcessing={isProcessing} variant="hero" />
        <div className="welcome-prefs" aria-label="生成前的偏好">
          <div className="welcome-pref">
            <span>我的拼豆板</span>
            <Segmented
              label="单块拼豆板针数"
              size="compact"
              value={boardPins}
              options={pinOptions.map((option) => ({ value: option.pins, label: option.label, title: option.hint }))}
              onChange={onBoardPinsChange}
            />
          </div>
          <label className="welcome-pref">
            <span>我的色卡套装</span>
            <select aria-label="色卡套装" value={kitId} onChange={(event) => onKitChange(event.target.value)}>
              {kits.map((kit) => <option key={kit.id} value={kit.id}>{kit.name}</option>)}
            </select>
          </label>
          {onImportProject && (
            <p className="welcome-import">
              换了设备或清过浏览器？
              <button type="button" className="link-button" onClick={onImportProject}>导入之前导出的图纸文件</button>
            </p>
          )}
        </div>
      </div>

      <ol className="welcome-steps">
        {STEPS.map((step, index) => (
          <li key={step.title} style={{ animationDelay: `${120 + index * 80}ms` }}>
            <span className="welcome-step-index">{index + 1}</span>
            <strong>{step.title}</strong>
            <p>{step.body}</p>
          </li>
        ))}
      </ol>
    </main>
  );
}
