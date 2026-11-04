import { useState } from "react";
import { parseLegendText } from "../../lib/recognize/legend";
import { ALL_CODES } from "../../lib/palette";
import { saveImage } from "../../lib/images";
import type { Counts } from "../../lib/model";
import { navigate, toast } from "../ui";
import CountsEditor from "./CountsEditor";
import ImageDrop from "./ImageDrop";
import SaveForm, { type SaveValues } from "./SaveForm";
import { createPattern } from "./save";

const VALID = new Set(ALL_CODES);

export default function ManualPanel() {
  const [counts, setCounts] = useState<Counts>({});
  const [text, setText] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");

  const parse = () => {
    const reading = parseLegendText(text, VALID);
    if (!reading.items.length) { setNote("没有解析出色号。格式示例：A1 120, H7×300"); return; }
    const next = { ...counts };
    for (const [code, n] of Object.entries(reading.counts)) next[code] = (next[code] ?? 0) + n;
    setCounts(next); setText("");
    setNote(`已加入 ${reading.items.length} 个色号`);
  };

  const save = async (values: SaveValues) => {
    setSaving(true);
    try {
      const meta = image ? await saveImage(image, image.name, "source") : null;
      const p = await createPattern(values, { kind: "manual", method: "manual", counts, imageId: meta?.id, confidence: 1 });
      toast("已保存到图库");
      navigate(`/pattern/${p.id}`);
    } catch (e) { toast(e instanceof Error ? e.message : "保存失败"); setSaving(false); }
  };

  return (
    <div className="ap-grid">
      <section className="stack">
        <div className="panel panel-pad stack">
          <label className="field"><span>粘贴用量文字</span>
            <textarea className="textarea code" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={"A1 120, H7×300\nB12: 45"} />
          </label>
          <div className="row"><button className="btn btn-sm" onClick={parse} disabled={!text.trim()}>解析并加入</button>{note ? <span className="meta" role="status">{note}</span> : null}</div>
        </div>
        <div className="panel panel-pad stack">
          <b>参考图（可选）</b>
          {image ? <div className="row"><span className="meta">{image.name}</span><button className="btn btn-sm btn-ghost" onClick={() => setImage(null)}>移除</button></div> : <ImageDrop compact title="添加一张图" onFile={setImage} />}
        </div>
      </section>
      <section className="stack">
        <div className="panel"><div className="panel-head"><h3>用量</h3></div><CountsEditor counts={counts} onChange={setCounts} /></div>
        <div className="panel panel-pad"><SaveForm defaultName="" busy={saving} disabled={!Object.keys(counts).length} onSave={save} /></div>
      </section>
    </div>
  );
}
