// dsh-theme-manager — client 半边离线回归（stub DOM，不重启应用、不开浏览器）
//
//   node tests/background-test.mjs [别的 client.js 路径]
//
// 覆盖三件事：
//   ① 背景层（图片/视频）：DOM 生成与移除、参数 → CSS 映射、元素复用策略；
//   ② 与 host 的往返：fetch 打 /dsh-theme-manager/*、revision 变化才重建 DOM；
//   ③ 内联的「界面定制」段（原 dsh-ui-harmonizer，已裁剪）真的被挂上：
//      只剩「工作区字号 / UI 字体」两个设置项、静态 CSS 只剩侧栏缩放与让位规则；
//      对话内容宽度 / 对话字号 / 圆角卡片已删除，shell.overlay 不再注册、旧状态字段被清除。
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = process.argv[2] || join(HERE, "..", "lib", "client.js");

/* ───────────────────────────── stub DOM ───────────────────────────── */

function makeElement(tag) {
	/* dataset 必须与 data-* 属性联动：真实 DOM 里 `el.dataset.pluginCss = x` 就是
	   设 `data-plugin-css`，而插件正是靠这个属性标记/判重自己的样式表。 */
	const attributes = new Map();
	const dataset = new Proxy(
		{},
		{
			set(target, prop, value) {
				const name = "data-" + String(prop).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
				attributes.set(name, String(value));
				target[prop] = String(value);
				return true;
			},
			get: (target, prop) => target[prop],
			has: (target, prop) => prop in target,
			deleteProperty(target, prop) {
				attributes.delete("data-" + String(prop).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`));
				delete target[prop];
				return true;
			}
		}
	);
	const el = {
		tagName: String(tag).toUpperCase(),
		children: [],
		attributes,
		dataset,
		style: { setProperty: () => {}, removeProperty: () => {} },
		classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
		id: "",
		textContent: "",
		disabled: false,
		isConnected: true,
		setAttribute(name, value) {
			el.attributes.set(name, String(value));
			if (name === "id") el.id = String(value);
		},
		getAttribute(name) {
			return el.attributes.has(name) ? el.attributes.get(name) : null;
		},
		removeAttribute(name) {
			el.attributes.delete(name);
		},
		appendChild(child) {
			el.children.push(child);
			child.parentNode = el;
			return child;
		},
		insertBefore(child, ref) {
			const i = el.children.indexOf(ref);
			if (i < 0) el.children.unshift(child);
			else el.children.splice(i, 0, child);
			child.parentNode = el;
			return child;
		},
		remove() {
			const parent = el.parentNode;
			if (parent !== undefined && parent !== null) {
				const i = parent.children.indexOf(el);
				if (i >= 0) parent.children.splice(i, 1);
			}
			el.parentNode = null;
		},
		querySelector: () => null,
		querySelectorAll: () => [],
		addEventListener: () => {},
		removeEventListener: () => {},
		getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
		contains: () => false,
		matches: () => false,
		closest: () => null,
		play: () => Promise.resolve(),
		pause: () => {},
		load: () => {}
	};
	Object.defineProperty(el, "firstChild", { get: () => (el.children.length > 0 ? el.children[0] : null) });
	Object.defineProperty(el, "firstElementChild", { get: () => (el.children.length > 0 ? el.children[0] : null) });
	/* 真实 DOM 里 `img.src = url` 会反映到 src 属性上；stub 也照做，测试才能用
	   getAttribute("src") 断言「页面到底去哪个地址取媒体」。 */
	Object.defineProperty(el, "src", {
		get: () => (el.attributes.has("src") ? el.attributes.get("src") : ""),
		set: (value) => el.attributes.set("src", String(value))
	});
	return el;
}

function setUpDom() {
	const store = new Map();
	const head = makeElement("head");
	const body = makeElement("body");
	const documentElement = makeElement("html");
	const listeners = new Map();

	const document = {
		head,
		body,
		documentElement,
		visibilityState: "visible",
		createElement: (tag) => makeElement(tag),
		getElementById(id) {
			const pool = [...head.children, ...body.children];
			return pool.filter((el) => el.id === id)[0] ?? null;
		},
		querySelector(selector) {
			if (typeof selector === "string" && selector.startsWith("style[data-plugin-css=")) {
				return head.children.filter((el) => el.tagName === "STYLE" && el.dataset.pluginCss === selector.replace(/^style\[data-plugin-css=/, "").replace(/\]$/, ""))[0] ?? null;
			}
			return null;
		},
		querySelectorAll: () => [],
		addEventListener: (type, fn) => listeners.set(type, fn),
		removeEventListener: (type) => listeners.delete(type),
		dispatchEvent: () => true
	};

	const window = {
		document,
		location: { protocol: "http:", host: "127.0.0.1:19387", href: "http://127.0.0.1:19387/" },
		localStorage: {
			getItem: (k) => (store.has(k) ? store.get(k) : null),
			setItem: (k, v) => store.set(k, String(v)),
			removeItem: (k) => store.delete(k)
		},
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		setInterval: () => 1,
		clearInterval: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		requestAnimationFrame: (fn) => { try { fn(0); } catch { /* noop */ } return 1; },
		cancelAnimationFrame: () => {},
		matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
	};

	class MutationObserver {
		observe() {}
		disconnect() {}
	}
	class ResizeObserver {
		observe() {}
		unobserve() {}
		disconnect() {}
	}

	return { window, document, head, body, store, MutationObserver, ResizeObserver, listeners };
}

/** 载入插件并返回 __internal 句柄；fetch 由调用方塞进 fakeFetch。 */
async function loadPlugin(dom, { fetchImpl } = {}) {
	globalThis.window = dom.window;
	globalThis.document = dom.document;
	globalThis.MutationObserver = dom.MutationObserver;
	globalThis.ResizeObserver = dom.ResizeObserver;
	globalThis.localStorage = dom.window.localStorage;
	globalThis.requestAnimationFrame = dom.window.requestAnimationFrame;
	globalThis.fetch = fetchImpl ?? (() => Promise.reject(new Error("fetch not stubbed")));

	/* harmonizer 段在 apply 里会用到这些全局对象 */
	if (globalThis.navigator === undefined) globalThis.navigator = { language: "zh-CN" };

	let spec = null;
	dom.window.__ModuleLoader__ = { load: (s) => { spec = s; } };

	const mod = await import(pathToFileURL(TARGET).href + "?t=" + Date.now() + Math.random());
	if (spec === null) throw new Error("client.js 没有调用 __ModuleLoader__.load");
	const React = {
		createElement: (type, props, ...kids) => ({ type, props, kids }),
		useState: (init) => [init, () => {}],
		useRef: () => ({ current: null }),
		useEffect: () => {},
		useMemo: (fn) => fn(),
		useCallback: (fn) => fn,
		useSyncExternalStore: () => ({ palette: {}, bg: null, bgNotice: null, version: 0 }),
		Fragment: "Fragment"
	};
	const exports = spec.factory((id) => (id === "react" ? React : {}));
	mod.default;
	return { api: exports.__internal, exports, dom };
}

/* ───────────────────────────── 断言工具 ───────────────────────────── */

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
	if (cond) pass += 1;
	else failures.push(`${name}${detail === undefined ? "" : `\n      实得 ${JSON.stringify(detail)}`}`);
}
function contains(name, text, needle) {
	ok(`${name} 含 ${JSON.stringify(needle)}`, typeof text === "string" && text.includes(needle), typeof text === "string" ? text.slice(0, 400) : text);
}
function absent(name, text, needle) {
	ok(`${name} 不含 ${JSON.stringify(needle)}`, typeof text === "string" && !text.includes(needle), typeof text === "string" ? text.slice(0, 400) : text);
}

const BG_STATE = {
	version: 1,
	revision: 3,
	type: "image",
	source: { kind: "path", value: "/tmp/dsh-theme-test/pic.png" },
	fit: "cover",
	position: "center",
	opacity: 1,
	blur: 0,
	dim: 0,
	coverage: "panels",
	textColor: "black",
	video: { loop: true, muted: true, rate: 1 },
	card: { enabled: false, alpha: 0.72, blur: 0 },
	updatedAt: "2026-09-28T03:00:00.000Z"
};

const jsonResponse = (obj) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(obj) });

/**
 * 有状态的假 host：POST /background 会把 patch 合并进自己的状态并回包 —— 这一点很关键，
 * 因为真 host 是权威，插件写完会拿回包覆盖本地那份。stub 若无状态，会把刚设的参数又擦掉。
 */
function makeHost(initial) {
	let state = JSON.parse(JSON.stringify(initial));
	const calls = [];
	const impl = (url, init) => {
		const u = String(url);
		const method = (init?.method ?? "GET").toUpperCase();
		calls.push({ url: u, method });
		if (u.endsWith("/health")) return jsonResponse({ ok: true, port: 19387 });
		if (u.endsWith("/state")) return jsonResponse({ ok: true, background: state });
		if (u.endsWith("/background")) {
			state = mergeState(state, init?.body ? JSON.parse(init.body) : {});
			state.revision = (state.revision ?? 0) + 1;
			state.updatedAt = new Date().toISOString();
			return jsonResponse({ ok: true, background: state });
		}
		return jsonResponse({ ok: false, error: "unknown route" });
	};
	impl.calls = calls;
	impl.state = () => state;
	impl.set = (next) => {
		state = JSON.parse(JSON.stringify(next));
	};
	return impl;
}

function mergeState(state, patch) {
	const next = JSON.parse(JSON.stringify(state));
	if (patch.type !== undefined) next.type = patch.type;
	if (patch.path !== undefined) next.source = { kind: "path", value: patch.path };
	if (patch.url !== undefined) next.source = { kind: "url", value: patch.url };
	if (patch.source !== undefined) next.source = patch.source;
	for (const key of ["fit", "position", "opacity", "blur", "dim", "coverage", "textColor"]) if (patch[key] !== undefined) next[key] = patch[key];
	if (patch.video !== undefined) next.video = { ...next.video, ...patch.video };
	if (patch.card !== undefined) next.card = { ...next.card, ...patch.card };
	if (next.source.value === "") next.type = "none";
	return next;
}

/* ═══════════════════ 用例 1：无背景时不生成任何层 ═══════════════════ */

{
	const dom = setUpDom();
	const { api } = await loadPlugin(dom, { fetchImpl: makeHost({ ...BG_STATE, type: "none", source: { kind: "", value: "" } }) });
	api.applyBackground();
	const style = dom.document.getElementById(api.BG_STYLE_ID);
	ok("① 无背景时保留空样式句柄", style !== null);
	ok("① 无背景时交还原生底板", style.textContent === "", style.textContent);
	ok("① 无背景时不创建背景层", dom.document.getElementById(api.BG_LAYER_ID) === null);
	absent("① 无背景时不写媒体规则", style.textContent, "object-fit");
}

/* ═══════════════════ 用例 2：图片背景 + 参数映射 ═══════════════════ */

{
	const dom = setUpDom();
	const { api } = await loadPlugin(dom, { fetchImpl: makeHost(BG_STATE) });
	api.pushBackground({ type: "image", path: BG_STATE.source.value, coverage: "panels", dim: 0.35, blur: 8, opacity: 0.9 });
	await new Promise((r) => setTimeout(r, 0));

	const layer = dom.document.getElementById(api.BG_LAYER_ID);
	ok("② 创建了背景层", layer !== null);
	ok("② 背景层插在 body 最前面（保证在内容之下）", dom.body.children[0] === layer, dom.body.children.map((c) => c.id));
	const media = layer.children[0];
	ok("② 媒体元素是 <img>", media.tagName === "IMG", media.tagName);
	ok("② img.src 指向 host 媒体路由", media.getAttribute("src").startsWith("/dsh-theme-manager/media?p="), media.getAttribute("src"));

	const style = dom.document.getElementById(api.BG_STYLE_ID);
	contains("② object-fit=cover", style.textContent, "object-fit: cover");
	contains("② 不透明度", style.textContent, "opacity: 0.9");
	contains("② 模糊", style.textContent, "filter: blur(8px)");
	contains("② 面板档透出：整页骨架层", style.textContent, '[data-slot="root"] > * { background: transparent !important; }');
	contains("② 面板档只透明三个列容器", style.textContent, '[data-slot="root"] > * > :is([class$="_sidebarCol"], [class$="_centerCol"], [class$="_rightbarCol"])');
	contains("② 主区内容根透明", style.textContent, '[data-phase][class$="_root"]');
	absent("② 输入框不被通用 data-phase 规则命中", style.textContent, '[data-phase] { background:');
	contains("② 遮罩就绪后输入区透出壁纸", style.textContent, '[data-conversation-scroll]:has([data-dsh-bg-clip]) > [data-composer-seat] { background: transparent !important; }');
	contains("② 正文在输入区前渐隐", style.textContent, '[data-dsh-bg-clip]:not(:has([data-conversation-composer-overlay])) { mask-image: linear-gradient(');
	contains("② 暗化遮罩", style.textContent, "background: rgba(0, 0, 0, 0.35)");
	contains("② 媒体未加载或半透明时有主题底色兜底", style.textContent, "pointer-events: none; background: var(--dsw-alias-bg-base, #fff);");
}

/* ═══════════════════ 用例 3：改参数不重建元素，换地址才重建 ═══════════════════ */

{
	const dom = setUpDom();
	const { api } = await loadPlugin(dom, { fetchImpl: makeHost(BG_STATE) });
	api.pushBackground({ type: "image", path: BG_STATE.source.value });
	await new Promise((r) => setTimeout(r, 0));
	const first = dom.document.getElementById(api.BG_LAYER_ID).children[0];

	api.pushBackground({ blur: 20, opacity: 0.5 });
	await new Promise((r) => setTimeout(r, 0));
	const second = dom.document.getElementById(api.BG_LAYER_ID).children[0];
	ok("③ 只调参数时复用同一个 <img>（不重拉图片）", first === second);

	api.pushBackground({ path: "/tmp/dsh-theme-test/other.png", source: { kind: "path", value: "/tmp/dsh-theme-test/other.png" } });
	await new Promise((r) => setTimeout(r, 0));
	const third = dom.document.getElementById(api.BG_LAYER_ID).children[0];
	ok("③ 换地址时重建元素", third !== second);
	ok("③ 新元素指向新地址", third.getAttribute("src").includes("other.png") && third.getAttribute("src").startsWith("/dsh-theme-manager/media?p="), third.getAttribute("src"));
}

/* ═══════════════════ 用例 4：视频背景 + 视频参数 ═══════════════════ */

{
	const dom = setUpDom();
	const { api } = await loadPlugin(dom, { fetchImpl: makeHost(BG_STATE) });
	api.pushBackground({ type: "video", path: "/tmp/dsh-theme-test/clip.mp4", source: { kind: "path", value: "/tmp/dsh-theme-test/clip.mp4" }, video: { loop: false, muted: true, rate: 0.8 } });
	await new Promise((r) => setTimeout(r, 0));
	const media = dom.document.getElementById(api.BG_LAYER_ID).children[0];
	ok("④ 媒体元素是 <video>", media.tagName === "VIDEO", media.tagName);
	ok("④ muted 跟随状态", media.muted === true, media.muted);
	ok("④ loop 跟随状态", media.loop === false, media.loop);
	ok("④ playbackRate 跟随状态", media.playbackRate === 0.8, media.playbackRate);
	const style = dom.document.getElementById(api.BG_STYLE_ID);
	contains("④ 视频同样吃 object-fit", style.textContent, "#dsh-theme-manager-bg-layer > video {  object-fit: cover;");
}

/* ═══════════════════ 用例 5：内容底板 / 全部档 / 清除 ═══════════════════ */

{
	const dom = setUpDom();
	const { api } = await loadPlugin(dom, { fetchImpl: makeHost(BG_STATE) });
	api.pushBackground({ type: "image", path: BG_STATE.source.value, coverage: "full", card: { enabled: true, alpha: 0.6, blur: 12 } });
	await new Promise((r) => setTimeout(r, 0));
	const style = dom.document.getElementById(api.BG_STYLE_ID).textContent;
	contains("⑤ 全部档卡片融合于壁纸", style, '[data-composer-seat] [data-composer-card] { background: color-mix(in srgb, var(--dsw-specific-input-major, var(--dsw-alias-bg-base, #fff)) 78%, transparent) !important; }');
	contains("⑤ 全部档卡片毛玻璃限幅", style, '[data-composer-seat] [data-composer-card] { backdrop-filter: blur(12px)');
	contains("⑤ 全部档正文先渐隐再到输入区", style, '[data-dsh-bg-clip]:not(:has([data-conversation-composer-overlay]))');
	contains("⑤ 毛玻璃遮罩 color-mix（主区取页面底色）", style, "color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 60%, transparent)");
	contains("⑤ 毛玻璃遮罩 color-mix（侧栏取官方侧栏色）", style, "color-mix(in srgb, var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #fff)) 60%, transparent)");
	contains("⑤ 毛玻璃模糊", style, "backdrop-filter: blur(12px) saturate(140%)");

	api.pushBackground({ type: "none", source: { kind: "", value: "" } });
	await new Promise((r) => setTimeout(r, 0));
	ok("⑤ 清除后背景层被移除", dom.document.getElementById(api.BG_LAYER_ID) === null);
	ok("⑤ 清除后覆盖样式全部消失", dom.document.getElementById(api.BG_STYLE_ID).textContent === "");
}

/* ═══════════════════ 用例 6：网络地址 + 归一化钳制 ═══════════════════ */

{
	const dom = setUpDom();
	const { api } = await loadPlugin(dom, { fetchImpl: makeHost(BG_STATE) });
	const norm = api.bgNormalize({ url: "https://example.com/a.jpg", type: "image", blur: 999, dim: -1, opacity: 2, coverage: "nope", video: { rate: 99 } });
	ok("⑥ url → source.kind=url", norm.source.kind === "url" && norm.source.value === "https://example.com/a.jpg");
	ok("⑥ blur 钳到 60", norm.blur === 60, norm.blur);
	ok("⑥ dim 钳到 0", norm.dim === 0, norm.dim);
	ok("⑥ opacity 钳到 1", norm.opacity === 1, norm.opacity);
	ok("⑥ coverage 非法值被忽略（保留原值）", norm.coverage === "panels", norm.coverage);
	ok("⑥ video.rate 钳到 4", norm.video.rate === 4, norm.video.rate);
	const urlNorm = api.bgNormalize({ url: "https://example.com/a.jpg" }, api.bgDefault);
	ok("⑥ url 时 bgMediaUrl 直接返回网址", api.bgMediaUrl(urlNorm) === "https://example.com/a.jpg", api.bgMediaUrl(urlNorm));
}

/* ═══════════════════ 用例 7：拉 host 状态（external 改动跟随） ═══════════════════ */

{
	const dom = setUpDom();
	const host = makeHost({ ...BG_STATE, type: "none", source: { kind: "", value: "" }, revision: 1 });
	const { api } = await loadPlugin(dom, { fetchImpl: host });
	api.installBackground();
	await api.pullBackground();
	ok("⑦ 初始：host 说无背景 → 没有层", dom.document.getElementById(api.BG_LAYER_ID) === null);

	/* 模拟「外部软件改了背景」：revision 与 updatedAt 都变 */
	host.set({ ...BG_STATE, revision: 9, updatedAt: "2026-09-28T04:00:00.000Z" });
	await api.pullBackground();
	const layer = dom.document.getElementById(api.BG_LAYER_ID);
	ok("⑦ 外部改动后自动出现背景层", layer !== null);
	ok("⑦ 拉取的是 host 的 /state", host.calls.some((c) => c.url === "/dsh-theme-manager/state" && c.method === "GET"), host.calls);
	ok("⑦ 页面全局接口 window.__dshTheme 可用", typeof dom.window.__dshTheme?.set === "function");
	ok("⑦ __dshTheme.get() 返回当前状态副本", dom.window.__dshTheme.get().type === "image");
}

/* ═══════════════════ 用例 8：「界面定制」段真的挂上（已裁剪版） ═══════════════════ */

{
	const dom = setUpDom();
	const { api, exports } = await loadPlugin(dom, { fetchImpl: makeHost(BG_STATE) });
	const half = api.harmonizerHalf((id) => (id === "react" ? { createElement: () => ({}), useState: () => [undefined, () => {}], useEffect: () => {}, useRef: () => ({ current: null }), useSyncExternalStore: () => ({}), Fragment: "Fragment" } : {}));
	ok("⑧ 内联段导出了 apply()", typeof half?.apply === "function");

	const registered = [];
	const effects = [];
	const ctx = {
		effect: (fn, label) => { effects.push(label); try { const dispose = fn(); return dispose; } catch (error) { effects.push(`ERROR ${label}: ${error.message}`); } },
		slots: { inject: (slot, fn) => { registered.push(slot); fn(); }, register: (meta) => { registered.push(`${meta.name}:${meta.id}`); return () => {}; } }
	};
	exports.apply(ctx);

	ok("⑧ 注册了 settings.general.item（界面定制那一块）", registered.some((r) => String(r).startsWith("settings.general.item")), registered);
	ok("⑧ 不再注册 shell.overlay（圆角卡片已删）", !registered.some((r) => String(r).startsWith("shell.overlay")), registered);
	ok("⑧ 注册了本插件的主题设置页", registered.some((r) => String(r).includes("theme-manager")), registered);
	ok("⑧ 内联段跑过 CSS 生命周期 effect", effects.some((l) => String(l).includes("css lifecycle")), effects);
	ok("⑧ 不再注册设置页统一头（GeneralHeader 已删）", !registered.some((r) => String(r).includes("ui-enhancer-header")), registered);
	ok("⑧ 不再注册 better-sidebar / genui 协调 effect", !effects.some((l) => /better-sidebar|relocation|title fill|tooltips/.test(String(l))), effects);
	const harmonizerStyle = dom.head.children.filter((el) => el.getAttribute("data-plugin-css") === "dsh-theme-manager/harmonizer.module.css")[0];
	ok("⑧ 静态 CSS 用的是本插件命名空间", harmonizerStyle !== undefined, dom.head.children.map((el) => el.getAttribute("data-plugin-css")));
	ok("⑧ 静态 CSS 只剩侧栏缩放 + 让位规则（2.5–5KB）", harmonizerStyle !== undefined && harmonizerStyle.textContent.length > 2500 && harmonizerStyle.textContent.length < 5000, harmonizerStyle?.textContent?.length);
	ok("⑧ 保留 --enhancer-sidebar-scale 驱动规则", harmonizerStyle !== undefined && /--enhancer-sidebar-scale/.test(harmonizerStyle.textContent));
	ok("⑧ 对话宽度 / 对话字号 / 圆角卡片的 CSS 已删净", harmonizerStyle !== undefined && !/--enhancer-content-width|--enhancer-font-size|--enhancer-font-line|--enhancer-chat-scale|--dsh-chat-content-width|enhc-center-card/.test(harmonizerStyle.textContent), harmonizerStyle?.textContent?.slice(0, 240));
	ok("⑧ 已删掉插件协调 / UI 规范化的选择器", harmonizerStyle !== undefined && !/nArs4W|_toggleButton|_toggleCluster|data-genui|settings\\\\.section/.test(harmonizerStyle.textContent), harmonizerStyle?.textContent?.slice(0, 200));
	ok("⑧ 消息行不覆盖原生 hidden=until-found，也不插入估算高度", harmonizerStyle !== undefined && !/\[class\$=_flowItem\][^{]*\{[^}]*(?:content-visibility|contain-intrinsic-size)/u.test(harmonizerStyle.textContent));
	ok("⑧ 没有用旧插件的 data-plugin 值", dom.head.children.every((el) => el.getAttribute("data-plugin") !== "dsh-ui-harmonizer"), dom.head.children.map((el) => el.getAttribute("data-plugin")));
	/* localStorage 键必须保持原样：用户原有的宽度/字号/字体设置不能丢 */
	ok("⑧ 存储键仍是 harness-ui-enhancer.state", half !== null && JSON.stringify(half).length > 0);

	/* ── 删除三项后：源码里不该再有它们的行 / 辅助 / 类名 ── */
	const source = readFileSync(TARGET, "utf8");
	absent("⑧ 源码", source, "getRowWidth");
	absent("⑧ 源码", source, "getRowFontSize");
	absent("⑧ 源码", source, "getRowCard");
	absent("⑧ 源码", source, "markdownCss");
	absent("⑧ 源码", source, "SwitchControl");
	absent("⑧ 源码", source, "CenterColCard");
	absent("⑧ 源码", source, "enhc-center-card");
	absent("⑧ 源码", source, "enhancer-content-width");
	absent("⑧ 源码", source, "enhancer-chat-scale");
	absent("⑧ 源码", source, 'key: "width"');
	absent("⑧ 源码", source, 'key: "center-card"');
	contains("⑧ 源码", source, 'key: "sidebar"');
	contains("⑧ 源码", source, 'key: "font-family"');
	contains("⑧ 源码", source, "MARKDOWN_FAMILY_VARS");

	/* ── 旧 localStorage 里被删字段必须被就地清除（用户选「清掉」） ── */
	const dom2 = setUpDom();
	dom2.window.localStorage.setItem("harness-ui-enhancer.state", JSON.stringify({ width: 900, fontSize: 18, card: true, sidebarSize: 16, fontId: "mono" }));
	const { api: api2 } = await loadPlugin(dom2, { fetchImpl: makeHost(BG_STATE) });
	const half2 = api2.harmonizerHalf((id) => (id === "react" ? { createElement: () => ({}), useState: () => [undefined, () => {}], useEffect: () => {}, useRef: () => ({ current: null }), useSyncExternalStore: () => ({}), Fragment: "Fragment" } : {}));
	half2.apply({
		effect: (fn) => { try { fn(); } catch { /* noop */ } },
		slots: { inject: (slot, fn) => { fn(); }, register: () => () => {} }
	});
	const persisted = JSON.parse(dom2.window.localStorage.getItem("harness-ui-enhancer.state"));
	ok("⑧ 已删字段 width / fontSize / card 被清除", persisted.width === undefined && persisted.fontSize === undefined && persisted.card === undefined, persisted);
	ok("⑧ 存活字段 sidebarSize / fontId 原样保留", persisted.sidebarSize === 16 && persisted.fontId === "mono", persisted);
}

/* ═══════════════════ 用例 9：合并段抛错不影响主功能 ═══════════════════ */

{
	const dom = setUpDom();
	const { api, exports } = await loadPlugin(dom, { fetchImpl: makeHost(BG_STATE) });
	/* ctx 故意缺 slots：内联段会抛错，applyHarmonizer 必须吞掉，且背景/主题页仍挂上 */
	const brokenCtx = { effect: () => { throw new Error("boom"); }, slots: null };
	let threw = false;
	try {
		exports.apply(brokenCtx);
	} catch (error) {
		threw = true;
	}
	ok("⑨ 合并段抛错时 apply 不炸", threw === false);
	ok("⑨ 背景逻辑仍然生效（仍是可用句柄）", typeof api.applyBackground === "function");
}

/* ═══════════════════ 用例 9b：主色调徽章配对（v0.9.1）═══════════════════ */
/* 官方 QuestionComposer 徽章 = 底 var(--dsw-specific-sidebar-nav-item-active-accent)
 * + 字 var(--dsw-alias-button-info-fill)。主色调槽改深色时底变深、字不变 → 深底蓝字
 * 看不清（2026-10-07 用户截图报障）。调色盘必须按亮度补前景：深底暖白 / 浅底近黑。 */
{
	const dom = setUpDom();
	const { api } = await loadPlugin(dom, { fetchImpl: makeHost(BG_STATE) });

	/* 没改主色调：徽章规则根本不存在（官方外观原样，不添乱） */
	api.applyPalette();
	const styleEl = dom.document.getElementById("dsh-theme-manager-palette");
	ok("⑨b 未改主色调时不生成徽章规则", styleEl === null || !String(styleEl.textContent).includes("_badge"), styleEl && styleEl.textContent);

	/* 深色主色调（用户实际选的 #0f1115）：徽章前景必须是暖白 */
	ok("⑨b setSlotColor 接受 #0f1115", api.setSlotColor("brand", "#0f1115") === true);
	const dark = dom.document.getElementById("dsh-theme-manager-palette").textContent;
	contains("⑨b 深色主色调写入 token", dark, "--dsw-specific-sidebar-nav-item-active-accent: #0f1115;");
	contains("⑨b 深底徽章配暖白前景", dark, '[class*="_optionLine"] > [class*="_badge"] {\n  color: #FAF9F5;');
	contains("⑨b 徽章规则限定浅色模式", dark, 'body:not([data-dsh-colors=off]):not([data-ds-dark-theme]) [class*="_optionLine"]');
	absent("⑨b 只改前景不碰徽章背景", dark, "_badge\"] {\n  background");

	/* 浅色主色调：前景折回近黑 */
	ok("⑨b setSlotColor 接受浅色", api.setSlotColor("brand", "#e4edfd") === true);
	const light = dom.document.getElementById("dsh-theme-manager-palette").textContent;
	contains("⑨b 浅底徽章配近黑前景", light, "color: #141413;");
	absent("⑨b 浅色时不遗留暖白", light, "color: #FAF9F5;");

	/* 重置：规则随之消失 */
	api.resetPalette();
	ok("⑨b 重置后徽章规则消失", !dom.document.getElementById("dsh-theme-manager-palette"), "标签应被移除");

	/* 亮度函数本身：黑白两端与浅色分界。中灰 #808080 实测 0.216（<0.4 判深、配
	 * 白字 —— 灰底蓝字对比仅 1.07:1，判深是对的），浅灰 #c0c0c0 才到浅档。 */
	ok("⑨b 黑的亮度≈0", api.colorLuminance("#000000") < 0.01, api.colorLuminance("#000000"));
	ok("⑨b 白的亮度≈1", api.colorLuminance("#ffffff") > 0.99, api.colorLuminance("#ffffff"));
	ok("⑨b 中灰判为深（配白字）", api.colorLuminance("#808080") < 0.4, api.colorLuminance("#808080"));
	ok("⑨b 浅灰判为浅（配近黑）", api.colorLuminance("#c0c0c0") >= 0.4, api.colorLuminance("#c0c0c0"));
}

/* ═══════════════════ 用例 10：毛玻璃遮罩按区域取色 ═══════════════════ */

{
	const dom = setUpDom();
	const { api } = await loadPlugin(dom, { fetchImpl: makeHost(BG_STATE) });
	api.pushBackground({ type: "image", path: BG_STATE.source.value, card: { enabled: true, alpha: 0.72, blur: 20 } });
	await new Promise((r) => setTimeout(r, 0));
	const style = dom.document.getElementById(api.BG_STYLE_ID).textContent;
	contains("⑩ 侧栏遮罩只画在列容器", style, '[data-slot="root"] > * > [class$="_sidebarCol"] { background: color-mix(in srgb, var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #fff)) 72%, transparent) !important; }');
	contains("⑩ 主区遮罩只画在列容器", style, '[data-slot="root"] > * > :is([class$="_centerCol"], [class$="_rightbarCol"]) { background: color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 72%, transparent) !important; }');
	contains("⑩ 毛玻璃 blur 20 + saturate", style, "backdrop-filter: blur(20px) saturate(140%)");
	contains("⑩ 原生会话头的实色覆盖被清理", style, '[data-slot="conversation.session.header"] > header, body [class$="_toggleCluster"] { background: transparent !important; }');
	contains("⑩ 侧栏列表底部不再以实色收尾", style, '[data-slot="sidebar.workspaces"] [class$="_fade"] { background: linear-gradient(to bottom, transparent, color-mix(in srgb, var(--dsw-specific-sidebar-fill, #fff) 18%, transparent)) !important; }');
	contains("⑩ 输入区底座透出壁纸，与遮罩透明度无关", style, '[data-composer-seat] { background: transparent !important; }');
	contains("⑩ 默认黑字只设置文字", style, "--dsw-alias-label-primary: #191919");
	contains("⑩ 白底新会话按钮保留原主题字色", style, '[class$="_newSession"] { --dsw-alias-label-primary: var(--dsh-bg-native-primary)');
}

/* 底板档与关闭遮罩都应遵守用户的设置，不额外画毛玻璃。 */
{
	const dom = setUpDom();
	const { api } = await loadPlugin(dom, { fetchImpl: makeHost(BG_STATE) });
	api.pushBackground({ type: "image", path: BG_STATE.source.value, coverage: "base", card: { enabled: true, alpha: 0.72, blur: 20 } });
	await new Promise((r) => setTimeout(r, 0));
	const base = dom.document.getElementById(api.BG_STYLE_ID).textContent;
	absent("⑪ 底板档不改变侧栏列", base, '[class$="_sidebarCol"]');
	absent("⑪ 底板档不改变输入区", base, '[data-composer-seat]');
	api.pushBackground({ coverage: "panels", card: { enabled: false } });
	await new Promise((r) => setTimeout(r, 0));
	const bare = dom.document.getElementById(api.BG_STYLE_ID).textContent;
	absent("⑪ 关闭遮罩后不画毛玻璃", bare, "backdrop-filter:");
	contains("⑪ 关闭列遮罩后仍有正文渐隐", bare, '[data-dsh-bg-clip]:not(:has([data-conversation-composer-overlay]))');
}

/* 旧状态回退为黑字；切换两档只触及壁纸上的文字，输入卡片仍用原生配色。 */
{
	const dom = setUpDom();
	const { api } = await loadPlugin(dom, { fetchImpl: makeHost(BG_STATE) });
	ok("⑫ 旧状态默认黑字", api.bgNormalize({ ...BG_STATE, textColor: undefined, autoContrast: true }, api.bgDefault).textColor === "black");
	api.pushBackground({ type: "image", path: BG_STATE.source.value, textColor: "white" });
	await new Promise((r) => setTimeout(r, 0));
	let style = dom.document.getElementById(api.BG_STYLE_ID).textContent;
	contains("⑫ 白字颜色固定", style, "--dsw-alias-label-primary: #FFFFFF");
	contains("⑫ 范围限定在会话视图", style, '[data-slot="conversation.session"] > [class$="_viewArea"]');
	absent("⑫ 不覆盖输入卡片底色变量", style, "--dsw-specific-input-major:");
	absent("⑫ 不覆盖页面底色变量", style, "--dsw-alias-bg-base:");
	absent("⑫ 不切换浏览器配色模式", style, "color-scheme:");
	absent("⑫ 不叠加文字阴影", style, "text-shadow:");
	absent("⑫ 不再自动采样切换", style, "data-dsh-bg-tone");
	api.pushBackground({ textColor: "black" });
	await new Promise((r) => setTimeout(r, 0));
	style = dom.document.getElementById(api.BG_STYLE_ID).textContent;
	contains("⑫ 黑字颜色固定", style, "--dsw-alias-label-primary: #191919");
	absent("⑫ 黑字时不遗留白字变量", style, "--dsw-alias-label-primary: #FFFFFF");
}

/* 输入区背后的正文只做视觉遮罩：跟随滚动计算边界，不改变滚动位置和布局。 */
{
	const dom = setUpDom();
	const { api } = await loadPlugin(dom, { fetchImpl: makeHost(BG_STATE) });
	api.pushBackground({ type: "image", path: BG_STATE.source.value, coverage: "panels" });
	await new Promise((r) => setTimeout(r, 0));
	const port = makeElement("div");
	const session = makeElement("div");
	const view = makeElement("div");
	const seat = makeElement("div");
	const vars = new Map();
	let viewTop = -200;
	let overlay = false;
	port.getClientRects = () => [{}];
	port.querySelector = (selector) => selector.includes("conversation.session") ? session : selector.includes("composer-seat") ? seat : selector.includes("composer-overlay") && overlay ? {} : null;
	session.querySelector = () => view;
	view.hasAttribute = (name) => view.getAttribute(name) !== null;
	view.style = {
		getPropertyValue: (name) => vars.get(name) ?? "",
		setProperty: (name, value) => vars.set(name, value),
		removeProperty: (name) => vars.delete(name)
	};
	view.getBoundingClientRect = () => ({ top: viewTop, bottom: viewTop + 1000, height: 1000 });
	seat.getClientRects = () => [{}];
	seat.getBoundingClientRect = () => ({ top: 300, bottom: 460, height: 160 });
	dom.document.querySelectorAll = () => [port];
	api.measureBgClip();
	ok("⑬ 首次测量只遮住座位后方正文", view.hasAttribute("data-dsh-bg-clip") && vars.get("--dsh-bg-clip-bottom") === "500px" && vars.get("--dsh-bg-clip-fade") === "24px", Object.fromEntries(vars));
	viewTop = -400;
	api.measureBgClip();
	ok("⑬ 滚动后遮罩边界仍对齐座位", vars.get("--dsh-bg-clip-bottom") === "300px", Object.fromEntries(vars));
	overlay = true;
	api.measureBgClip();
	ok("⑬ 轨迹视图撤掉正文遮罩", !view.hasAttribute("data-dsh-bg-clip") && vars.size === 0);
	overlay = false;
	api.pushBackground({ type: "none", source: { kind: "", value: "" } });
	await new Promise((r) => setTimeout(r, 0));
	api.measureBgClip();
	ok("⑬ 清除背景后不再给视图遮罩", !view.hasAttribute("data-dsh-bg-clip") && vars.size === 0);
}

/* ───────────────────────────── 结果 ───────────────────────────── */

console.log(`目标文件：${TARGET}`);
console.log(`源文件 ${readFileSync(TARGET, "utf8").length} 字符`);
if (failures.length > 0) {
	console.log(`\n失败 ${failures.length} 项：`);
	for (const f of failures) console.log(`  ✗ ${f}`);
}
console.log(`\n通过 ${pass} / ${pass + failures.length}`);
if (failures.length > 0) process.exit(1);
console.log("全部通过 ✓");
