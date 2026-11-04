// 焦点元素：图纸卡片网格——缩略图 + 库存可做程度，一眼看出哪张现在就能动手。
import { useMemo, useState } from "react";
import { useData } from "../lib/db";
import { stockByCode } from "../lib/inventory";
import { STATUS_LABEL, totalOf, type ImageMeta, type PatternStatus } from "../lib/model";
import { Icon, fmtTime, navigate, useBlobUrl, useRoute } from "../components/ui";
import PatternCard from "../components/pattern/PatternCard";
import "../components/pattern/pattern.css";
import "./Gallery.css";

type Sort = "updated" | "total";

function ImageTile({ img, patternId }: { img: ImageMeta; patternId?: string }) {
  const url = useBlobUrl(img.id);
  return (
    <div className="panel ga-tile">
      <div className={`pt-thumb${url ? "" : " ph pegboard"}`}>{url ? <img src={url} alt={img.name} loading="lazy" /> : <span>图片同步中…</span>}</div>
      <div className="row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div><div className="pt-card-title">{img.name}</div><div className="meta">{fmtTime(img.createdAt)} · {img.width}×{img.height}</div></div>
        <div className="row">
          {patternId ? <a className="btn btn-sm" href={`#/pattern/${patternId}`}>打开图纸</a> : null}
          <a className="btn btn-sm" href={`#/add?mode=recognize&image=${img.id}`}>识别</a>
          <a className="btn btn-sm" href={`#/add?mode=generate&image=${img.id}`}>生成</a>
        </div>
      </div>
    </div>
  );
}

export default function Gallery() {
  const route = useRoute();
  const data = useData();
  const tab = route.query.get("tab") === "images" ? "images" : "patterns";
  const [status, setStatus] = useState<PatternStatus | "all">("all");
  const [tag, setTag] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("updated");
  const stock = useMemo(() => stockByCode(data.txns), [data.txns]);

  const tags = useMemo(() => Array.from(new Set(data.patterns.flatMap((p) => p.tags))).sort(), [data.patterns]);
  const patterns = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.patterns
      .filter((p) => (status === "all" || p.status === status) && (!tag || p.tags.includes(tag)) && (!needle || p.name.toLowerCase().includes(needle) || p.tags.some((t) => t.toLowerCase().includes(needle))))
      .sort((a, b) => (sort === "total" ? totalOf(b.counts) - totalOf(a.counts) : b.updatedAt - a.updatedAt));
  }, [data.patterns, status, tag, q, sort]);
  const images = useMemo(() => data.images.filter((i) => i.role === "source"), [data.images]);
  const patternByImage = useMemo(() => new Map(data.patterns.filter((p) => p.imageId).map((p) => [p.imageId!, p.id])), [data.patterns]);

  return (
    <div>
      <div className="page-head">
        <div><h1>图库</h1><p>{data.patterns.length} 张图纸 · {images.length} 张图片</p></div>
        <div className="row">
          <div className="seg" role="group" aria-label="图库分类">
            <button aria-pressed={tab === "patterns"} onClick={() => navigate("/gallery")}>图纸</button>
            <button aria-pressed={tab === "images"} onClick={() => navigate("/gallery?tab=images")}>图片</button>
          </div>
          <a className="btn btn-iron" href="#/add"><Icon name="plus" />添加</a>
        </div>
      </div>

      {tab === "patterns" ? (
        data.patterns.length === 0 ? (
          <div className="empty pegboard ga-empty">
            <h3>图库还是空的</h3>
            <p>上传一张拼豆图纸，豆探会读出每个色号的用量；或者用照片生成一张。</p>
            <div className="row" style={{ justifyContent: "center" }}>
              <a className="btn btn-iron" href="#/add?mode=recognize"><Icon name="scan" />识别图纸</a>
              <a className="btn" href="#/add?mode=generate"><Icon name="wand" />生成图纸</a>
            </div>
          </div>
        ) : (
          <>
            <div className="ga-filters">
              <input className="input" type="search" placeholder="搜索名称或标签" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜索" />
              <select className="select" value={status} onChange={(e) => setStatus(e.target.value as PatternStatus | "all")} aria-label="状态">
                <option value="all">全部状态</option>
                {(Object.keys(STATUS_LABEL) as PatternStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
              {tags.length ? (
                <select className="select" value={tag} onChange={(e) => setTag(e.target.value)} aria-label="标签">
                  <option value="">全部标签</option>
                  {tags.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              ) : null}
              <select className="select" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="排序">
                <option value="updated">最近更新</option>
                <option value="total">用豆最多</option>
              </select>
            </div>
            {patterns.length ? (
              <div className="ga-grid">{patterns.map((p) => <PatternCard key={p.id} pattern={p} stock={stock} />)}</div>
            ) : <div className="empty"><h3>没有符合条件的图纸</h3><button className="btn btn-sm" onClick={() => { setQ(""); setStatus("all"); setTag(""); }}>清除筛选</button></div>}
          </>
        )
      ) : images.length ? (
        <div className="ga-grid">{images.map((img) => <ImageTile key={img.id} img={img} patternId={patternByImage.get(img.id)} />)}</div>
      ) : (
        <div className="empty pegboard ga-empty"><h3>还没有保存过图片</h3><p>保存图纸时会同时保留原图，之后可以在这里重新识别或生成。</p></div>
      )}
    </div>
  );
}
