// 卖家资料管理：新增 / 复制 / 编辑 / 删除，选择当前卖家，隐藏或恢复内置默认卖家。
// 数据存在共享偏好里（prefs.sellers / sellerId / sellerDefaultHidden），保存时总是基于本机最新偏好改。
import { useState } from "react";
import { Sheet, toast } from "../ui";
import { getSnapshot, putRecords, useData } from "../../lib/db";
import { nextStamp } from "../../lib/purchase";
import {
  KNOWN_KIT_COLORS, MAX_KITS, MAX_PACKS, MAX_SELLERS, blankSeller, currentSeller, customSellers, duplicateSeller, listSellers,
  newSellerId, removeSeller, resetToDefaultSeller, selectSeller, setDefaultHidden, upsertSeller, validateSeller, type Seller, type SellerPatch
} from "../../lib/sellers";
import type { SharedPrefs } from "../../lib/model";
import "./sellers.css";

/** 基于本机此刻最新的偏好改卖家字段并保存（不用组件里可能过期的快照）。 */
export async function saveSellerPatch(make: (prefs: SharedPrefs) => SellerPatch): Promise<boolean> {
  try {
    const prefs = getSnapshot().prefs;
    const patch = make(prefs);
    const next: SharedPrefs = { ...prefs, ...patch, updatedAt: nextStamp(prefs.updatedAt) };
    for (const key of ["sellers", "sellerId", "sellerDefaultHidden", "sellersDeleted"] as const) if (patch[key] === undefined) delete next[key];
    await putRecords("prefs", [next]);
    return true;
  } catch {
    toast("卖家资料没保存成功，请重试");
    return false;
  }
}

export function sellerSummary(s: Seller): string {
  const packs = [...s.packs].sort((a, b) => b.beads - a.beads).map((p) => `${p.beads}颗¥${p.price}`).join(" / ");
  const kits = s.kits.length ? `套装 ${s.kits.map((k) => k.colors).join("/")} 色` : "无套装";
  const ship = s.shipping > 0 ? `运费¥${s.shipping}${s.freeShipping ? `，满¥${s.freeShipping}包邮` : ""}` : "包邮";
  return `${packs} · ${kits} · ${ship}`;
}

type PackDraft = { id: string; beads: string; price: string; minPacks: string; am: boolean };
type KitDraft = { id: string; colors: string; price: string };
type Draft = { id: string; name: string; note: string; packs: PackDraft[]; kits: KitDraft[]; shipping: string; free: string; isNew: boolean };

function toDraft(s: Seller, isNew: boolean): Draft {
  return {
    id: s.id, name: s.name, note: s.note ?? "", isNew,
    packs: s.packs.map((p) => ({ id: p.id, beads: String(p.beads), price: String(p.price), minPacks: p.minPacks ? String(p.minPacks) : "", am: p.scope === "A-M" })),
    kits: s.kits.map((k) => ({ id: k.id, colors: String(k.colors), price: String(k.price) })),
    shipping: s.shipping ? String(s.shipping) : "", free: s.freeShipping ? String(s.freeShipping) : ""
  };
}

function fromDraft(d: Draft): Seller {
  const used = new Set<string>();
  const uniq = (id: string, fallback: string) => { let v = id || fallback; while (used.has(v)) v += "x"; used.add(v); return v; };
  const n = (v: string) => (v.trim() === "" ? NaN : Number(v));
  return {
    id: d.id, name: d.name.trim(), ...(d.note.trim() ? { note: d.note.trim() } : {}),
    packs: d.packs.map((p) => ({
      id: uniq(p.id, `p${p.beads}`), beads: Math.round(n(p.beads)), price: n(p.price),
      ...(n(p.minPacks) > 1 ? { minPacks: Math.round(n(p.minPacks)) } : {}), ...(p.am ? { scope: "A-M" as const } : {})
    })),
    kits: d.kits.map((k, i) => ({ id: k.id || `k${i + 1}`, colors: Math.round(n(k.colors)), price: n(k.price) })),
    shipping: d.shipping.trim() === "" ? 0 : n(d.shipping),
    ...(d.free.trim() !== "" ? { freeShipping: n(d.free) } : {})
  };
}

function Editor({ draft, onChange, onBack, onSave, saving }: { draft: Draft; onChange: (d: Draft) => void; onBack: () => void; onSave: () => void; saving: boolean }) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const setPack = (i: number, patch: Partial<PackDraft>) => set({ packs: draft.packs.map((p, k) => (k === i ? { ...p, ...patch } : p)) });
  const setKit = (i: number, patch: Partial<KitDraft>) => set({ kits: draft.kits.map((p, k) => (k === i ? { ...p, ...patch } : p)) });
  return (
    <Sheet title={draft.isNew ? "新增卖家" : "编辑卖家"} onClose={onBack} footer={
      <>
        <button type="button" className="btn" onClick={onBack}>取消</button>
        <button type="button" className="btn btn-iron" disabled={saving} onClick={onSave} data-seller-save>保存</button>
      </>
    }>
      <div className="stack seller-form" data-seller-form>
        <label className="field"><span>卖家名称</span>
          <input className="input" value={draft.name} maxLength={30} onChange={(e) => set({ name: e.target.value })} placeholder="例如：某某旗舰店" data-seller-field="name" />
        </label>
        <label className="field"><span>备注或链接（选填）</span>
          <input className="input" value={draft.note} maxLength={200} onChange={(e) => set({ note: e.target.value })} placeholder="店铺链接、联系方式、下单注意事项" data-seller-field="note" />
        </label>

        <fieldset className="seller-block">
          <legend>单色补充包</legend>
          {draft.packs.map((p, i) => (
            <div className="seller-line" key={i} data-seller-pack={i}>
              <label className="field"><span>颗数</span><input className="input num" inputMode="numeric" value={p.beads} onChange={(e) => setPack(i, { beads: e.target.value })} aria-label={`第 ${i + 1} 种包的颗数`} /></label>
              <label className="field"><span>价格（元）</span><input className="input num" inputMode="decimal" value={p.price} onChange={(e) => setPack(i, { price: e.target.value })} aria-label={`第 ${i + 1} 种包的价格`} /></label>
              <label className="field"><span>最少包数</span><input className="input num" inputMode="numeric" value={p.minPacks} placeholder="不限" onChange={(e) => setPack(i, { minPacks: e.target.value })} aria-label={`第 ${i + 1} 种包整单最少包数`} /></label>
              <label className="seller-check"><input type="checkbox" checked={p.am} onChange={(e) => setPack(i, { am: e.target.checked })} />仅 A–M</label>
              <button type="button" className="btn btn-ghost seller-x" aria-label={`删除第 ${i + 1} 种包`} disabled={draft.packs.length <= 1} onClick={() => set({ packs: draft.packs.filter((_, k) => k !== i) })}>删除</button>
            </div>
          ))}
          <button type="button" className="btn" disabled={draft.packs.length >= MAX_PACKS} onClick={() => set({ packs: [...draft.packs, { id: "", beads: "", price: "", minPacks: "", am: false }] })} data-seller-add-pack>添加一种包</button>
          <p className="meta">最少包数：这种包整单要买够多少包才能备注色号，不够时方案会自动补满或改用别的包。</p>
        </fieldset>

        <fieldset className="seller-block">
          <legend>套装（选填）</legend>
          {draft.kits.map((k, i) => (
            <div className="seller-line" key={i} data-seller-kit={i}>
              <label className="field"><span>色数</span>
                <select className="select" value={k.colors} onChange={(e) => setKit(i, { colors: e.target.value })} aria-label={`第 ${i + 1} 个套装的色数`}>
                  {KNOWN_KIT_COLORS.map((c) => <option key={c} value={c}>{c} 色</option>)}
                  {!KNOWN_KIT_COLORS.some((c) => String(c) === k.colors) && k.colors ? <option value={k.colors}>{k.colors} 色</option> : null}
                </select>
              </label>
              <label className="field"><span>价格（元）</span><input className="input num" inputMode="decimal" value={k.price} onChange={(e) => setKit(i, { price: e.target.value })} aria-label={`第 ${i + 1} 个套装的价格`} /></label>
              <button type="button" className="btn btn-ghost seller-x" aria-label={`删除第 ${i + 1} 个套装`} onClick={() => set({ kits: draft.kits.filter((_, k2) => k2 !== i) })}>删除</button>
            </div>
          ))}
          <button type="button" className="btn" disabled={draft.kits.length >= MAX_KITS} onClick={() => set({ kits: [...draft.kits, { id: "", colors: String(KNOWN_KIT_COLORS[0]), price: "" }] })} data-seller-add-kit>添加套装</button>
          <p className="meta">套装每色 1200 颗，色号按 MARD 对应。</p>
        </fieldset>

        <fieldset className="seller-block">
          <legend>运费</legend>
          <div className="seller-line">
            <label className="field"><span>运费（元，包邮留空）</span><input className="input num" inputMode="decimal" value={draft.shipping} onChange={(e) => set({ shipping: e.target.value })} data-seller-field="shipping" /></label>
            <label className="field"><span>满多少元包邮（选填）</span><input className="input num" inputMode="decimal" value={draft.free} onChange={(e) => set({ free: e.target.value })} data-seller-field="free" /></label>
          </div>
        </fieldset>
      </div>
    </Sheet>
  );
}

export function SellerSheet({ onClose }: { onClose: () => void }) {
  const data = useData();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const prefs = data.prefs;
  const sellers = listSellers(prefs);
  const current = currentSeller(prefs);
  const customs = customSellers(prefs);
  const hidden = !!prefs.sellerDefaultHidden && customs.length > 0;

  const save = async () => {
    if (!draft) return;
    const seller = fromDraft(draft);
    const problem = validateSeller(seller);
    if (problem) { toast(problem); return; }
    setSaving(true);
    const ok = await saveSellerPatch((p) => upsertSeller(p, seller, Date.now(), draft.isNew));
    setSaving(false);
    if (ok) { setDraft(null); toast(draft.isNew ? "已添加卖家" : "已保存"); }
  };
  const full = customs.length >= MAX_SELLERS;
  const startNew = () => setDraft(toDraft(blankSeller(newSellerId()), true));
  const copy = async (s: Seller) => {
    if (full) { toast(`最多保存 ${MAX_SELLERS} 个卖家`); return; }
    const dup = duplicateSeller(s, newSellerId());
    if (await saveSellerPatch((p) => upsertSeller(p, dup, Date.now(), false))) { toast("已复制，可以点编辑修改"); }
  };

  if (draft) return <Editor draft={draft} onChange={setDraft} onBack={() => setDraft(null)} onSave={save} saving={saving} />;
  return (
    <Sheet title="卖家资料" onClose={onClose} footer={<button type="button" className="btn btn-iron" onClick={onClose}>完成</button>}>
      <div className="stack seller-sheet" data-seller-sheet>
        <p className="meta">不同卖家的包规格、价格、套装和运费不一样。选一个卖家，采购方案就按他的报价算；下面的对比会列出每个卖家买这份清单要多少钱。资料会随偏好同步到其他设备；两台设备同时改，后保存的那份生效。</p>
        <ul className="seller-list" aria-label="卖家列表">
          {sellers.map((s) => (
            <li className="panel seller-row" key={s.id} data-seller-row={s.id} data-current={s.id === current.id}>
              <div className="seller-head">
                <b>{s.name}</b>
                {s.id === current.id ? <span className="chip chip-leaf">当前</span> : null}
                {s.builtin ? <span className="chip">内置</span> : null}
              </div>
              <p className="meta seller-sum">{sellerSummary(s)}</p>
              {s.note ? <p className="meta seller-note">{s.note}</p> : null}
              <div className="row seller-actions">
                {s.id !== current.id ? <button type="button" className="btn" onClick={() => void saveSellerPatch((p) => selectSeller(p, s.id))} data-seller-use={s.id}>使用</button> : null}
                {!s.builtin ? <button type="button" className="btn" onClick={() => setDraft(toDraft(s, false))} data-seller-edit={s.id}>编辑</button> : null}
                <button type="button" className="btn" onClick={() => void copy(s)} data-seller-dup={s.id}>复制</button>
                {s.builtin && customs.length ? <button type="button" className="btn" onClick={() => void saveSellerPatch((p) => setDefaultHidden(p, true))} data-seller-hide>隐藏</button> : null}
                {!s.builtin ? (
                  confirmDel === s.id
                    ? <button type="button" className="btn btn-iron" onClick={() => { setConfirmDel(null); void saveSellerPatch((p) => removeSeller(p, s.id)); }} data-seller-del-confirm={s.id}>确认删除</button>
                    : <button type="button" className="btn" onClick={() => setConfirmDel(s.id)} data-seller-del={s.id}>删除</button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        {hidden ? (
          <div className="row seller-hidden">
            <span className="meta">内置的“默认报价”已隐藏。</span>
            <button type="button" className="btn" onClick={() => void saveSellerPatch((p) => resetToDefaultSeller(p))} data-seller-reset>恢复并使用默认报价</button>
          </div>
        ) : null}
        <button type="button" className="btn btn-iron" disabled={full} onClick={startNew} data-seller-add>新增卖家</button>
        {full ? <p className="meta">最多保存 {MAX_SELLERS} 个卖家。</p> : null}
      </div>
    </Sheet>
  );
}
