// cap add/sync 之后的小修补：允许访问局域网 http Hub（明文流量）、相机/相册选择图片、应用名与图标颜色。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = path.join(root, "android", "app", "src", "main", "AndroidManifest.xml");
if (!existsSync(manifest)) { console.error("缺少 AndroidManifest.xml，先运行 cap add android"); process.exit(1); }
let xml = readFileSync(manifest, "utf8");
if (!xml.includes("android:usesCleartextTraffic")) {
  xml = xml.replace("<application", '<application\n        android:usesCleartextTraffic="true"\n        android:networkSecurityConfig="@xml/network_security_config"');
}
for (const perm of ["android.permission.INTERNET", "android.permission.ACCESS_NETWORK_STATE", "android.permission.ACCESS_WIFI_STATE"]) {
  if (!xml.includes(perm)) xml = xml.replace("</manifest>", `    <uses-permission android:name="${perm}" />\n</manifest>`);
}
writeFileSync(manifest, xml);

const xmlDir = path.join(root, "android", "app", "src", "main", "res", "xml");
mkdirSync(xmlDir, { recursive: true });
writeFileSync(path.join(xmlDir, "network_security_config.xml"), `<?xml version="1.0" encoding="utf-8"?>
<!-- 拼豆仓只和家里局域网的 Hub 通信（http），不访问公网服务。 -->
<network-security-config>
    <base-config cleartextTrafficPermitted="true" />
</network-security-config>
`);
console.log("[patch-android] manifest + network security config updated");
