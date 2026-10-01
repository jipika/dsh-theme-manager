// dsh-theme-manager — host half（node 侧）
//
// 职责只有两件：
//   ① 持久化「页面背景」这类**必须读本机文件**的设置（图片 / 视频的绝对路径），
//      存成一份 JSON：$DSH_HOME/state/theme-manager/background.json
//   ② 把它暴露成一组**本机 HTTP 接口**，让两边的调用者用同一套契约：
//        · 页面半边（client.js）—— 用相对路径 fetch，例如 "/dsh-theme-manager/state"
//          （桌面外壳把 dsh-app://app/... 的请求转发给 host，见 dsh-desktop 的
//           forwardWebRequest；因此页面侧没有跨源、CSP、端口这些问题）
//        · 外部软件 —— 直接打 http://127.0.0.1:<webServer 端口>/dsh-theme-manager/...
//          （插件注册的 prefix 路由不在 host 的鉴权网关后面，curl 即可调用；
//           实测同一机制的 /dsh-preset-hotswap/list 返回 200）
//
// 路由（前缀 /dsh-theme-manager）：
//   GET  /health                探活 + 端点清单
//   GET  /state                 当前背景状态
//   POST /background            设置背景（支持部分字段更新）
//   POST /background/clear      恢复「无背景」
//   GET  /media                 当前背景所指向的媒体文件（支持 Range/206）
//   GET  /asset?p=<绝对路径>     任意本机媒体文件（同上，白名单扩展名）
//
// 媒体为什么要走 host：渲染进程读不到 file://（Electron 的 webRequest 会拦掉
// 非 about/data/blob 的协议），所以由 host 读文件、按流吐给页面。
//
// 安全边界：路由绑定的 webServer 只监听回环（127.0.0.1），且 /asset 只服务
// **媒体扩展名白名单**里的文件 —— 即使本机别的程序知道这个端点，也拿不到
// 文本类敏感文件（.env / .ssh / 配置等一律 415）。
export const name = "dsh-theme-manager";
export const inject = [];

const path = process.getBuiltinModule("node:path");
const os = process.getBuiltinModule("node:os");
const fs = process.getBuiltinModule("node:fs");
const fsp = process.getBuiltinModule("node:fs/promises");

const ROUTE = "/dsh-theme-manager";
const VERSION = "0.8.6";
const HOME =
	typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME !== ""
		? process.env.DSH_HOME
		: path.join(os.homedir(), ".dsh");
const STATE_DIR = path.join(HOME, "state", "theme-manager");
const STATE_FILE = path.join(STATE_DIR, "background.json");
/** 请求体上限：背景设置是小 JSON，给足余量但不做无上限缓冲。 */
const MAX_BODY = 64 * 1024;

/** 媒体扩展名白名单 → Content-Type。**不含 svg**：同源渲染 SVG 可执行脚本。 */
const MEDIA_TYPES = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
	".gif": "image/gif",
	".avif": "image/avif",
	".bmp": "image/bmp",
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".webm": "video/webm",
	".ogv": "video/ogg",
	".ogg": "video/ogg",
	".mov": "video/quicktime"
};
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"]);
const VIDEO_EXT = new Set([".mp4", ".m4v", ".webm", ".ogv", ".ogg", ".mov"]);
const FITS = new Set(["cover", "contain", "fill", "auto"]);
const POSITIONS = new Set(["center", "top", "bottom", "left", "right", "top left", "top right", "bottom left", "bottom right"]);
/** 背景透出到哪一层：base=只透明页面底板 / panels=侧栏与会话区一起 / full=连输入框也透明。 */
const COVERAGE = new Set(["base", "panels", "full"]);
const TEXT_COLORS = new Set(["black", "white"]);

/** 默认状态：`type:"none"` = 不画背景层，页面与未装插件时完全一致。 */
const DEFAULT_STATE = {
	version: 1,
	revision: 0,
	type: "none",
	source: { kind: "", value: "" },
	fit: "cover",
	position: "center",
	opacity: 1,
	blur: 0,
	dim: 0,
	coverage: "panels",
	textColor: "black",
	video: { loop: true, muted: true, rate: 1 },
	/** 内容底板：背景图很花时给正文铺一层半透明底，保证可读性。 */
	card: { enabled: true, alpha: 0.72, blur: 20 },
	updatedAt: null,
	updatedBy: null
};

const log = (...a) => console.log("[dsh-theme-manager]", ...a);

/* ────────────────────────── 纯逻辑（可离线测试） ────────────────────────── */

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

/** 只接受有限数字；其余（字符串数字、NaN、Infinity）一律回落到 fallback。 */
function num(value, fallback, min, max) {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return clamp(n, min, max);
}

function bool(value, fallback) {
	if (typeof value === "boolean") return value;
	if (value === "true" || value === "1" || value === 1) return true;
	if (value === "false" || value === "0" || value === 0) return false;
	return fallback;
}

/** 扩展名 → Content-Type；不在白名单里返回 undefined。 */
function mediaTypeOf(file) {
	return MEDIA_TYPES[path.extname(String(file)).toLowerCase()];
}

/**
 * 归一化一份背景设置：所有字段都有默认值与范围钳制，未知字段直接丢弃。
 * @param input 任意 JSON（外部软件/页面都可能写错）
 * @param base 现有状态（做部分更新时用）
 */
function normalize(input, base) {
	const prev = base === undefined || base === null ? DEFAULT_STATE : base;
	const raw = input !== null && typeof input === "object" ? input : {};
	const out = {
		version: 1,
		revision: prev.revision ?? 0,
		type: typeof prev.type === "string" ? prev.type : "none",
		source: { kind: "", value: "" },
		fit: prev.fit ?? "cover",
		position: prev.position ?? "center",
		opacity: prev.opacity ?? 1,
		blur: prev.blur ?? 0,
		dim: prev.dim ?? 0,
		coverage: prev.coverage ?? "panels",
		textColor: TEXT_COLORS.has(prev.textColor) ? prev.textColor : "black",
		video: { ...DEFAULT_STATE.video, ...(prev.video ?? {}) },
		card: { ...DEFAULT_STATE.card, ...(prev.card ?? {}) },
		updatedAt: prev.updatedAt ?? null,
		updatedBy: prev.updatedBy ?? null
	};

	// ── 来源：接受 {type,path} / {type,url} / {source:{kind,value}} 三种写法 ──
	const source = raw.source !== null && typeof raw.source === "object" ? raw.source : {};
	const rawPath = typeof raw.path === "string" ? raw.path : typeof source.value === "string" && source.kind === "path" ? source.value : undefined;
	const rawUrl = typeof raw.url === "string" ? raw.url : typeof source.value === "string" && source.kind === "url" ? source.value : undefined;
	if (rawPath !== undefined) out.source = { kind: "path", value: rawPath.trim() };
	else if (rawUrl !== undefined) out.source = { kind: "url", value: rawUrl.trim() };
	else if (typeof prev.source?.value === "string") out.source = { ...prev.source };

	// ── 类型：显式给就用显式的；否则按扩展名推断；none 表示关闭 ──
	if (typeof raw.type === "string") {
		const t = raw.type.trim().toLowerCase();
		out.type = t === "image" || t === "video" || t === "none" ? t : out.type;
	}
	if (out.type !== "none" && (out.source.kind !== "path" || out.source.value !== "")) {
		const ext = out.source.kind === "path" ? path.extname(out.source.value).toLowerCase() : "";
		if (out.source.kind === "path") {
			const inferred = VIDEO_EXT.has(ext) ? "video" : IMAGE_EXT.has(ext) ? "image" : undefined;
			if (raw.type === undefined && inferred !== undefined) out.type = inferred;
			if (out.type === "video" && !VIDEO_EXT.has(ext) && raw.type !== undefined) out.type = inferred ?? out.type;
			if (out.type === "image" && !IMAGE_EXT.has(ext) && raw.type !== undefined) out.type = inferred ?? out.type;
		}
	}
	if (out.source.value === "") out.type = "none";

	// ── 数值 / 枚举 / 布尔 ──
	if (raw.fit !== undefined && FITS.has(String(raw.fit))) out.fit = String(raw.fit);
	if (raw.coverage !== undefined && COVERAGE.has(String(raw.coverage))) out.coverage = String(raw.coverage);
	if (raw.textColor !== undefined && TEXT_COLORS.has(String(raw.textColor))) out.textColor = String(raw.textColor);
	if (raw.position !== undefined) {
		const p = String(raw.position).trim().toLowerCase();
		if (POSITIONS.has(p)) out.position = p;
	}
	if (raw.opacity !== undefined) out.opacity = num(raw.opacity, out.opacity, 0, 1);
	if (raw.blur !== undefined) out.blur = num(raw.blur, out.blur, 0, 60);
	if (raw.dim !== undefined) out.dim = num(raw.dim, out.dim, 0, 1);
	const video = raw.video !== null && typeof raw.video === "object" ? raw.video : {};
	if (video.loop !== undefined) out.video.loop = bool(video.loop, out.video.loop);
	if (video.muted !== undefined) out.video.muted = bool(video.muted, out.video.muted);
	if (video.rate !== undefined) out.video.rate = num(video.rate, out.video.rate, 0.1, 4);
	if (raw.loop !== undefined) out.video.loop = bool(raw.loop, out.video.loop);
	if (raw.muted !== undefined) out.video.muted = bool(raw.muted, out.video.muted);
	if (raw.rate !== undefined) out.video.rate = num(raw.rate, out.video.rate, 0.1, 4);
	const card = raw.card !== null && typeof raw.card === "object" ? raw.card : {};
	if (card.enabled !== undefined) out.card.enabled = bool(card.enabled, out.card.enabled);
	if (card.alpha !== undefined) out.card.alpha = num(card.alpha, out.card.alpha, 0, 1);
	if (card.blur !== undefined) out.card.blur = num(card.blur, out.card.blur, 0, 40);
	if (raw.cardEnabled !== undefined) out.card.enabled = bool(raw.cardEnabled, out.card.enabled);

	return out;
}

/**
 * 解析本地媒体路径：必须是绝对路径、必须落在白名单扩展名内、必须是普通文件。
 * @returns { ok: true, file, mime, size } 或 { ok: false, status, error }
 */
async function resolveMedia(input) {
	if (typeof input !== "string" || input.trim() === "") return { ok: false, status: 400, error: "path required" };
	const file = path.resolve(input.trim());
	if (!path.isAbsolute(file)) return { ok: false, status: 400, error: "path must be absolute" };
	const mime = mediaTypeOf(file);
	if (mime === undefined) {
		return {
			ok: false,
			status: 415,
			error: `unsupported media extension ${JSON.stringify(path.extname(file))} (allowed: ${Object.keys(MEDIA_TYPES).join(" ")})`
		};
	}
	let st;
	try {
		st = await fsp.stat(file);
	} catch (error) {
		return { ok: false, status: 404, error: `cannot stat ${file}: ${error?.code ?? String(error)}` };
	}
	if (!st.isFile()) return { ok: false, status: 404, error: `not a regular file: ${file}` };
	return { ok: true, file, mime, size: st.size, mtimeMs: st.mtimeMs };
}

/**
 * 解析 Range 头。只支持单区间（浏览器对 <video> 就是这么发的）。
 * @returns { none } | { invalid } | { start, end }（end 含端点下标）
 */
function parseRange(header, size) {
	if (typeof header !== "string" || header.trim() === "") return { kind: "none" };
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (m === null) return { kind: "invalid" };
	const [, a, b] = m;
	if (a === "" && b === "") return { kind: "invalid" };
	let start;
	let end;
	if (a === "") {
		const suffix = Number(b);
		if (suffix === 0) return { kind: "invalid" };
		start = Math.max(0, size - suffix);
		end = size - 1;
	} else {
		start = Number(a);
		end = b === "" ? size - 1 : Number(b);
	}
	if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return { kind: "unsatisfiable" };
	return { kind: "ok", start, end: Math.min(end, size - 1) };
}

/* ────────────────────────── 状态读写 ────────────────────────── */

function stateIo() {
	let cache = null;
	let loading = null;

	async function load() {
		if (cache !== null) return cache;
		if (loading !== null) return loading;
		loading = (async () => {
			try {
				const text = await fsp.readFile(STATE_FILE, "utf8");
				cache = normalize(JSON.parse(text), DEFAULT_STATE);
			} catch {
				cache = { ...DEFAULT_STATE };
			}
			return cache;
		})();
		const value = await loading;
		loading = null;
		return value;
	}

	/** 原子写：先落临时文件再 rename，避免外部软件读到半截 JSON。 */
	async function save(next) {
		cache = next;
		await fsp.mkdir(STATE_DIR, { recursive: true });
		const tmp = `${STATE_FILE}.${process.pid}.tmp`;
		await fsp.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		await fsp.rename(tmp, STATE_FILE);
		return next;
	}

	return { load, save, file: STATE_FILE };
}

/* ────────────────────────── HTTP 层 ────────────────────────── */

function reply(res, status, obj, extraHeaders) {
	const body = `${JSON.stringify(obj, null, 2)}\n`;
	const headers = {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"Access-Control-Allow-Origin": "*",
		...extraHeaders
	};
	try {
		res.writeHead(status, headers);
		res.end(body);
	} catch {
		/* 客户端已断开 */
	}
}

/**
 * 读 JSON 请求体。
 * 超限时**不 destroy 连接**：先把剩余数据排空，再在 end 时拒绝 —— 这样调用方
 * 能收到 413 而不是 "socket closed"（对外部软件友好；实测 destroy 会让 fetch
 * 直接抛 UND_ERR_SOCKET）。只有连排空都失控（64 倍上限）才强断。
 */
function readBody(req) {
	return new Promise((resolve, reject) => {
		let data = "";
		let seen = 0;
		let tooLarge = false;
		req.on("data", (chunk) => {
			seen += chunk.length;
			if (tooLarge) {
				if (seen > MAX_BODY * 64) req.destroy();
				return;
			}
			data += chunk;
			if (data.length > MAX_BODY) {
				tooLarge = true;
				data = "";
			}
		});
		req.on("end", () => {
			if (tooLarge) reject(Object.assign(new Error("body too large"), { code: "too-large" }));
			else resolve(data);
		});
		req.on("error", reject);
		req.on("aborted", () => reject(Object.assign(new Error("request aborted"), { code: "aborted" })));
	});
}

/** 把 Node 的请求流按 Range 交给响应；不做内存缓冲，视频可以边下边播。 */
function streamFile(req, res, info) {
	const base = {
		"Content-Type": info.mime,
		"Accept-Ranges": "bytes",
		"Cache-Control": "no-store",
		"Access-Control-Allow-Origin": "*",
		"Last-Modified": new Date(info.mtimeMs).toUTCString()
	};
	const range = parseRange(req.headers.range, info.size);
	if (range.kind === "invalid") {
		res.writeHead(416, { ...base, "Content-Range": `bytes */${info.size}` });
		res.end();
		return;
	}
	if (range.kind === "unsatisfiable") {
		res.writeHead(416, { ...base, "Content-Range": `bytes */${info.size}` });
		res.end();
		return;
	}
	const start = range.kind === "ok" ? range.start : 0;
	const end = range.kind === "ok" ? range.end : info.size - 1;
	const status = range.kind === "ok" ? 206 : 200;
	const headers = range.kind === "ok" ? { ...base, "Content-Range": `bytes ${start}-${end}/${info.size}` } : { ...base, "Content-Length": String(info.size) };
	if (range.kind === "ok") headers["Content-Length"] = String(end - start + 1);
	try {
		res.writeHead(status, headers);
	} catch {
		return;
	}
	if (req.method === "HEAD") {
		res.end();
		return;
	}
	const stream = fs.createReadStream(info.file, { start, end });
	stream.on("error", () => {
		try {
			res.destroy();
		} catch {}
	});
	stream.pipe(res);
}

/**
 * 构造路由 handler。
 * @param {{ load: Function, save: Function }} store 状态存储
 * @returns (req, res) => Promise<void>
 */
function createHandler(store) {
	return async function handler(req, res) {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const route = url.pathname.replace(/\/+$/, "") || ROUTE;
		const method = (req.method ?? "GET").toUpperCase();
		if (method === "OPTIONS") {
			res.writeHead(204, {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type",
				"Access-Control-Max-Age": "600"
			});
			res.end();
			return;
		}
		try {
			// ── 探活 + 自描述 ──
			if ((method === "GET" || method === "HEAD") && (route === ROUTE || route === `${ROUTE}/health`)) {
				reply(res, 200, {
					ok: true,
					name: "dsh-theme-manager",
					version: VERSION,
					/* 监听端口回给页面：桌面外壳里页面 origin 是 dsh-app://app，
					   推不出「外部软件该打哪个地址」，只能问 host 自己。 */
					port: req.socket !== null && req.socket !== undefined ? req.socket.localPort : null,
					stateFile: store.file,
					endpoints: {
						state: `GET ${ROUTE}/state`,
						set: `POST ${ROUTE}/background`,
						clear: `POST ${ROUTE}/background/clear`,
						media: `GET ${ROUTE}/media`,
						asset: `GET ${ROUTE}/asset?p=<绝对路径>`
					}
				});
				return;
			}

			// ── 读状态 ──
			if ((method === "GET" || method === "HEAD") && route === `${ROUTE}/state`) {
				const state = await store.load();
				reply(res, 200, { ok: true, background: state, updatedAt: state.updatedAt });
				return;
			}

			// ── 写状态 ──
			if (method === "POST" && (route === `${ROUTE}/background` || route === `${ROUTE}/set`)) {
				let body = {};
				try {
					body = JSON.parse((await readBody(req)) || "{}");
				} catch (error) {
					reply(res, error?.code === "too-large" ? 413 : 400, { ok: false, error: `bad json: ${String(error?.message ?? error)}` });
					return;
				}
				const prev = await store.load();
				const next = normalize(body, prev);
				next.revision = (prev.revision ?? 0) + 1;
				next.updatedAt = new Date().toISOString();
				next.updatedBy = String(req.headers["x-dsh-theme-source"] ?? req.headers["user-agent"] ?? "unknown").slice(0, 120);
				const warning = [];
				if (next.type !== "none" && next.source.kind === "path") {
					const info = await resolveMedia(next.source.value);
					if (!info.ok) warning.push(`${info.status}: ${info.error}`);
				}
				await store.save(next);
				reply(res, 200, { ok: true, background: next, warning: warning.length > 0 ? warning : undefined });
				return;
			}

			if (method === "POST" && (route === `${ROUTE}/background/clear` || route === `${ROUTE}/clear`)) {
				const prev = await store.load();
				const next = { ...DEFAULT_STATE, revision: (prev.revision ?? 0) + 1, updatedAt: new Date().toISOString(), updatedBy: String(req.headers["user-agent"] ?? "unknown").slice(0, 120) };
				await store.save(next);
				reply(res, 200, { ok: true, background: next });
				return;
			}

			// ── 当前背景的媒体文件 ──
			// `?p=` 优先：页面把路径写进 URL（换文件必然换地址，浏览器缓存才认得出来）；
			// 不带参数时回落到状态里的那份（外部软件更愿意用短地址）。
			if ((method === "GET" || method === "HEAD") && route === `${ROUTE}/media`) {
				const state = await store.load();
				const explicit = url.searchParams.get("p");
				const target = explicit !== null && explicit !== "" ? explicit : state.type === "none" || state.source.kind !== "path" ? "" : state.source.value;
				if (target === "") {
					reply(res, 404, { ok: false, error: "no local media configured" });
					return;
				}
				const info = await resolveMedia(target);
				if (!info.ok) {
					reply(res, info.status, { ok: false, error: info.error });
					return;
				}
				streamFile(req, res, info);
				return;
			}

			// ── 任意本机媒体文件 ──
			if ((method === "GET" || method === "HEAD") && route === `${ROUTE}/asset`) {
				const info = await resolveMedia(url.searchParams.get("p") ?? "");
				if (!info.ok) {
					reply(res, info.status, { ok: false, error: info.error });
					return;
				}
				streamFile(req, res, info);
				return;
			}

			reply(res, 404, { ok: false, error: `unknown route: ${method} ${route}` });
		} catch (error) {
			reply(res, 500, { ok: false, error: String(error?.message ?? error) });
		}
	};
}

/** 供离线测试：把 handler 挂到一个真实的 http server 上（不依赖 cordis）。 */
export async function __createTestServer() {
	const http = process.getBuiltinModule("node:http");
	const store = stateIo();
	const server = http.createServer(createHandler(store));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		port: server.address().port,
		url: `http://127.0.0.1:${server.address().port}`,
		close: () => new Promise((resolve) => server.close(resolve))
	};
}

export const __internal = { DEFAULT_STATE, MEDIA_TYPES, createHandler, mediaTypeOf, normalize, parseRange, resolveMedia, stateIo, STATE_FILE, ROUTE, VERSION };

/* ────────────────────────── cordis 挂载 ────────────────────────── */

export function apply(ctx) {
	const store = stateIo();
	ctx.inject(["webServer"], (wctx) => {
		ctx.effect(
			() =>
				wctx.webServer.register({
					kind: "prefix",
					path: ROUTE,
					handler: createHandler(store)
				}),
			"dsh-theme-manager: background route"
		);
	});
	log(`host half mounted; ${ROUTE}/{state,background,background/clear,media,asset} · state=${STATE_FILE}`);
}
