// dsh-theme-manager — host 半边离线回归（真实 HTTP，不依赖 cordis / 不重启应用）
//
//   DSH_HOME=/tmp/dsh-theme-test/home node tests/host-api-test.mjs
//
// 覆盖：状态读写与持久化 / 参数归一化与钳制 / 媒体流与 Range(206/416) /
//      扩展名白名单（.txt 必须 415）/ 未知路由 404 / CORS 预检。
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const HOME = process.env.DSH_THEME_TEST_HOME ?? "/tmp/dsh-theme-test/home";
process.env.DSH_HOME = HOME;
const MEDIA = process.env.DSH_THEME_TEST_MEDIA ?? "/tmp/dsh-theme-test";

const mod = await import(`../lib/index.js?t=${Date.now()}`);
const server = await mod.__createTestServer();
const base = server.url;

let pass = 0;
let fail = 0;
const checks = [];
function ok(name, cond, detail) {
	if (cond) {
		pass += 1;
		checks.push(`  ✓ ${name}`);
	} else {
		fail += 1;
		checks.push(`  ✗ ${name}${detail === undefined ? "" : ` — ${detail}`}`);
	}
}

const j = async (method, url, body, headers) => {
	const res = await fetch(base + url, {
		method,
		headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(headers ?? {}) },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const text = await res.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = text;
	}
	return { status: res.status, headers: res.headers, body: parsed };
};

// 干净起点
const stateFile = path.join(HOME, "state", "theme-manager", "background.json");
if (existsSync(stateFile)) rmSync(stateFile);

/* ① 探活与自描述 */
{
	const r = await j("GET", "/dsh-theme-manager/health");
	ok("GET /health → 200", r.status === 200, `status=${r.status}`);
	ok("health.ok = true", r.body?.ok === true);
	ok("health 自描述四个端点", Object.keys(r.body?.endpoints ?? {}).length === 5, JSON.stringify(Object.keys(r.body?.endpoints ?? {})));
	ok("health 带版本号", typeof r.body?.version === "string" && r.body.version.length > 0);
}

/* ② 初始状态 = none */
{
	const r = await j("GET", "/dsh-theme-manager/state");
	ok("GET /state → 200", r.status === 200);
	ok("初始 type = none", r.body?.background?.type === "none", r.body?.background?.type);
	ok("初始无 updatedAt", r.body?.background?.updatedAt === null);
	ok("初始毛玻璃遮罩默认打开（背景铺满后正文仍可读）", r.body?.background?.card?.enabled === true, JSON.stringify(r.body?.background?.card));
	ok("初始毛玻璃 blur = 20", r.body?.background?.card?.blur === 20, String(r.body?.background?.card?.blur));
}

/* ③ 设置本地图片（含未知字段与越界值） */
{
	const r = await j("POST", "/dsh-theme-manager/background", {
		type: "image",
		path: `${MEDIA}/pic.png`,
		opacity: "0.5",
		blur: 999,
		dim: -3,
		fit: "contain",
		coverage: "full",
		position: "TOP RIGHT",
		hacker: "drop-me",
		card: { enabled: true, alpha: 2 }
	});
	const bg = r.body?.background;
	ok("POST /background → 200", r.status === 200, JSON.stringify(r.body).slice(0, 160));
	ok("type = image", bg?.type === "image");
	ok("source.kind = path 且 value 保留绝对路径", bg?.source?.kind === "path" && bg?.source?.value === `${MEDIA}/pic.png`);
	ok('opacity "0.5" → 0.5（字符串数字也接受）', bg?.opacity === 0.5, String(bg?.opacity));
	ok("blur 999 → 钳到 60", bg?.blur === 60, String(bg?.blur));
	ok("dim -3 → 钳到 0", bg?.dim === 0, String(bg?.dim));
	ok("fit 白名单命中", bg?.fit === "contain");
	ok("coverage 保留在状态里", bg?.coverage === "full", bg?.coverage);
	ok("position 归一为小写", bg?.position === "top right", bg?.position);
	ok("未知字段被丢弃", bg?.hacker === undefined);
	ok("card.alpha 2 → 钳到 1", bg?.card?.alpha === 1, String(bg?.card?.alpha));
	ok("card.enabled = true", bg?.card?.enabled === true);
	ok("revision 递增到 1", bg?.revision === 1, String(bg?.revision));
	ok("updatedAt 是 ISO 时间", !Number.isNaN(Date.parse(bg?.updatedAt ?? "")), bg?.updatedAt);
}

/* ④ 状态落盘 + 新进程视角可读 */
{
	const raw = JSON.parse(readFileSync(stateFile, "utf8"));
	ok("状态文件已写入且 JSON 合法", raw.type === "image" && raw.source.value.endsWith("pic.png"));
	const mod2 = await import(`../lib/index.js?t=${Date.now() + 1}`);
	const store = mod2.__internal.stateIo();
	const loaded = await store.load();
	ok("重新加载状态与写入一致", loaded.type === "image" && loaded.blur === 60);
}

/* ⑤ 部分更新：只改 loop，其它字段不动 */
{
	const r = await j("POST", "/dsh-theme-manager/background", { loop: false, rate: 1.5 });
	const bg = r.body?.background;
	ok("部分更新保留 type/path", bg?.type === "image" && bg?.source?.value.endsWith("pic.png"));
	ok("部分更新改到 video.loop = false", bg?.video?.loop === false);
	ok("部分更新改到 video.rate = 1.5", bg?.video?.rate === 1.5, String(bg?.video?.rate));
	ok("未提及的 opacity 保持 0.5", bg?.opacity === 0.5, String(bg?.opacity));
}

/* ⑥ 媒体流：全量 + Range */
{
	const full = await fetch(`${base}/dsh-theme-manager/media`);
	const buf = Buffer.from(await full.arrayBuffer());
	const disk = readFileSync(`${MEDIA}/pic.png`);
	ok("GET /media → 200", full.status === 200);
	ok("Content-Type = image/png", full.headers.get("content-type") === "image/png", full.headers.get("content-type"));
	ok("Accept-Ranges = bytes", full.headers.get("accept-ranges") === "bytes");
	ok("字节与磁盘一致", buf.equals(disk), `${buf.length} vs ${disk.length}`);

	const part = await fetch(`${base}/dsh-theme-manager/media`, { headers: { Range: "bytes=2-5" } });
	ok("Range → 206", part.status === 206, String(part.status));
	ok("Content-Range 正确", part.headers.get("content-range") === `bytes 2-5/${disk.length}`, part.headers.get("content-range"));
	const slice = Buffer.from(await part.arrayBuffer());
	ok("Range 内容 = 磁盘切片", slice.equals(disk.subarray(2, 6)));

	const bad = await fetch(`${base}/dsh-theme-manager/media`, { headers: { Range: "bytes=99999-" } });
	ok("越界 Range → 416", bad.status === 416, String(bad.status));
	ok("416 带 Content-Range: bytes */size", bad.headers.get("content-range") === `bytes */${disk.length}`, bad.headers.get("content-range"));

	const head = await fetch(`${base}/dsh-theme-manager/media`, { method: "HEAD" });
	ok("HEAD /media → 200 且无 body", head.status === 200 && (await head.text()).length === 0);
}

/* ⑦ 视频改用 /asset 直取 + Content-Type 推断 */
{
	const r = await fetch(`${base}/dsh-theme-manager/asset?p=${encodeURIComponent(`${MEDIA}/clip.mp4`)}`, { headers: { Range: "bytes=0-1023" } });
	ok("GET /asset(.mp4) Range → 206", r.status === 206, String(r.status));
	ok("Content-Type = video/mp4", r.headers.get("content-type") === "video/mp4", r.headers.get("content-type"));
	const len = (await r.arrayBuffer()).byteLength;
	ok("返回 1024 字节", len === 1024, String(len));
}

/* ⑧ 白名单与路径校验 */
{
	const txt = await j("GET", `/dsh-theme-manager/asset?p=${encodeURIComponent(`${MEDIA}/notes.txt`)}`);
	ok(".txt → 415（不服务文本文件）", txt.status === 415, String(txt.status));
	const missing = await j("GET", `/dsh-theme-manager/asset?p=${encodeURIComponent(`${MEDIA}/nope.png`)}`);
	ok("不存在的文件 → 404", missing.status === 404, String(missing.status));
	const dir = await j("GET", `/dsh-theme-manager/asset?p=${encodeURIComponent(MEDIA)}`);
	ok("目录 → 404/415", dir.status === 404 || dir.status === 415, String(dir.status));
	const noParam = await j("GET", "/dsh-theme-manager/asset");
	ok("缺 p 参数 → 400", noParam.status === 400, String(noParam.status));
	const traversal = await j("GET", `/dsh-theme-manager/asset?p=${encodeURIComponent(`${MEDIA}/../dsh-theme-test/pic.png`)}`);
	ok("路径穿越被解析成合法路径后仍按扩展名判定（png 放行）", traversal.status === 200, String(traversal.status));
	const svg = await j("GET", `/dsh-theme-manager/asset?p=${encodeURIComponent("/tmp/dsh-theme-test/x.svg")}`);
	ok("svg → 415（拒绝同源 SVG 脚本面）", svg.status === 415, String(svg.status));
}

/* ⑨ 写入时对不存在的路径给 warning，但不失败 */
{
	const r = await j("POST", "/dsh-theme-manager/background", { type: "image", path: `${MEDIA}/ghost.png` });
	ok("路径不存在仍写入成功", r.status === 200 && r.body?.background?.source?.value.endsWith("ghost.png"));
	ok("附带 warning", Array.isArray(r.body?.warning) && r.body.warning.length === 1, JSON.stringify(r.body?.warning));
}

/* ⑩ 推断类型 + clear + 未知路由 + CORS 预检 */
{
	const r = await j("POST", "/dsh-theme-manager/background", { type: "image", path: `${MEDIA}/clip.mp4` });
	ok("声明类型与扩展名冲突时按扩展名纠正为 video", r.body?.background?.type === "video", r.body?.background?.type);

	const inferred = await j("POST", "/dsh-theme-manager/background", { path: `${MEDIA}/pic.png` });
	ok("只给 path 时自动推断出 image", inferred.body?.background?.type === "image", inferred.body?.background?.type);

	const badCoverage = await j("POST", "/dsh-theme-manager/background", { coverage: "nonsense" });
	ok("非法 coverage 被忽略（保留原值）", badCoverage.body?.background?.coverage === "full", badCoverage.body?.background?.coverage);

	const cleared = await j("POST", "/dsh-theme-manager/background/clear");
	ok("clear → type none", cleared.body?.background?.type === "none");
	ok("clear 后 /media → 404", (await j("GET", "/dsh-theme-manager/media")).status === 404);
	ok("clear 后 revision 继续递增", cleared.body?.background?.revision >= 6, String(cleared.body?.background?.revision));

	const unknown = await j("GET", "/dsh-theme-manager/nope");
	ok("未知路由 → 404", unknown.status === 404, String(unknown.status));

	const pre = await fetch(base + "/dsh-theme-manager/background", { method: "OPTIONS" });
	ok("OPTIONS 预检 → 204 + CORS 头", pre.status === 204 && pre.headers.get("access-control-allow-origin") === "*", String(pre.status));
	const one = await fetch(base + "/dsh-theme-manager/state");
	ok("响应带 Access-Control-Allow-Origin: *", one.headers.get("access-control-allow-origin") === "*");
}

/* ⑪ 坏 JSON / 超大 body */
{
	const bad = await fetch(base + "/dsh-theme-manager/background", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
	ok("坏 JSON → 400", bad.status === 400, String(bad.status));
	const big = await fetch(base + "/dsh-theme-manager/background", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(70000) }) });
	ok("超大 body → 413", big.status === 413, String(big.status));
}

/* ⑫ 尾部斜杠与 HEAD 探活 */
{
	ok("前缀根路径（带斜杠）→ 200", (await j("GET", "/dsh-theme-manager/")).status === 200);
	ok("HEAD /health → 200", (await fetch(base + "/dsh-theme-manager/health", { method: "HEAD" })).status === 200);
}

await server.close();

console.log(checks.join("\n"));
console.log(`\n dsh-theme-manager host 半边：${pass} 项通过 / ${fail} 项失败`);
if (fail > 0) process.exit(1);
