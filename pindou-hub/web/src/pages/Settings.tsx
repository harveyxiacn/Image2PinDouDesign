// 焦点：局域网同步——Hub 电脑上是大号配对码 + 二维码，手机上是配对表单；其下是偏好、数据备份、外观。
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Icon, fmt, fmtTime, toast } from "../components/ui";
import { exportRecords, putRecords, saveDevice, useData } from "../lib/db";
import { hubInfo, localPairInfo, pairWithHub, syncNow, unpair, useSyncState } from "../lib/sync";
import { PALETTE_KITS } from "../lib/palette";
import type { CollectionName } from "../lib/model";
import { parseBackup } from "../lib/stockview";
import { downloadText } from "../components/stock/download";
import { readTheme, saveTheme, type ThemePref } from "../components/stock/theme";
import "./Settings.css";

type Info = Awaited<ReturnType<typeof hubInfo>>;
type Local = Awaited<ReturnType<typeof localPairInfo>>;

export default function Settings() {
  const data = useData();
  const sync = useSyncState();
  const [local, setLocal] = useState<Local>(null);
  const [info, setInfo] = useState<Info>(null);
  const [qr, setQr] = useState("");
  const paired = Boolean(data.device.hubUrl && data.device.token);

  useEffect(() => { void localPairInfo().then(setLocal); }, []);
  useEffect(() => {
    if (!paired) { setInfo(null); return; }
    let alive = true;
    void hubInfo().then((i) => { if (alive) setInfo(i); });
    return () => { alive = false; };
  }, [paired, sync.lastSyncAt]);
  const hubUrl = local?.addresses?.[0]?.url ?? "";
  useEffect(() => {
    if (!hubUrl) { setQr(""); return; }
    let alive = true;
    QRCode.toDataURL(hubUrl, { margin: 1, width: 296 }).then((u) => { if (alive) setQr(u); }).catch(() => setQr(""));
    return () => { alive = false; };
  }, [hubUrl]);

  return (
    <div>
      <div className="page-head"><div><h1>同步与设置</h1><p>数据默认只存在每台设备自己里；在同一个 Wi-Fi 下连上电脑 Hub，设备之间就会自动合并。</p></div></div>
      <SyncSection local={local} info={info} qr={qr} paired={paired} />
      <PrefsSection />
      <DataSection />
      <ThemeSection />
    </div>
  );
}

function SyncSection({ local, info, qr, paired }: { local: Local; info: Info; qr: string; paired: boolean }) {
  const data = useData();
  const sync = useSyncState();
  const [addr, setAddr] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [name, setName] = useState(data.device.deviceName);

  const pair = async () => {
    setBusy(true); setErr("");
    try { const hub = await pairWithHub(addr, code); toast(`已连接 ${hub}`); setCode(""); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <section className="set-sec">
      <h3>局域网同步</h3>
      {local ? (
        <div className="panel set-hub pegboard">
          {qr ? <img className="set-qr" src={qr} alt="Hub 地址二维码" width={148} height={148} /> : null}
          <div className="stack" style={{ gap: 8 }}>
            <strong>这台电脑就是 Hub</strong>
            <div><div className="label">配对码</div><div className="set-pair" aria-label={`配对码 ${local.pairCode.split("").join(" ")}`}>{local.pairCode}</div></div>
            <div className="meta">手机打开下面的地址（或扫码），输入配对码：</div>
            <div>{local.addresses.map((a) => <code key={a.url} className="code set-addr">{a.url} <span className="meta">{a.name}</span></code>)}</div>
          </div>
        </div>
      ) : !paired ? (
        <div className="panel panel-pad stack">
          <p className="meta">在电脑上打开拼豆仓 Hub，页面上会显示地址和 6 位配对码。手机和电脑需连着同一个 Wi-Fi。</p>
          <form className="set-form" onSubmit={(e) => { e.preventDefault(); void pair(); }}>
            <label className="field"><span>Hub 地址</span><input className="input" inputMode="url" autoCapitalize="off" placeholder="192.168.1.20:8787" value={addr} onChange={(e) => setAddr(e.target.value)} /></label>
            <label className="field"><span>配对码</span><input className="input code" inputMode="numeric" maxLength={6} placeholder="6 位数字" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></label>
            <button className="btn btn-iron" type="submit" disabled={busy || !addr.trim() || code.length !== 6}>{busy ? "连接中…" : "配对"}</button>
          </form>
          {err ? <div className="notice iron" role="alert">{err}</div> : null}
        </div>
      ) : null}

      {paired ? (
        <div className="panel panel-pad stack" style={{ marginTop: local ? 12 : 0 }}>
          <div className="set-kv">
            <span>已连接</span><span className="row"><span className={`sync-dot ${sync.phase}`} />{sync.hubName || info?.name || data.device.hubUrl}{sync.phase === "error" || sync.phase === "offline" ? <span className="chip chip-iron">{sync.message || sync.phase}</span> : null}</span>
            <span>地址</span><span className="code">{data.device.hubUrl}</span>
            <span>上次同步</span><span>{fmtTime(sync.lastSyncAt || data.device.lastSyncAt)}</span>
            <span>待上传</span><span className="num">{data.outbox} 条</span>
          </div>
          <div className="row">
            <button className="btn btn-primary" disabled={sync.phase === "syncing"} onClick={() => void syncNow()}><Icon name="sync" />{sync.phase === "syncing" ? "同步中…" : "立即同步"}</button>
            {!local ? <button className="btn" onClick={() => { if (window.confirm("断开后数据仍保留在本机，只是不再同步。确定断开？")) void unpair(); }}>断开</button> : null}
            <label className="row" style={{ marginLeft: 8, minHeight: 36 }}><input type="checkbox" checked={data.device.autoSync} onChange={(e) => void saveDevice({ autoSync: e.target.checked })} style={{ width: 18, height: 18, accentColor: "var(--iron)" }} />自动同步</label>
          </div>
        </div>
      ) : null}

      <div className="panel panel-pad stack" style={{ marginTop: 12 }}>
        <div className="set-kv">
          <span>本设备名称</span>
          <span className="row"><input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="设备名称" style={{ flex: 1, minWidth: 120 }} /><button className="btn btn-sm" disabled={!name.trim() || name === data.device.deviceName} onClick={() => void saveDevice({ deviceName: name.trim() }).then(() => toast("已保存设备名称"))}>保存</button></span>
          {info ? (
            <>
              <span>已见设备</span><span>{info.stats.devices.length ? info.stats.devices.map((d) => `${d.name}（${fmtTime(d.lastSeen)}）`).join("、") : "—"}</span>
              <span>本地识图 AI</span>
              <span>{info.ai.available ? <span className="chip chip-leaf">可用 · {info.ai.model}</span> : <span className="chip chip-amber">未启用</span>}
                {!info.ai.available ? <span className="meta" style={{ display: "block", marginTop: 4 }}>{info.ai.reason ? `${info.ai.reason}。` : ""}在 Hub 电脑安装 Ollama，运行 <code className="code">ollama pull qwen2.5vl:7b</code> 即可。</span> : null}</span>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function PrefsSection() {
  const { prefs } = useData();
  const [low, setLow] = useState(String(prefs.lowStock));
  const [pack, setPack] = useState(String(prefs.packSize));
  const [loss, setLoss] = useState(String(Math.round(prefs.lossRate * 1000) / 10));
  const [kit, setKit] = useState(prefs.kitId);
  const save = async () => {
    await putRecords("prefs", [{
      ...prefs, lowStock: Math.max(0, Math.round(Number(low)) || 0), packSize: Math.max(1, Math.round(Number(pack)) || 1),
      lossRate: Math.max(0, Number(loss) || 0) / 100, kitId: kit, updatedAt: Date.now()
    }]);
    toast("偏好已保存");
  };
  return (
    <section className="set-sec">
      <h3>偏好</h3>
      <div className="panel panel-pad stack">
        <div className="set-prefs">
          <label className="field"><span>低库存阈值（颗）</span><input className="input num" type="number" inputMode="numeric" min={0} value={low} onChange={(e) => setLow(e.target.value)} /></label>
          <label className="field"><span>包装规格（颗/包）</span><input className="input num" type="number" inputMode="numeric" min={1} value={pack} onChange={(e) => setPack(e.target.value)} /></label>
          <label className="field"><span>损耗率（%）</span><input className="input num" type="number" inputMode="decimal" min={0} value={loss} onChange={(e) => setLoss(e.target.value)} /></label>
          <label className="field"><span>默认色卡套装</span><select className="select" value={kit} onChange={(e) => setKit(e.target.value)}>{PALETTE_KITS.map((k) => <option key={k.id} value={k.id}>{k.name}（{k.codes.length} 色）</option>)}</select></label>
        </div>
        <div className="row"><button className="btn btn-primary" onClick={save}>保存偏好</button><span className="meta">偏好会随同步在所有设备间共享。</span></div>
      </div>
    </section>
  );
}

function DataSection() {
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void navigator.storage?.estimate?.().then((e) => { if (e.usage != null) setUsage({ used: e.usage, quota: e.quota ?? 0 }); }).catch(() => undefined);
  }, []);
  const mb = (n: number) => (n / 1048576 >= 10 ? Math.round(n / 1048576) : Math.round(n / 104857.6) / 10);

  const exportJson = useCallback(() => {
    const records = exportRecords();
    downloadText(`拼豆仓备份-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: "pindou-hub", exportedAt: Date.now(), records }), "application/json");
    toast(`已导出 ${records.length} 条记录（不含图片文件）`);
  }, []);
  const importJson = async (f: File) => {
    setBusy(true);
    try {
      const list = parseBackup(await f.text());
      if (!list) { toast("这不是拼豆仓的备份文件"); return; }
      const local = new Map(exportRecords().map((r) => [`${r.collection}/${r.id}`, r.updatedAt]));
      const by = new Map<CollectionName, Array<Record<string, unknown>>>();
      for (const r of list) {
        if (!["patterns", "txns", "images", "prefs"].includes(r.collection)) continue;
        if ((local.get(`${r.collection}/${r.id}`) ?? -1) >= r.updatedAt) continue;
        const rec = { ...(r.data as object), id: r.id, updatedAt: r.updatedAt, deleted: r.deleted || undefined };
        const arr = by.get(r.collection as CollectionName) ?? [];
        arr.push(rec); by.set(r.collection as CollectionName, arr);
      }
      let n = 0;
      for (const [collection, records] of by) { await putRecords(collection, records as never); n += records.length; }
      toast(n ? `已导入 ${n} 条较新的记录` : "备份里没有比本机更新的记录");
    } catch { toast("导入失败：文件无法解析"); }
    finally { setBusy(false); if (file.current) file.current.value = ""; }
  };
  return (
    <section className="set-sec">
      <h3>数据</h3>
      <div className="panel panel-pad stack">
        <p className="meta">备份包含图纸、库存记录和偏好；图纸图片文件需靠 Hub 同步。导入只收比本机更新的记录，不会覆盖你新改的内容。</p>
        <div className="row">
          <button className="btn" onClick={exportJson}><Icon name="download" />导出备份 JSON</button>
          <button className="btn" disabled={busy} onClick={() => file.current?.click()}><Icon name="upload" />导入备份</button>
          <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importJson(f); }} />
        </div>
        {usage ? <p className="meta">本机已用存储 <span className="num">{mb(usage.used)} MB</span>{usage.quota ? <>，浏览器配额约 <span className="num">{fmt(usage.quota / 1048576)} MB</span></> : null}</p> : null}
      </div>
    </section>
  );
}

function ThemeSection() {
  const [theme, setTheme] = useState<ThemePref>(readTheme());
  return (
    <section className="set-sec">
      <h3>外观</h3>
      <div className="panel panel-pad">
        <div className="seg" role="group" aria-label="外观">
          {([["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]] as const).map(([id, label]) => (
            <button key={id} aria-pressed={theme === id} onClick={() => { setTheme(id); saveTheme(id); }}>{label}</button>
          ))}
        </div>
      </div>
    </section>
  );
}
