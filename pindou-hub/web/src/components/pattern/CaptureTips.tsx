// 取图小贴士：怎么拿到更清楚的图纸。可折叠，记住上次的展开状态。
import { useState } from "react";
import { Icon } from "../ui";
import "./stitch.css";

const KEY = "pindou.tipsOpen";
const load = (): boolean => { try { return localStorage.getItem(KEY) !== "0"; } catch { return true; } };
const save = (v: boolean) => { try { localStorage.setItem(KEY, v ? "1" : "0"); } catch { /* 隐私模式：本次有效即可 */ } };

export function TipsList() {
  return (
    <ul className="st-tips-list">
      <li><b>在小红书里长按图片 → 保存图片</b>，比截屏清楚得多；能向作者要原图最好。</li>
      <li><b>不要截信息流里的缩略图</b>，先点开大图再保存或截。</li>
      <li><b>图纸很长怎么办：</b>放大后分段截，相邻两张<b>重叠约 1/4</b>，再用「多张截图拼接」合成一张。</li>
      <li>每张用同样的放大倍数，别把别的 App 的通知条截进来。</li>
    </ul>
  );
}

export default function CaptureTips() {
  const [open, setOpen] = useState(load);
  const toggle = () => setOpen((o) => { save(!o); return !o; });
  return (
    <div className="panel st-tips" data-testid="capture-tips" data-open={open}>
      <button type="button" className="st-tips-head pressable" aria-expanded={open} aria-controls="st-tips-body" onClick={toggle}>
        <Icon name="sparkle" size={16} /><b>怎样拿到更清楚的图纸</b>
        <span className="st-tips-chev" aria-hidden="true"><Icon name="chevron" size={16} /></span>
      </button>
      {open ? <div id="st-tips-body" className="st-tips-body"><TipsList /></div> : null}
    </div>
  );
}
