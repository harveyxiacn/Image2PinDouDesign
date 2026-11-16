import { afterEach, describe, expect, it } from "vitest";
import {
  manifestProblems,
  sanitiseEntryName,
  selectAssets,
  WANTED_KEYS,
  DATA_VERSION
} from "../../scripts/copy-bg-assets.mjs";
import {
  isLocalModelManifest,
  localModelKnown,
  probeLocalModel,
  resetLocalModelProbe,
  resolveLocalPublicPath
} from "../domain/bgAssets";

const h = (n: number) => n.toString(16).padStart(64, "0");
const chunk = (n: number, a: number, b: number) => ({ hash: h(n), name: h(n), offsets: [a, b] });
const resources = {
  "/models/isnet_fp16": { size: 30, mime: "x", chunks: [chunk(1, 0, 20), chunk(2, 20, 30)] },
  "/models/isnet": { size: 10, mime: "x", chunks: [chunk(9, 0, 10)] },
  "/onnxruntime-web/ort-wasm-simd-threaded.wasm": { size: 20, mime: "application/wasm", chunks: [chunk(3, 0, 20)] },
  "/onnxruntime-web/ort-wasm-simd-threaded.mjs": { size: 5, mime: "text/javascript", chunks: [chunk(4, 0, 5)] },
  "/onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm": { size: 7, mime: "application/wasm", chunks: [chunk(5, 0, 7)] }
};

describe("selectAssets", () => {
  it("keeps only the requested keys and their chunks", () => {
    const picked = selectAssets(resources);
    expect(Object.keys(picked.resources).sort()).toEqual([...WANTED_KEYS].sort());
    expect(picked.chunks).toEqual([h(1), h(2), h(3), h(4)]);
  });
  it("rejects a missing key, odd chunk names and inconsistent sizes", () => {
    expect(() => selectAssets({})).toThrow(/缺少/);
    const bad = { ...resources, "/models/isnet_fp16": { size: 30, chunks: [{ hash: "../x", name: "../x", offsets: [0, 30] }] } };
    expect(() => selectAssets(bad)).toThrow(/块名/);
    const wrongSize = { ...resources, "/models/isnet_fp16": { size: 31, chunks: [chunk(1, 0, 30)] } };
    expect(() => selectAssets(wrongSize)).toThrow(/size/);
  });
});

describe("sanitiseEntryName", () => {
  it("strips the package/ prefix and accepts plain relative names", () => {
    expect(sanitiseEntryName("package/dist/resources.json")).toBe("dist/resources.json");
    expect(sanitiseEntryName("package/LICENSE.md")).toBe("LICENSE.md");
  });
  it("rejects traversal, absolute, drive-letter, backslash and NUL names", () => {
    for (const bad of ["../x", "package/../../x", "/etc/passwd", "C:/x", "a\\b", "a\0b", "", "package/", "./"]) {
      expect(sanitiseEntryName(bad)).toBeNull();
    }
  });
});

describe("manifestProblems", () => {
  const manifest = {
    format: 1, version: DATA_VERSION, model: "isnet_fp16",
    files: [{ name: "resources.json", size: 3, sha256: "aa" }, { name: h(1), size: 4, sha256: "bb" }]
  };
  const actual = { "resources.json": { size: 3, sha256: "aa" }, [h(1)]: { size: 4, sha256: "bb" } };
  it("is empty for a complete set", () => expect(manifestProblems(manifest, actual)).toEqual([]));
  it("reports missing, resized and altered files", () => {
    expect(manifestProblems(manifest, { "resources.json": actual["resources.json"] })).toHaveLength(1);
    expect(manifestProblems(manifest, { ...actual, [h(1)]: { size: 5, sha256: "bb" } })[0]).toMatch(/大小/);
    expect(manifestProblems(manifest, { ...actual, [h(1)]: { size: 4, sha256: "cc" } })[0]).toMatch(/哈希/);
  });
  it("rejects a wrong version, format or path-like names", () => {
    expect(manifestProblems({ ...manifest, version: "9.9.9" }, actual)).toHaveLength(1);
    expect(manifestProblems(null, actual)).toHaveLength(1);
    expect(manifestProblems({ ...manifest, files: [...manifest.files, { name: "../x", size: 1, sha256: "d" }] }, actual).join()).toMatch(/非法/);
  });
});

describe("local model path", () => {
  afterEach(resetLocalModelProbe);
  it("resolves against origin and Vite base, always ending in a slash", () => {
    expect(resolveLocalPublicPath("http://127.0.0.1:4319/", "/")).toBe("http://127.0.0.1:4319/bg-model/");
    expect(resolveLocalPublicPath("https://a.test/app/index.html", "/app")).toBe("https://a.test/app/bg-model/");
    expect(resolveLocalPublicPath("https://a.test/app/", "./")).toBe("https://a.test/app/bg-model/");
  });
  it("accepts only the manifest written by the script", () => {
    const good = { format: 1, model: "isnet_fp16", files: [{ name: "resources.json" }] };
    expect(isLocalModelManifest(good)).toBe(true);
    expect(isLocalModelManifest("<!doctype html>")).toBe(false);
    expect(isLocalModelManifest({ ...good, format: 2 })).toBe(false);
    expect(isLocalModelManifest(null)).toBe(false);
  });
  it("probes once and caches the result", async () => {
    let calls = 0;
    const ok = (async () => { calls += 1; return new Response(JSON.stringify({ format: 1, model: "isnet_fp16", files: [{ name: "resources.json" }] })); }) as unknown as typeof fetch;
    expect(localModelKnown()).toBeNull();
    expect(await probeLocalModel(ok, "http://x.test/", "/")).toBe("http://x.test/bg-model/");
    expect(await probeLocalModel(ok, "http://x.test/", "/")).toBe("http://x.test/bg-model/");
    expect(calls).toBe(1);
    expect(localModelKnown()).toBe(true);
  });
  it("returns null for an HTML fallback, an error status or a network failure", async () => {
    const html = (async () => new Response("<html></html>")) as unknown as typeof fetch;
    expect(await probeLocalModel(html, "http://x.test/", "/")).toBeNull();
    resetLocalModelProbe();
    const notFound = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await probeLocalModel(notFound, "http://x.test/", "/")).toBeNull();
    resetLocalModelProbe();
    const down = (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
    expect(await probeLocalModel(down, "http://x.test/", "/")).toBeNull();
    expect(localModelKnown()).toBe(false);
  });
});
