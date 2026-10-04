// dsh-theme-manager — browser half（v0.9.0：窄口径）
//
// 只做三件事：
//   ① 设置 → 左侧导航「主题」的**两个颜色槽** —— 主色调（品牌 / 强调色）与背景色
//      （页面底色）。用户改过的槽位写进独立一张 `<style id="dsh-theme-manager-palette">`，
//      选择器特异性 (0,2,2) 高于主题层，主题重建也盖不掉；只作用于浅色模式。
//   ② 同一页的**页面背景（图片 / 视频）** —— 本地文件（字节由 host 代理）或网络地址，
//      适配 / 透出范围 / 不透明度 / 模糊 / 暗化 / 壁纸文字颜色 / 毛玻璃遮罩。
//      权威状态在 host（`$DSH_HOME/state/theme-manager/background.json`），
//      localStorage 只是首屏缓存；页面每 4s + 回到前台时拉一次。
//   ③ 并入的**「界面定制」段**（`settings.general.item` 里一行 + `shell.overlay` 的圆角
//      卡片）：对话内容宽度 / 对话字号 / 工作区字号 / UI 字体 / 圆角卡片，状态键仍是
//      `harness-ui-enhancer.state`。
//
// v0.9.0 删掉的（都写过、也被踩过，记在这里免得再有人加回来）：
//   · **主题层逐层开关面板** —— 扫描页面上定义了 `--dsw-*` 的 `<style>` 并逐层开关
//     （`style.disabled` + 接管 + MutationObserver 自愈）。它管的是「样式层」而不是
//     颜色 / 背景，与「设置 → 插件」职责重叠；连带 `off.v1` / `managed.v1` 两个
//     localStorage 键一起停用。
//   · **菜单分组标题修补** —— 模型选择菜单里组名的吸顶与叠色两档，属布局修补。
//   · **调色盘其余 7 个槽 + 6 套配色预设** —— 只留主色调与背景色。
//   · 内联段里的**官方 UI 规范化**（顶部栏单行化、按钮胶囊族、设置页头统一、原生
//     `title` 气泡）与**插件视觉协调**（better-sidebar、genui、第三方设置页补间距）。
//     内联段因此不再是上游逐字副本：`tools/inline-harmonizer.mjs` 与 `tools/vendor/`
//     已删除，改这一段直接改本文件即可。
//   保留的是内联段里 5 条**布局让位**规则（按 `--dsh-sidebar-width` 给右侧栏让位）：
//   它们不是外观美化，删掉会让右侧文件面板盖住内容。
//
// 卸载/回滚：删掉 profile `cordis.patch.yml` 里 id 为 theme-manager 的 insert 行
// + 重启应用；颜色与背景状态只在本机（localStorage / 状态文件），不写入任何插件配置。
window.__ModuleLoader__.load({
	id: "dsh-theme-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/** 本插件自己的样式标签：带这个属性，扫描时排除自己。 */
		const OWN_ATTR = "data-dsh-theme-manager";
		const STYLE_ID = "dsh-theme-manager-style";

		/* ── 调色盘 ─────────────────────────────────────────────────────
		 * 用户选的每个颜色写进一张**独立**的 <style data-dsh-theme-manager="palette">，
		 * 选择器比主题的 COLOR_CSS 高一级（`html body:not(...)` = (0,2,2) 压 (0,1,1)），
		 * 所以主题层重建、或顺序变化都不会盖掉用户调的颜色。只作用于浅色模式：
		 * 暗色模式是另一套 token，混用会很难看。 */
		const PALETTE_KEY = "dsh-theme-manager:palette.v1";
		const PALETTE_STYLE_ID = "dsh-theme-manager-palette";
		const PALETTE_TAG = "palette";

		/** 调色盘槽位：一个槽 = 用户眼里的一个颜色 = 一组同族 token。
		 *  只留两个：主色调（品牌/强调色）与背景色（页面底色）。其余槽位（浮层 / 次级底色 /
		 *  气泡 / 文字三档 / 边框）不归「主题管理器」管，已删除。 */
		const PALETTE_SLOTS = [
			{
				key: "brand",
				label: "主色调",
				hint: "新会话按钮、选中态、侧栏高亮",
				tokens: ["--dsw-alias-brand-primary", "--dsw-alias-button-primary-fill", "--dsw-specific-sidebar-nav-item-active-accent"],
				fallback: "#D97757"
			},
			{
				key: "bg",
				label: "背景色",
				hint: "会话区 / 侧栏底（壁纸盖在上面时，也决定毛玻璃遮罩的颜色）",
				tokens: ["--dsw-alias-bg-base", "--dsw-alias-bg-layer-1", "--dsw-specific-sidebar-fill"],
				fallback: "#FAF9F5"
			}
		];

		/* ───────────────────────── 状态存储 ───────────────────────── */

		/** 调色盘：{ 槽位 key: CSS 颜色 } —— 只存用户改过的槽位。 */
		function readPalette() {
			try {
				const raw = window.localStorage.getItem(PALETTE_KEY);
				if (raw === null) return {};
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
				const out = {};
				for (const slot of PALETTE_SLOTS) {
					const value = parsed[slot.key];
					if (typeof value === "string" && value.trim() !== "") out[slot.key] = normalizeColor(value) || value.trim();
				}
				return out;
			} catch (error) {
				return {};
			}
		}

		function persistPalette() {
			try {
				window.localStorage.setItem(PALETTE_KEY, JSON.stringify(palette));
			} catch (error) {
				/* 同上：写不进去也仍然当场生效 */
			}
		}

		let palette = readPalette();
		const listeners = new Set();
		let snapshot = { palette: {}, bg: null, bgNotice: null, version: 0 };

		function subscribe(callback) {
			listeners.add(callback);
			return () => {
				listeners.delete(callback);
			};
		}

		function getSnapshot() {
			return snapshot;
		}

		function emit() {
			for (const callback of Array.from(listeners)) {
				try {
					callback();
				} catch (error) {
					/* 单个订阅者出错不影响其它 */
				}
			}
		}

		function refresh() {
			snapshot = {
				palette: Object.assign({}, palette),
				bg: bg,
				bgNotice: bgNotice,
				version: snapshot.version + 1
			};
			emit();
		}
		/* ───────────────────────── 调色盘 ───────────────────────── */

		/** 校验并规范化用户输入的颜色（支持 #RGB / #RRGGBB / #RRGGBBAA / rgb() / rgba()）。 */
		function normalizeColor(value) {
			if (typeof value !== "string") return null;
			const text = value.trim();
			if (text === "") return null;
			if (typeof document !== "undefined" && document.body && typeof document.createElement === "function") {
				try {
					const probe = document.createElement("span");
					if (probe && probe.style) {
						probe.style.color = "";
						probe.style.color = text;
						if (probe.style.color !== "") return text;
					}
				} catch (error) {
					/* 落到下面的正则兜底 */
				}
			}
			return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text) || /^rgba?\([\d.,\s%/]+\)$/i.test(text) ? text : null;
		}

		/** `<input type="color">` 只吃 #rrggbb，其它形态（含 alpha）折成 6 位。 */
		function toHex6(value) {
			const text = String(value === undefined || value === null ? "" : value).trim();
			const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text);
			if (hex) {
				const body = hex[1];
				if (body.length === 3) return ("#" + body[0] + body[0] + body[1] + body[1] + body[2] + body[2]).toLowerCase();
				return ("#" + body.slice(0, 6)).toLowerCase();
			}
			const rgb = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(text);
			if (rgb) {
				const part = (n) => {
					const v = Math.max(0, Math.min(255, Math.round(Number(n))));
					return (v < 16 ? "0" : "") + v.toString(16);
				};
				return "#" + part(rgb[1]) + part(rgb[2]) + part(rgb[3]);
			}
			return "#000000";
		}

		/** 槽位当前生效的颜色：用户改过就用用户的，否则读 body 上的实际计算值。 */
		function slotValue(slot) {
			if (palette[slot.key]) return palette[slot.key];
			try {
				if (typeof window !== "undefined" && typeof window.getComputedStyle === "function" && document.body) {
					const value = window.getComputedStyle(document.body).getPropertyValue(slot.tokens[0]);
					if (value && value.trim() !== "") return value.trim();
				}
			} catch (error) {
				/* 读不到就用 fallback */
			}
			return slot.fallback;
		}

		function paletteCss() {
			const rows = [];
			for (const slot of PALETTE_SLOTS) {
				const color = palette[slot.key];
				if (!color) continue;
				for (const token of slot.tokens) rows.push("  " + token + ": " + color + ";");
			}
			/* ⚠️ v0.4.1–v0.5.0 在这里**无条件** push 过两条：
			 *     --dsw-menu-surface-fill: var(--dsw-alias-bg-base, #FAF9F5);
			 *     --dsw-menu-backdrop-filter: none;
			 * 效果是把「模型选择 / 右键菜单」这类 MenuSurface 浮层，从官方的
			 * 「半透明 rgba(248,249,250,.58) + blur(40px) saturate(150%) 毛玻璃」
			 * 换成不透明的页面底色。因为调色盘 style 标签**恒存在**（哪怕一个颜色
			 * 都没改），这两条对页面上所有菜单都生效 —— 用户实测反馈「弹窗样式被
			 * 污染了」。v0.6.0 起不再无条件覆盖：菜单回到官方外观。
			 * 教训：别用「恒存在的标签写死 token」实现某个浮层的定制 —— 它既没有
			 * 开关，也没法只作用于目标浮层。 */
			if (rows.length === 0) return "";
			return [
				"/* dsh-theme-manager 调色盘：只列用户改过的槽位；特异性 (0,2,2) 高于主题层 (0,1,1)，与加载顺序无关 */",
				"html body:not([data-dsh-colors=off]):not([data-ds-dark-theme]) {",
				rows.join("\n"),
				"}"
			].join("\n");
		}

		function applyPalette() {
			if (typeof document === "undefined" || !document.head) return;
			const css = paletteCss();
			let el = document.getElementById(PALETTE_STYLE_ID);
			if (css === "") {
				if (el !== null && typeof el.remove === "function") el.remove();
				return;
			}
			if (el === null) {
				el = document.createElement("style");
				el.id = PALETTE_STYLE_ID;
				el.setAttribute(OWN_ATTR, PALETTE_TAG);
				document.head.appendChild(el);
			}
			if (el.textContent !== css) el.textContent = css;
		}

		/** 设一个槽位的颜色。返回 false = 输入不是合法 CSS 颜色（调用方负责标红）。 */
		function setSlotColor(key, value) {
			const color = normalizeColor(value);
			if (color === null) return false;
			palette[key] = color;
			persistPalette();
			applyPalette();
			refresh();
			return true;
		}

		function resetSlot(key) {
			if (!(key in palette)) return;
			delete palette[key];
			persistPalette();
			applyPalette();
			refresh();
		}

		function resetPalette() {
			if (Object.keys(palette).length === 0) return;
			palette = {};
			persistPalette();
			applyPalette();
			refresh();
		}

		function install() {
			applyPalette();
			refresh();
		}
		/* ───────────────────── 页面背景（图片 / 视频） ─────────────────────
		 * 这是本插件里**唯一需要 host 参与**的功能：媒体文件在本机磁盘上，而渲染
		 * 进程读不到 `file://`（桌面外壳的 webRequest 只放行 about/data/blob），
		 * 所以状态与字节都走 host 半边的 `/dsh-theme-manager/*` 路由：
		 *   · GET  /dsh-theme-manager/state      读状态（带 revision，用来判变化）
		 *   · POST /dsh-theme-manager/background 写状态（外部软件调的是同一个端点）
		 *   · GET  /dsh-theme-manager/media      当前媒体文件（支持 Range → 视频可拖进度）
		 * 页面里用**相对路径**：它会解析成 `dsh-app://app/...`，由桌面外壳转发给
		 * host（与 dsh-preset-hotswap 同一机制），于是没有跨源 / CSP / 端口问题。
		 *
		 * 两处状态源：host 的 JSON 是权威，localStorage 只是首屏缓存 —— 页面打开的
		 * 瞬间先按缓存把背景画上，拿到 host 状态后再校正，避免闪一下白底。
		 */
		const BG_KEY = "dsh-theme-manager:bg.v1";
		const BG_LAYER_ID = "dsh-theme-manager-bg-layer";
		const BG_STYLE_ID = "dsh-theme-manager-background";
		const BG_API = "/dsh-theme-manager";
		const BG_POLL_MS = 4000;
		const BG_FITS = ["cover", "contain", "fill", "auto"];
		const BG_COVERAGE = ["base", "panels", "full"];
		const BG_DEFAULT = {
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
			card: { enabled: true, alpha: 0.72, blur: 20 },
			updatedAt: null
		};

		/** 把任意输入夹成一份**结构完整**的背景状态（缺字段用默认值补齐）。 */
		function bgNormalize(input, base) {
			const prev = base === undefined || base === null ? BG_DEFAULT : base;
			const raw = input !== null && typeof input === "object" ? input : {};
			const out = {
				version: 1,
				revision: typeof prev.revision === "number" ? prev.revision : 0,
				type: typeof prev.type === "string" ? prev.type : "none",
				source: prev.source !== null && typeof prev.source === "object" ? { ...prev.source } : { kind: "", value: "" },
				fit: prev.fit ?? "cover",
				position: prev.position ?? "center",
				opacity: typeof prev.opacity === "number" ? prev.opacity : 1,
				blur: typeof prev.blur === "number" ? prev.blur : 0,
				dim: typeof prev.dim === "number" ? prev.dim : 0,
				coverage: prev.coverage ?? "panels",
				textColor: prev.textColor === "white" ? "white" : "black",
				video: { ...BG_DEFAULT.video, ...(prev.video ?? {}) },
				card: { ...BG_DEFAULT.card, ...(prev.card ?? {}) },
				updatedAt: prev.updatedAt ?? null
			};
			const source = raw.source !== null && typeof raw.source === "object" ? raw.source : {};
			if (typeof raw.type === "string" && ["none", "image", "video"].includes(raw.type.trim().toLowerCase())) out.type = raw.type.trim().toLowerCase();
			/* revision / updatedAt 由 host 维护：必须原样吃进来，否则媒体 URL 的版本号
			   永远停在 0，浏览器会拿旧缓存。 */
			if (typeof raw.revision === "number" && Number.isFinite(raw.revision)) out.revision = raw.revision;
			if (typeof raw.updatedAt === "string" && raw.updatedAt !== "") out.updatedAt = raw.updatedAt;
			if (typeof raw.path === "string") out.source = { kind: "path", value: raw.path.trim() };
			else if (typeof raw.url === "string") out.source = { kind: "url", value: raw.url.trim() };
			else if (typeof source.kind === "string" && typeof source.value === "string") out.source = { kind: source.kind, value: source.value };
			if (source.kind === "path" && typeof source.value === "string") out.source = { kind: "path", value: source.value.trim() };
			if (source.kind === "url" && typeof source.value === "string") out.source = { kind: "url", value: source.value.trim() };
			if (typeof raw.fit === "string" && BG_FITS.includes(raw.fit)) out.fit = raw.fit;
			if (typeof raw.coverage === "string" && BG_COVERAGE.includes(raw.coverage)) out.coverage = raw.coverage;
			if (raw.textColor === "white" || raw.textColor === "black") out.textColor = raw.textColor;
			if (typeof raw.position === "string" && raw.position.trim() !== "") out.position = raw.position.trim().toLowerCase();
			if (typeof raw.opacity === "number" && Number.isFinite(raw.opacity)) out.opacity = Math.max(0, Math.min(1, raw.opacity));
			if (typeof raw.blur === "number" && Number.isFinite(raw.blur)) out.blur = Math.max(0, Math.min(60, raw.blur));
			if (typeof raw.dim === "number" && Number.isFinite(raw.dim)) out.dim = Math.max(0, Math.min(1, raw.dim));
			const video = raw.video !== null && typeof raw.video === "object" ? raw.video : {};
			if (typeof video.loop === "boolean") out.video.loop = video.loop;
			if (typeof video.muted === "boolean") out.video.muted = video.muted;
			if (typeof video.rate === "number" && Number.isFinite(video.rate)) out.video.rate = Math.max(0.1, Math.min(4, video.rate));
			const card = raw.card !== null && typeof raw.card === "object" ? raw.card : {};
			if (typeof card.enabled === "boolean") out.card.enabled = card.enabled;
			if (typeof card.alpha === "number" && Number.isFinite(card.alpha)) out.card.alpha = Math.max(0, Math.min(1, card.alpha));
			if (typeof card.blur === "number" && Number.isFinite(card.blur)) out.card.blur = Math.max(0, Math.min(40, card.blur));
			if (out.source.value === "") out.type = "none";
			return out;
		}

		function readBgCache() {
			try {
				const raw = window.localStorage.getItem(BG_KEY);
				if (raw === null) return { ...BG_DEFAULT };
				return bgNormalize(JSON.parse(raw), BG_DEFAULT);
			} catch (error) {
				return { ...BG_DEFAULT };
			}
		}

		function persistBgCache() {
			try {
				window.localStorage.setItem(BG_KEY, JSON.stringify(bg));
			} catch (error) {
				/* 写不进去也仍然当场生效 */
			}
		}

		let bg = readBgCache();
		/** 「文件选择器给了 File 但拿不到绝对路径」时的临时预览（blob:），不写进 host。 */
		let bgPreview = "";
		/** host 回话里的 warning / 错误，直接显示在设置页上（外部软件与手填路径都会踩）。 */
		let bgNotice = null;
		let bgSyncTimer = null;

		/** 媒体地址：本地文件走 host 的媒体路由（带 revision 破缓存），网络地址直接用。
		 *  `bgPreview` 是「文件选择器给了 File 但拿不到真实路径」时的临时 blob 预览，
		 *  它只活在本次页面里，不会被写进 host 状态。 */
		function bgMediaUrl(state) {
			if (bgPreview !== "") return bgPreview;
			/* 地址只由**源**决定（路径进 query），不带 revision：换文件必然换地址，
			   而调模糊/不透明度这类参数不会换地址 —— 否则每拖一下滑块都要重新下载图片。 */
			if (state.source.kind === "path" && state.source.value !== "") return `${BG_API}/media?p=${encodeURIComponent(state.source.value)}`;
			if (state.source.kind === "url" && state.source.value !== "") return state.source.value;
			return "";
		}

		/** 0.2 shell 的三个列容器。只匹配列，不碰同级的浮层与拖拽手柄。 */
		const SHELL_BASE = '[data-slot="root"] > *';
		const SHELL_COLUMNS = '[data-slot="root"] > * > :is([class$="_sidebarCol"], [class$="_centerCol"], [class$="_rightbarCol"])';
		const SHELL_CONTENT = '[data-slot="sidebar"] > *, [data-slot="main"] > *, [data-slot="rightbar"] > *, [data-phase][class$="_root"]';
		/* 遮罩只画在整列上一次。过去把 [data-phase] 也当成底板，连输入框都
		   命中了；父子层各画一遍又会把图片洗成灰白。 */
		const CARD_SIDEBAR = '[data-slot="root"] > * > [class$="_sidebarCol"]';
		const CARD_MAIN = '[data-slot="root"] > * > :is([class$="_centerCol"], [class$="_rightbarCol"])';
		const BG_TEXT_SCOPE = `${CARD_SIDEBAR}, ${CARD_MAIN} [data-slot="conversation.session.header"], ${CARD_MAIN} [data-slot="conversation.session"] > [class$="_viewArea"]`;
		/**
		 * 背景层与「透出范围」的全部 CSS。
		 * 只透明官方 shell 底板，交互卡片与输入框保留原生表面。
		 * `coverage` 决定透明到哪一层：
		 *   base   只透明页面底板（html/body/#root + root 的子元素，即整页骨架层）；
		 *   panels 连各列容器与侧栏/主区的内容根一起透明 → 背景铺满整个窗口（推荐）；
		 *   full   再让输入框外壳透出。
		 * `card`（毛玻璃遮罩）默认打开：给各列铺一层半透明底 + backdrop 模糊，
		 * 颜色按区域取官方原本的底色（侧栏 `--dsw-specific-sidebar-fill`、主区 `--dsw-alias-bg-base`），
		 * 所以背景铺满之后正文照样读得清，色调也跟官方一致。关掉它就是纯透明。
		 */
		function bgCss(state) {
			const rows = [];
			const hasMedia = state.type !== "none" && bgMediaUrl(state) !== "";
			/* 清除背景后必须彻底退出覆盖，交还原生底色。 */
			if (!hasMedia) return "";
			rows.push("/* 页面底板透明：背景层在最底下，官方组件表面一律不碰 */");
			rows.push("html, body { background: transparent !important; }");
			rows.push("body > #root, [data-slot=\"root\"] { background: transparent !important; }");
			rows.push("/* 底板档：透明官方 shell 的整页骨架层 */");
			rows.push(`${SHELL_BASE} { background: transparent !important; }`);
			if (state.coverage === "panels" || state.coverage === "full") {
				rows.push("/* 面板档：列与页面内容根透明，保留浮层、拖拽手柄和输入控件 */");
				rows.push(`${SHELL_COLUMNS}, ${SHELL_CONTENT} { background: transparent !important; }`);
				rows.push('[data-slot="conversation"] { background: transparent !important; }');
				/* 内联合并的界面统一段会给会话 header 写入不透明背景。 */
				rows.push('[data-slot="conversation.session.header"] > header, body [class$="_toggleCluster"] { background: transparent !important; }');
				/* 工作区列表的原生底部 fade 在部分平台会以侧栏实色收尾，
				   背景模式下把它改成同色的轻过渡，避免侧栏底部亮条。 */
				rows.push('[data-slot="sidebar.workspaces"] [class$="_fade"] { background: linear-gradient(to bottom, transparent, color-mix(in srgb, var(--dsw-specific-sidebar-fill, #fff) 18%, transparent)) !important; }');
				/* 输入区保持透出壁纸；正文由下方的视图遮罩在座位边缘渐隐。
				   遮罩尚未安装时沿用官方渐变，避免启动瞬间文字穿过。 */
				rows.push('[data-conversation-scroll]:has([data-dsh-bg-clip]) > [data-composer-seat] { background: transparent !important; }');
				rows.push('[data-dsh-bg-clip]:not(:has([data-conversation-composer-overlay])) { mask-image: linear-gradient(to bottom, #000 0, #000 calc(100% - var(--dsh-bg-clip-bottom) - var(--dsh-bg-clip-fade)), transparent calc(100% - var(--dsh-bg-clip-bottom))); -webkit-mask-image: linear-gradient(to bottom, #000 0, #000 calc(100% - var(--dsh-bg-clip-bottom) - var(--dsh-bg-clip-fade)), transparent calc(100% - var(--dsh-bg-clip-bottom))); }');
			}
			if (state.coverage === "full") {
				/* 全部档的卡片把壁纸柔和透出；正文先在视图层被遮罩，无法穿过卡片。 */
				const inputAlpha = state.card.enabled ? Math.max(78, Math.min(96, Math.round(state.card.alpha * 100))) : 78;
				rows.push(`[data-composer-seat] [data-composer-card] { background: color-mix(in srgb, var(--dsw-specific-input-major, var(--dsw-alias-bg-base, #fff)) ${inputAlpha}%, transparent) !important; }`);
				if (state.card.enabled && state.card.blur > 0) {
					const inputBlur = Math.min(12, state.card.blur);
					rows.push(`[data-composer-seat] [data-composer-card] { backdrop-filter: blur(${inputBlur}px) saturate(120%); -webkit-backdrop-filter: blur(${inputBlur}px) saturate(120%); }`);
				}
			}
			if (state.card.enabled && state.coverage !== "base") {
				const alpha = Math.round(state.card.alpha * 100);
				rows.push("/* 毛玻璃遮罩每列仅画一次：侧栏取侧栏色，主区与右栏取页面底色。 */");
				rows.push(
					`${CARD_SIDEBAR} { background: color-mix(in srgb, var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #fff)) ${alpha}%, transparent) !important; }`
				);
				rows.push(
					`${CARD_MAIN} { background: color-mix(in srgb, var(--dsw-alias-bg-base, #fff) ${alpha}%, transparent) !important; }`
				);
				if (state.card.blur > 0) {
					rows.push(
						`${CARD_SIDEBAR}, ${CARD_MAIN} { backdrop-filter: blur(${state.card.blur}px) saturate(140%); -webkit-backdrop-filter: blur(${state.card.blur}px) saturate(140%); }`
					);
				}
			}
			if (state.coverage !== "base") {
				/* 只改壁纸上方的文字 token；背景、输入卡片和其它有底色的组件沿用原主题。 */
				const white = state.textColor === "white";
				rows.push(`:root { --dsh-bg-native-primary: var(--dsw-alias-label-primary, #191919); --dsh-bg-native-secondary: var(--dsw-alias-label-secondary, #414141); --dsh-bg-native-tertiary: var(--dsw-alias-label-tertiary, #626262); --dsh-bg-native-caption: var(--dsw-alias-label-caption, #737373); }`);
				rows.push(`${BG_TEXT_SCOPE} { --dsw-alias-label-primary: ${white ? "#FFFFFF" : "#191919"}; --dsw-alias-label-primary-bluish: ${white ? "#FFFFFF" : "#191919"}; --dsw-alias-label-primary-dimmed: ${white ? "#F2F2F2" : "#333333"}; --dsw-alias-label-secondary: ${white ? "#F2F2F2" : "#414141"}; --dsw-alias-label-tertiary: ${white ? "#E0E0E0" : "#626262"}; --dsw-alias-label-caption: ${white ? "#C9C9C9" : "#737373"}; color: var(--dsw-alias-label-primary); }`);
				/* 新会话按钮原本有白底，保留原主题的文字色。 */
				rows.push(`${CARD_SIDEBAR} [class$="_newSession"] { --dsw-alias-label-primary: var(--dsh-bg-native-primary); --dsw-alias-label-primary-bluish: var(--dsh-bg-native-primary); --dsw-alias-label-primary-dimmed: var(--dsh-bg-native-secondary); --dsw-alias-label-secondary: var(--dsh-bg-native-secondary); --dsw-alias-label-tertiary: var(--dsh-bg-native-tertiary); --dsw-alias-label-caption: var(--dsh-bg-native-caption); color: var(--dsw-alias-label-primary); }`);
			}
			/* 背基层自身的参数：适配方式 / 位置 / 不透明度 / 模糊 / 暗化。 */
			const media = [];
			media.push(`  object-fit: ${state.fit};`);
			media.push(`  object-position: ${state.position};`);
			if (state.blur > 0) media.push(`  filter: blur(${state.blur}px);`);
			media.push(`  opacity: ${state.opacity};`);
			/* 图片未加载、加载失败或不透明度低于 1 时有稳定的底色，
			   不会透出桌面透明窗口或一块不可控的白底。 */
			rows.push(`#${BG_LAYER_ID} { position: fixed; inset: 0; z-index: 0; overflow: hidden; pointer-events: none; background: var(--dsw-alias-bg-base, #fff); }`);
			rows.push(`#${BG_LAYER_ID} > img, #${BG_LAYER_ID} > video { position: absolute; inset: 0; width: 100%; height: 100%; display: block;${state.blur > 0 ? ` transform: scale(${(1 + state.blur / 100).toFixed(3)});` : ""} }`);
			rows.push(`#${BG_LAYER_ID} > img {${media.join("")} }`);
			rows.push(`#${BG_LAYER_ID} > video {${media.join("")} }`);
			if (state.dim > 0) {
				rows.push(`#${BG_LAYER_ID}::after { content: ""; position: absolute; inset: 0; background: rgba(0, 0, 0, ${state.dim}); }`);
			}
			return rows.join("\n");
		}

		/**
		 * 把背景状态落到 DOM（幂等）。
		 * 层插在 body 的第一个子节点：文档顺序上早于 #root，因此永远在内容之下，
		 * 不需要动任何 z-index / 层叠上下文（官方弹窗 portal 到 body 也照常在最上）。
		 */
		function applyBackground() {
			if (typeof document === "undefined" || !document.head) return;
			let style = document.getElementById(BG_STYLE_ID);
			const css = bgCss(bg);
			if (style === null) {
				style = document.createElement("style");
				style.id = BG_STYLE_ID;
				style.setAttribute(OWN_ATTR, "background");
				document.head.appendChild(style);
			}
			if (style.textContent !== css) style.textContent = css;
			scheduleBgClip();

			const url = bg.type === "none" ? "" : bgMediaUrl(bg);
			let layer = document.getElementById(BG_LAYER_ID);
			if (url === "") {
				if (layer !== null && typeof layer.remove === "function") layer.remove();
				return;
			}
			if (document.body === null) return;
			if (layer === null) {
				layer = document.createElement("div");
				layer.id = BG_LAYER_ID;
				layer.setAttribute(OWN_ATTR, "background");
				layer.setAttribute("aria-hidden", "true");
				if (document.body.firstChild !== null) document.body.insertBefore(layer, document.body.firstChild);
				else document.body.appendChild(layer);
			}
			const wantTag = bg.type === "video" ? "video" : "img";
			let media = layer.firstElementChild;
			if (media === null || media.tagName.toLowerCase() !== wantTag || media.getAttribute("data-src") !== url) {
				/* 只有「类型或地址变了」才重建元素：重建 <video> 会重新缓冲，
				   而调不透明度 / 模糊这类参数只该改 CSS。 */
				if (media !== null) media.remove();
				media = document.createElement(wantTag);
				media.setAttribute("data-src", url);
				media.setAttribute("aria-hidden", "true");
				if (wantTag === "img") {
					media.alt = "";
					media.decoding = "async";
					media.src = url;
				} else {
					media.muted = bg.video.muted !== false;
					media.loop = bg.video.loop !== false;
					media.autoplay = true;
					media.playsInline = true;
					media.preload = "auto";
					media.src = url;
					media.playbackRate = bg.video.rate ?? 1;
					/* 自动播放可能被拦（muted 一般不会）：拦了不影响静态首帧。 */
					const started = media.play?.();
					if (started !== undefined && typeof started.catch === "function") started.catch(() => {});
				}
				if (layer.firstChild !== null) layer.insertBefore(media, layer.firstChild);
				else layer.appendChild(media);
			} else if (wantTag === "video") {
				if (media.muted !== (bg.video.muted !== false)) media.muted = bg.video.muted !== false;
				if (media.loop !== (bg.video.loop !== false)) media.loop = bg.video.loop !== false;
				if (media.playbackRate !== (bg.video.rate ?? 1)) media.playbackRate = bg.video.rate ?? 1;
			}
			applyCoverage();
		}

		/** coverage 档位变了要重算 CSS，但媒体元素本身不动。 */
		function applyCoverage() {
			if (typeof document === "undefined" || !document.head) return;
			const style = document.getElementById(BG_STYLE_ID);
			if (style === null) return;
			const css = bgCss(bg);
			if (style.textContent !== css) style.textContent = css;
			scheduleBgClip();
		}

		/* 官方滚动区让正文从 sticky 输入区后方经过。背景开启时，不应把整条输入区
		 * 涂白；只需在视图层把进入输入区的正文渐隐，壁纸仍由底层连续绘制。
		 * 滚动 / 高速流式增长最多合并成每帧一次测量，不改 scrollTop 或布局尺寸。 */
		const BG_CLIP_ATTR = "data-dsh-bg-clip";
		let bgClipInstalled = false;
		let bgClipPort = null;
		let bgClipView = null;
		let bgClipSeat = null;
		let bgClipResize = null;
		let bgClipChildren = null;
		let bgClipRoot = null;
		let bgClipFrame = 0;

		function bgClipEnabled() {
			return bg.type !== "none" && bgMediaUrl(bg) !== "" && bg.coverage !== "base";
		}

		function clearBgClipView(view) {
			if (view === null) return;
			view.removeAttribute(BG_CLIP_ATTR);
			view.style.removeProperty("--dsh-bg-clip-bottom");
			view.style.removeProperty("--dsh-bg-clip-fade");
		}

		function detachBgClip() {
			if (bgClipPort !== null) bgClipPort.removeEventListener("scroll", scheduleBgClip);
			if (bgClipResize !== null) bgClipResize.disconnect();
			if (bgClipChildren !== null) bgClipChildren.disconnect();
			clearBgClipView(bgClipView);
			bgClipPort = bgClipView = bgClipSeat = bgClipResize = bgClipChildren = null;
		}

		function bindBgClip() {
			if (!bgClipEnabled() || typeof document === "undefined") {
				detachBgClip();
				return;
			}
			const ports = Array.from(document.querySelectorAll("[data-conversation-scroll]"));
			const port = ports.find((el) => el.getClientRects().length > 0) ?? ports[0] ?? null;
			const session = port?.querySelector(':scope > [data-slot="conversation.session"]') ?? null;
			const view = session?.querySelector(':scope > [class$="_viewArea"]') ?? null;
			const seat = port?.querySelector(":scope > [data-composer-seat]") ?? null;
			if (port === bgClipPort && view === bgClipView && seat === bgClipSeat) return;
			detachBgClip();
			if (port === null || view === null || seat === null) return;
			bgClipPort = port;
			bgClipView = view;
			bgClipSeat = seat;
			port.addEventListener("scroll", scheduleBgClip, { passive: true });
			if (typeof ResizeObserver !== "undefined") {
				bgClipResize = new ResizeObserver(scheduleBgClip);
				bgClipResize.observe(port);
				bgClipResize.observe(view);
				bgClipResize.observe(seat);
			}
			if (typeof MutationObserver !== "undefined") {
				bgClipChildren = new MutationObserver(scheduleBgClip);
				bgClipChildren.observe(port, { childList: true });
				bgClipChildren.observe(session, { childList: true });
				bgClipChildren.observe(view, { childList: true });
			}
		}

		function measureBgClip() {
			bindBgClip();
			const view = bgClipView;
			const seat = bgClipSeat;
			const port = bgClipPort;
			if (view === null || seat === null || port === null) return;
			if (port.querySelector("[data-conversation-composer-overlay]") !== null || seat.getClientRects().length === 0) {
				clearBgClipView(view);
				return;
			}
			const viewBox = view.getBoundingClientRect();
			const seatBox = seat.getBoundingClientRect();
			if (viewBox.height <= 0 || seatBox.height <= 0) {
				clearBgClipView(view);
				return;
			}
			const visible = Math.max(0, Math.min(viewBox.height, Math.floor(seatBox.top - viewBox.top)));
			const hidden = Math.max(0, Math.ceil(viewBox.height - visible));
			const fade = hidden > 0 ? Math.min(24, visible) : 0;
			const bottom = `${hidden}px`;
			const fadeValue = `${fade}px`;
			if (view.style.getPropertyValue("--dsh-bg-clip-bottom") !== bottom) view.style.setProperty("--dsh-bg-clip-bottom", bottom);
			if (view.style.getPropertyValue("--dsh-bg-clip-fade") !== fadeValue) view.style.setProperty("--dsh-bg-clip-fade", fadeValue);
			if (!view.hasAttribute(BG_CLIP_ATTR)) view.setAttribute(BG_CLIP_ATTR, "");
		}

		function scheduleBgClip() {
			if (!bgClipInstalled || bgClipFrame !== 0 || typeof window?.requestAnimationFrame !== "function") return;
			bgClipFrame = window.requestAnimationFrame(() => {
				bgClipFrame = 0;
				measureBgClip();
			});
		}

		function installBgClip() {
			if (bgClipInstalled || typeof document === "undefined" || document.body === null || typeof window?.requestAnimationFrame !== "function") return;
			bgClipInstalled = true;
			if (typeof MutationObserver !== "undefined") {
				bgClipRoot = new MutationObserver(() => {
					if (!bgClipEnabled()) return;
					if (bgClipPort === null || !bgClipPort.isConnected || bgClipView === null || !bgClipView.isConnected || bgClipSeat === null || !bgClipSeat.isConnected) scheduleBgClip();
				});
				bgClipRoot.observe(document.body, { childList: true, subtree: true });
			}
			window.addEventListener("resize", scheduleBgClip);
			scheduleBgClip();
		}

		/** 本地先应用（乐观更新）：设置页点一下就立刻有反馈，不必等 host 往返。 */
		function setBgLocal(next) {
			bg = bgNormalize(next, bg);
			persistBgCache();
			applyBackground();
			refresh();
		}

		/**
		 * 写状态：先本地应用，再 POST 给 host（host 是权威，回包里的 revision /
		 * 归一化结果会覆盖本地那份）。失败时把 host 的错误留在面板上，但**不回滚**
		 * 本地视觉 —— 页面这一侧自洽，只是没落到磁盘。
		 */
		async function pushBackground(patch) {
			const merged = bgNormalize(patch, bg);
			bgPreview = "";
			setBgLocal(merged);
			bgNotice = { kind: "pending", text: "写入中…" };
			refresh();
			try {
				const res = await fetch(`${BG_API}/background`, {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-DSH-Theme-Source": "settings-page" },
					body: JSON.stringify(patch)
				});
				const data = await res.json().catch(() => ({}));
				if (!res.ok || data.ok !== true) throw new Error(data.error || `HTTP ${res.status}`);
				bg = bgNormalize(data.background, bg);
				persistBgCache();
				applyBackground();
				const warning = Array.isArray(data.warning) && data.warning.length > 0 ? data.warning.join("；") : null;
				bgNotice = warning === null ? { kind: "ok", text: "已保存到本机（host 侧）" } : { kind: "warn", text: warning };
			} catch (error) {
				bgNotice = { kind: "error", text: `host 写入失败：${String(error?.message ?? error)}` };
			}
			refresh();
			return bgNotice;
		}

		/** 拉一次 host 状态；revision 变了才重建 DOM（避免每次轮询都动 <video>）。 */
		async function pullBackground() {
			if (typeof fetch !== "function") return;
			try {
				const res = await fetch(`${BG_API}/state`, { headers: { Accept: "application/json" } });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = await res.json();
				const next = bgNormalize(data.background, BG_DEFAULT);
				const changed = next.revision !== bg.revision || next.type !== bg.type || next.source.value !== bg.source.value || next.updatedAt !== bg.updatedAt;
				bg = next;
				persistBgCache();
				if (changed) {
					/* 外部（别的软件 / 另一个页面）改过背景：放弃本页的临时预览，听 host 的。 */
					if (bgPreview !== "") bgPreview = "";
					applyBackground();
					refresh();
				}
			} catch (error) {
				/* host 没起来（例如插件只挂了一半）时静默：背景层仍按缓存渲染。 */
			}
		}

		/** 轮询 + 回到前台立刻对齐：外部软件改了背景，页面最迟 BG_POLL_MS 后跟上。 */
		function startBackgroundSync() {
			if (bgSyncTimer !== null) return;
			if (typeof window === "undefined" || typeof window.setInterval !== "function") return;
			bgSyncTimer = window.setInterval(() => {
				if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
				pullBackground();
			}, BG_POLL_MS);
			document.addEventListener("visibilitychange", () => {
				if (document.visibilityState === "visible") pullBackground();
			});
		}

		/**
		 * 页面内的程序化接口。HTTP 是本插件对外的正式接口，这个全局函数只是
		 * 「页面里顺手调试」的旁路（DevTools、自动化脚本、别的 client 插件都能用）。
		 */
		function installBackgroundApi() {
			if (typeof window === "undefined") return;
			const api = {
				version: "0.8.6",
				endpoint: BG_API,
				get: () => JSON.parse(JSON.stringify(bg)),
				set: (patch) => pushBackground(patch),
				image: (value, extra) => pushBackground({ type: "image", ...(isRemote(value) ? { url: value } : { path: value }), ...(extra ?? {}) }),
				video: (value, extra) => pushBackground({ type: "video", ...(isRemote(value) ? { url: value } : { path: value }), ...(extra ?? {}) }),
				clear: () => pushBackground({ type: "none", source: { kind: "", value: "" } }),
				refresh: () => pullBackground()
			};
			window.__dshTheme = api;
		}

		function isRemote(value) {
			return typeof value === "string" && /^(https?:)?\/\//i.test(value.trim());
		}

		/** 背景功能的启动顺序：先按缓存画上（首屏不闪），再对齐 host，最后开轮询与页面接口。 */
		function installBackground() {
			applyBackground();
			installBgClip();
			installBackgroundApi();
			startBackgroundSync();
			pullBackground();
		}

		/** host 的监听端口：设置页要把「外部软件该打哪个地址」写清楚，只能问 host 自己
		 *  （页面在桌面外壳里的 origin 是 dsh-app://app，推不出端口）。 */
		let bgApiPort = null;
		async function probeApiPort() {
			try {
				const res = await fetch(`${BG_API}/health`, { headers: { Accept: "application/json" } });
				const data = await res.json();
				bgApiPort = typeof data.port === "number" && data.port > 0 ? data.port : null;
			} catch (error) {
				bgApiPort = null;
			}
			return bgApiPort;
		}

		/** 外部软件用的基址；拿不到端口时给一个占位（配置页里会写明）。 */
		function apiOrigin() {
			try {
				const loc = window.location;
				if (loc && (loc.protocol === "http:" || loc.protocol === "https:") && loc.host) return `${loc.protocol}//${loc.host}`;
			} catch (error) {
				/* 桌面外壳：走下面的端口 */
			}
			return bgApiPort === null ? "http://127.0.0.1:<DSH 端口>" : `http://127.0.0.1:${bgApiPort}`;
		}

		/* ───────────────────────── 设置页样式 ───────────────────────── */

		const CSS = [
			/* 0.2 的轨迹视图用 data-conversation-composer-overlay 要求把常驻输入区
			   绝对定位在内容上。这里按原生语义标记隐藏座位，不依赖页签文字或排序；
			   编辑器和草稿仍保留在 DOM 中，切回对话即可继续输入。 */
			'[data-conversation-scroll]:has([data-conversation-composer-overlay]) > [data-composer-seat]{display:none!important}',
			".dsh-theme-manager-root{display:flex;flex-direction:column;gap:16px;padding:2px 2px 28px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}",
			".dsh-theme-manager-intro-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dsh-theme-manager-group{border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-base);overflow:hidden}",
			".dsh-theme-manager-group-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}",
			".dsh-theme-manager-group-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
			".dsh-theme-manager-group-count{font-size:11px;color:var(--dsw-alias-label-caption)}",
			".dsh-theme-manager-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border-top:0.5px solid var(--dsw-alias-border-l1)}",
			".dsh-theme-manager-row:first-of-type{border-top:none}",
			".dsh-theme-manager-row-main{flex:1;min-width:0}",
			".dsh-theme-manager-row-name{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-theme-manager-row-meta{margin-top:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-theme-manager-mini{flex:none;height:26px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}",
			".dsh-theme-manager-mini:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-theme-manager-switch{flex:none;position:relative;box-sizing:border-box;width:38px;height:22px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-bg-layer-3);cursor:pointer;transition:background .16s ease}",
			".dsh-theme-manager-switch[data-on=true]{background:var(--dsw-alias-brand-primary,var(--dsw-specific-sidebar-nav-item-active-accent,#D97757))}",
			".dsh-theme-manager-switch-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .16s ease}",
			".dsh-theme-manager-switch[data-on=true] .dsh-theme-manager-switch-knob{transform:translateX(16px)}",
			".dsh-theme-manager-actions{display:flex;flex-wrap:wrap;gap:8px}",
			".dsh-theme-manager-btn{box-sizing:border-box;height:30px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}",
			".dsh-theme-manager-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-theme-manager-palette-row{display:flex;align-items:center;gap:10px;padding:9px 12px;border-top:0.5px solid var(--dsw-alias-border-l1)}",
			".dsh-theme-manager-palette-row:first-of-type{border-top:none}",
			".dsh-theme-manager-palette-main{flex:1;min-width:0}",
			".dsh-theme-manager-color{flex:none;width:36px;height:26px;padding:0;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;cursor:pointer}",
			".dsh-theme-manager-hex{flex:none;width:132px;height:26px;box-sizing:border-box;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}",
			".dsh-theme-manager-hex[data-invalid=true]{border-color:var(--dsw-alias-state-error-primary,#c0392b);color:var(--dsw-alias-state-error-primary,#c0392b)}",
			".dsh-theme-manager-presets{display:flex;flex-wrap:wrap;gap:6px;padding:10px 12px;border-top:0.5px solid var(--dsw-alias-border-l1)}",
			/* ── 背景卡片 ── */
			".dsh-theme-manager-bg-preview{position:relative;flex:none;width:96px;height:56px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-3);display:flex;align-items:center;justify-content:center}",
			".dsh-theme-manager-bg-preview img,.dsh-theme-manager-bg-preview video{width:100%;height:100%;object-fit:cover;display:block}",
			".dsh-theme-manager-bg-preview span{font-size:10px;color:var(--dsw-alias-label-caption)}",
			".dsh-theme-manager-seg{display:inline-flex;flex:none;padding:2px;gap:2px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3)}",
			".dsh-theme-manager-seg button{box-sizing:border-box;height:24px;padding:0 10px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}",
			".dsh-theme-manager-seg button[data-on=true]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:500}",
			".dsh-theme-manager-slider{display:flex;align-items:center;gap:10px;padding:9px 12px;border-top:0.5px solid var(--dsw-alias-border-l1)}",
			".dsh-theme-manager-slider input[type=range]{flex:1;min-width:0;accent-color:var(--dsw-alias-brand-primary,var(--dsw-specific-sidebar-nav-item-active-accent,#D97757))}",
			".dsh-theme-manager-slider-value{flex:none;width:46px;text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-caption)}",
			".dsh-theme-manager-input{box-sizing:border-box;width:100%;height:28px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
			".dsh-theme-manager-field{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-top:0.5px solid var(--dsw-alias-border-l1)}",
			".dsh-theme-manager-field-label{font-size:11px;color:var(--dsw-alias-label-caption)}",
			".dsh-theme-manager-drop{display:flex;align-items:center;justify-content:center;gap:8px;padding:14px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px;text-align:center}",
			".dsh-theme-manager-drop[data-over=true]{border-color:var(--dsw-alias-brand-primary,var(--dsw-specific-sidebar-nav-item-active-accent,#D97757));color:var(--dsw-alias-label-secondary)}",
			".dsh-theme-manager-api{padding:10px 12px;border-top:0.5px solid var(--dsw-alias-border-l1);font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-theme-manager-api code{display:block;margin-top:6px;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;line-height:16px;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-secondary)}",
			".dsh-theme-manager-notice{font-size:11px;line-height:17px}",
			".dsh-theme-manager-notice[data-kind=error]{color:var(--dsw-alias-state-error-primary,#c0392b)}",
			".dsh-theme-manager-notice[data-kind=warn]{color:var(--dsw-alias-state-warning-primary,#a8730a)}"
		].join("\n");

		function ensureStyle() {
			if (typeof document === "undefined" || !document.head) return;
			let el = document.getElementById(STYLE_ID);
			if (el === null) {
				el = document.createElement("style");
				el.id = STYLE_ID;
				el.setAttribute(OWN_ATTR, "own");
				document.head.appendChild(el);
			}
			if (el.textContent !== CSS) el.textContent = CSS;
		}

		/* ───────────────────────── 设置页组件 ───────────────────────── */

		/** 开关（毛玻璃遮罩 / 视频静音 / 视频循环 共用）。 */
		function Switch(props) {
			return h("button", {
				type: "button",
				role: "switch",
				"aria-checked": props.on ? "true" : "false",
				"aria-label": props.label,
				"data-on": props.on ? "true" : "false",
				"data-testid": props.testId,
				className: "dsh-theme-manager-switch",
				onClick: props.onToggle
			}, h("span", { className: "dsh-theme-manager-switch-knob", "aria-hidden": true }));
		}

		/* ───────────────────── 页面背景卡片 ───────────────────── */

		/** 分段按钮组（背景类型 / 适配方式 / 透出范围共用）。 */
		function Seg(props) {
			return h(
				"div",
				{ className: "dsh-theme-manager-seg", role: "group", "aria-label": props.label },
				props.options.map((opt) =>
					h(
						"button",
						{
							key: opt.value,
							type: "button",
							"data-on": String(props.value === opt.value),
							"aria-pressed": String(props.value === opt.value),
							"data-testid": props.testId === undefined ? undefined : `${props.testId}-${opt.value}`,
							title: opt.title,
							onClick: () => props.onChange(opt.value)
						},
						opt.label
					)
				)
			);
		}

		/** 一行滑块：左标题说明 + range + 右侧数值。 */
		function SliderRow(props) {
			return h(
				"div",
				{ className: "dsh-theme-manager-slider" },
				h(
					"div",
					{ className: "dsh-theme-manager-palette-main" },
					h("div", { className: "dsh-theme-manager-row-name" }, props.label),
					props.hint === undefined ? null : h("div", { className: "dsh-theme-manager-row-meta" }, props.hint)
				),
				h("input", {
					type: "range",
					min: props.min,
					max: props.max,
					step: props.step,
					value: props.value,
					disabled: props.disabled === true,
					"aria-label": props.label,
					"data-testid": props.testId,
					onChange: (event) => props.onChange(Number(event.target.value))
				}),
				h("span", { className: "dsh-theme-manager-slider-value" }, props.display === undefined ? String(props.value) : props.display)
			);
		}

		/**
		 * 「页面背景」卡片。
		 * 三条设置路径并存，因为外部软件、拖拽、手填各有各的顺手：
		 *   ① 选择文件 / 拖入文件 —— 桌面外壳里 File 对象带真实路径（Electron 的
		 *      `file.path`），拿到就写进 host；拿不到就退化成只在本次页面生效的 blob 预览；
		 *   ② 手填绝对路径 —— 与外部 HTTP 接口写的是同一个字段（`path`）；
		 *   ③ 网络地址 —— 直接给浏览器加载，不经过 host。
		 */
		function BackgroundCard() {
			const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
			const bgState = state.bg ?? BG_DEFAULT;
			const notice = state.bgNotice;
			const [pathDraft, setPathDraft] = React.useState(null);
			const [urlDraft, setUrlDraft] = React.useState(null);
			const [dragOver, setDragOver] = React.useState(false);
			const [port, setPort] = React.useState(bgApiPort);
			const pickInputRef = React.useRef(null);
			React.useEffect(() => {
				if (port === null) probeApiPort().then((value) => setPort(value));
			}, [port]);

			const hasMedia = bgState.type !== "none" && (bgState.source.value !== "" || bgPreview !== "");
			const previewUrl = hasMedia ? bgMediaUrl(bgState) : "";

			/** 选中的文件 → 写进 host（拿不到路径时只做本地预览）。 */
			const useFile = (file) => {
				if (file === undefined || file === null) return;
				const name = typeof file.name === "string" ? file.name : "";
				const type = (file.type || "").startsWith("video/") || /\.(mp4|m4v|webm|mov|ogv|ogg)$/i.test(name) ? "video" : "image";
				const realPath = typeof file.path === "string" && file.path !== "" ? file.path : "";
				if (realPath !== "") {
					pushBackground({ type: type, path: realPath, source: { kind: "path", value: realPath } });
					return;
				}
				/* 非 Electron（浏览器里打开 DSH Web）：没有绝对路径，只能给一个临时预览，
				   并提示用户改用路径粘贴或外部接口。 */
				try {
					bgPreview = URL.createObjectURL(file);
					bg = bgNormalize({ type: type }, bg);
					applyBackground();
					bgNotice = { kind: "warn", text: `${name || "该文件"}：当前环境拿不到绝对路径，已做临时预览（刷新即失效）。要持久化请填绝对路径，或用外部 HTTP 接口传入 path。` };
					refresh();
				} catch (error) {
					bgNotice = { kind: "error", text: String(error?.message ?? error) };
					refresh();
				}
			};

			const typeOptions = [
				{ value: "none", label: "无" },
				{ value: "image", label: "图片" },
				{ value: "video", label: "视频" }
			];
			const fitOptions = [
				{ value: "cover", label: "铺满", title: "cover：保持比例填满屏幕，超出部分裁掉" },
				{ value: "contain", label: "完整", title: "contain：完整显示，可能出现留边" },
				{ value: "fill", label: "拉伸", title: "fill：拉伸到全屏（会变形）" }
			];
			const coverageOptions = [
				{ value: "base", label: "底板", title: "只透明整页骨架层：主内容区透出，侧栏与会话区保持官方底色" },
				{ value: "panels", label: "面板", title: "各列容器与侧栏/会话区一起透明：背景铺满整个窗口（推荐）" },
				{ value: "full", label: "全部", title: "壁纸连续显示到输入区；滚动正文在输入区前渐隐" }
			];

			const path = bgState.source.kind === "path" ? bgState.source.value : "";
			const url = bgState.source.kind === "url" ? bgState.source.value : "";

			return h(
				"div",
				{ className: "dsh-theme-manager-group", "data-testid": "theme-manager-background" },
				h(
					"div",
					{ className: "dsh-theme-manager-group-head" },
					h("span", { className: "dsh-theme-manager-group-title" }, "页面背景（图片 / 视频）"),
					h(
						"span",
						{ className: "dsh-theme-manager-group-count" },
						bgState.type === "none"
							? "当前无背景"
							: `${bgState.type === "video" ? "视频" : "图片"} · ${bgState.source.kind === "path" ? "本地文件" : "网络地址"}${bgPreview !== "" ? " · 临时预览" : ""}`
					)
				),

				/* 类型 + 预览 */
				h(
					"div",
					{ className: "dsh-theme-manager-row" },
					h(
						"div",
						{ className: "dsh-theme-manager-bg-preview" },
						previewUrl === ""
							? h("span", null, "无背景")
							: h(bgState.type === "video" ? "video" : "img", {
									src: previewUrl,
									muted: true,
									loop: true,
									autoPlay: bgState.type === "video",
									playsInline: true,
									alt: ""
								})
					),
					h(
						"div",
						{ className: "dsh-theme-manager-row-main" },
						h("div", { className: "dsh-theme-manager-row-name" }, "背景类型"),
						h(
							"div",
							{ className: "dsh-theme-manager-row-meta" },
							"本地文件走 host 的媒体路由（支持 Range，视频可拖进度）；网络地址由页面直接加载。"
						)
					),
					h(Seg, { label: "背景类型", value: bgState.type, options: typeOptions, testId: "theme-manager-bg-type", onChange: (value) => pushBackground({ type: value }) })
				),

				/* 本地文件：选择器 + 拖拽 + 手填路径 */
				h(
					"div",
					{ className: "dsh-theme-manager-field" },
					h("div", { className: "dsh-theme-manager-field-label" }, "本地文件（绝对路径）"),
					h("input", {
						type: "text",
						className: "dsh-theme-manager-input",
						value: pathDraft === null ? path : pathDraft,
						placeholder: "/Users/you/Pictures/wallpaper.jpg 或 …/clip.mp4",
						spellCheck: false,
						"data-testid": "theme-manager-bg-path",
						onChange: (event) => setPathDraft(event.target.value),
						onBlur: () => {
							if (pathDraft === null) return;
							const next = pathDraft.trim();
							setPathDraft(null);
							if (next !== "" && next !== path) pushBackground({ path: next, source: { kind: "path", value: next } });
						},
						onKeyDown: (event) => {
							if (event.key === "Enter") event.currentTarget.blur();
						}
					}),
					h(
						"div",
						{
							className: "dsh-theme-manager-drop",
							"data-over": String(dragOver),
							"data-testid": "theme-manager-bg-drop",
							onDragOver: (event) => {
								event.preventDefault();
								setDragOver(true);
							},
							onDragLeave: () => setDragOver(false),
							onDrop: (event) => {
								event.preventDefault();
								setDragOver(false);
								const file = event.dataTransfer?.files?.[0];
								useFile(file);
							}
						},
						"把图片 / 视频拖到这里，",
						h(
							"button",
							{
								type: "button",
								className: "dsh-theme-manager-mini",
								"data-testid": "theme-manager-bg-pick",
								onClick: () => pickInputRef.current?.click()
							},
							"选择文件"
						),
						h("input", {
							ref: pickInputRef,
							type: "file",
							accept: "image/*,video/*",
							style: { display: "none" },
							onChange: (event) => {
								useFile(event.target.files?.[0]);
								event.target.value = "";
							}
						})
					)
				),

				/* 网络地址 */
				h(
					"div",
					{ className: "dsh-theme-manager-field" },
					h("div", { className: "dsh-theme-manager-field-label" }, "网络地址（http/https）"),
					h("input", {
						type: "text",
						className: "dsh-theme-manager-input",
						value: urlDraft === null ? url : urlDraft,
						placeholder: "https://example.com/wallpaper.mp4",
						spellCheck: false,
						"data-testid": "theme-manager-bg-url",
						onChange: (event) => setUrlDraft(event.target.value),
						onBlur: () => {
							if (urlDraft === null) return;
							const next = urlDraft.trim();
							setUrlDraft(null);
							if (next !== "" && next !== url) pushBackground({ url: next, source: { kind: "url", value: next } });
						},
						onKeyDown: (event) => {
							if (event.key === "Enter") event.currentTarget.blur();
						}
					})
				),

				/* 适配 / 透出范围 */
				h(
					"div",
					{ className: "dsh-theme-manager-row" },
					h(
						"div",
						{ className: "dsh-theme-manager-row-main" },
						h("div", { className: "dsh-theme-manager-row-name" }, "适配方式"),
						h("div", { className: "dsh-theme-manager-row-meta" }, "背景媒体在屏幕上的铺法")
					),
					h(Seg, { label: "适配方式", value: bgState.fit, options: fitOptions, testId: "theme-manager-bg-fit", onChange: (value) => pushBackground({ fit: value }) })
				),
				h(
					"div",
					{ className: "dsh-theme-manager-row" },
					h(
						"div",
						{ className: "dsh-theme-manager-row-main" },
						h("div", { className: "dsh-theme-manager-row-name" }, "透出范围"),
						h("div", { className: "dsh-theme-manager-row-meta" }, "哪些容器让出底色，让背景可见（官方组件表面与菜单一律不动）")
					),
					h(Seg, { label: "透出范围", value: bgState.coverage, options: coverageOptions, testId: "theme-manager-bg-coverage", onChange: (value) => pushBackground({ coverage: value }) })
				),

				/* 参数 */
				h(SliderRow, {
					label: "不透明度",
					hint: "背景本身的不透明度",
					min: 0,
					max: 100,
					step: 1,
					value: Math.round(bgState.opacity * 100),
					display: `${Math.round(bgState.opacity * 100)}%`,
					testId: "theme-manager-bg-opacity",
					onChange: (value) => pushBackground({ opacity: value / 100 })
				}),
				h(SliderRow, {
					label: "模糊",
					hint: "背景虚化，正文更清楚",
					min: 0,
					max: 60,
					step: 1,
					value: bgState.blur,
					display: `${bgState.blur}px`,
					testId: "theme-manager-bg-blur",
					onChange: (value) => pushBackground({ blur: value })
				}),
				h(SliderRow, {
					label: "暗化",
					hint: "在背景上压一层黑，浅色文字/深色 UI 都能压得住",
					min: 0,
					max: 100,
					step: 1,
					value: Math.round(bgState.dim * 100),
					display: `${Math.round(bgState.dim * 100)}%`,
					testId: "theme-manager-bg-dim",
					onChange: (value) => pushBackground({ dim: value / 100 })
				}),
				h(
					"div",
					{ className: "dsh-theme-manager-row" },
					h(
						"div",
						{ className: "dsh-theme-manager-row-main" },
						h("div", { className: "dsh-theme-manager-row-name" }, "壁纸上的文字颜色"),
						h("div", { className: "dsh-theme-manager-row-meta" }, "面板 / 全部透出时生效；只改壁纸上的文字，输入框保持原样")
					),
					h(Seg, {
						label: "壁纸上的文字颜色",
						value: bgState.textColor,
						options: [
							{ value: "black", label: "黑字" },
							{ value: "white", label: "白字" }
						],
						testId: "theme-manager-bg-text-color",
						onChange: (value) => pushBackground({ textColor: value })
					})
				),

				/* 毛玻璃遮罩 */
				h(
					"div",
					{ className: "dsh-theme-manager-row" },
					h(
						"div",
						{ className: "dsh-theme-manager-row-main" },
						h("div", { className: "dsh-theme-manager-row-name" }, "毛玻璃遮罩（内容底板）"),
						h("div", { className: "dsh-theme-manager-row-meta" }, "给侧栏与主区各铺一层毛玻璃，按区域取原生底色；背景再花也读得清")
					),
					h(Switch, {
						on: bgState.card.enabled,
						label: bgState.card.enabled ? "关闭毛玻璃遮罩" : "开启毛玻璃遮罩",
						testId: "theme-manager-bg-card",
						onToggle: () => pushBackground({ card: { ...bgState.card, enabled: !bgState.card.enabled } })
					})
				),
				bgState.card.enabled
					? h(SliderRow, {
							label: "遮罩不透明度",
							min: 0,
							max: 100,
							step: 1,
							value: Math.round(bgState.card.alpha * 100),
							display: `${Math.round(bgState.card.alpha * 100)}%`,
							testId: "theme-manager-bg-card-alpha",
							onChange: (value) => pushBackground({ card: { ...bgState.card, alpha: value / 100 } })
						})
					: null,
				bgState.card.enabled
					? h(SliderRow, {
							label: "毛玻璃模糊",
							min: 0,
							max: 40,
							step: 1,
							value: bgState.card.blur,
							display: `${bgState.card.blur}px`,
							testId: "theme-manager-bg-card-blur",
							onChange: (value) => pushBackground({ card: { ...bgState.card, blur: value } })
						})
					: null,

				/* 视频参数 */
				bgState.type === "video"
					? h(
							"div",
							{ className: "dsh-theme-manager-row" },
							h(
								"div",
								{ className: "dsh-theme-manager-row-main" },
								h("div", { className: "dsh-theme-manager-row-name" }, "视频 · 静音"),
								h("div", { className: "dsh-theme-manager-row-meta" }, "静音才能在页面加载时自动播放")
							),
							h(Switch, {
								on: bgState.video.muted !== false,
								label: "视频静音",
								testId: "theme-manager-bg-muted",
								onToggle: () => pushBackground({ video: { ...bgState.video, muted: bgState.video.muted === false } })
							})
						)
					: null,
				bgState.type === "video"
					? h(
							"div",
							{ className: "dsh-theme-manager-row" },
							h(
								"div",
								{ className: "dsh-theme-manager-row-main" },
								h("div", { className: "dsh-theme-manager-row-name" }, "视频 · 循环"),
								h("div", { className: "dsh-theme-manager-row-meta" }, "循环播放，还是播完停在最后一帧")
							),
							h(Switch, {
								on: bgState.video.loop !== false,
								label: "视频循环",
								testId: "theme-manager-bg-loop",
								onToggle: () => pushBackground({ video: { ...bgState.video, loop: bgState.video.loop === false } })
							})
						)
					: null,
				bgState.type === "video"
					? h(SliderRow, {
							label: "视频速率",
							min: 10,
							max: 400,
							step: 5,
							value: Math.round((bgState.video.rate ?? 1) * 100),
							display: `${(bgState.video.rate ?? 1).toFixed(2)}×`,
							testId: "theme-manager-bg-rate",
							onChange: (value) => pushBackground({ video: { ...bgState.video, rate: value / 100 } })
						})
					: null,

				/* 通知 + 一键清空 */
				h(
					"div",
					{ className: "dsh-theme-manager-field" },
					notice === null || notice === undefined
						? null
						: h(
								"div",
								{ className: "dsh-theme-manager-notice", "data-kind": notice.kind, "data-testid": "theme-manager-bg-notice" },
								notice.text
							),
					h(
						"div",
						{ className: "dsh-theme-manager-actions" },
						h(
							"button",
							{
								type: "button",
								className: "dsh-theme-manager-btn",
								"data-testid": "theme-manager-bg-clear",
								onClick: () => {
									bgPreview = "";
									pushBackground({ type: "none", source: { kind: "", value: "" } });
								}
							},
							"清除背景"
						),
						h(
							"button",
							{
								type: "button",
								className: "dsh-theme-manager-btn",
								"data-testid": "theme-manager-bg-refresh",
								onClick: () => pullBackground()
							},
							"从 host 重新读取"
						)
					)
				),

				/* 对外接口：给外部软件照抄 */
				h(
					"div",
					{ className: "dsh-theme-manager-api" },
					h("div", null, "对外接口（本机 HTTP，任何脚本 / 快捷指令 / 别的软件都能调）："),
					h(
						"code",
						null,
						[
							`# 读当前背景`,
							`curl ${apiOrigin()}/dsh-theme-manager/state`,
							``,
							`# 换成图片（本地绝对路径）`,
							`curl -X POST ${apiOrigin()}/dsh-theme-manager/background \\`,
							`  -H 'Content-Type: application/json' \\`,
							`  -d '{"type":"image","path":"/Users/you/Pictures/a.jpg","coverage":"panels","dim":0.35}'`,
							``,
							`# 换成视频（可选 loop / muted / rate）`,
							`curl -X POST ${apiOrigin()}/dsh-theme-manager/background \\`,
							`  -H 'Content-Type: application/json' \\`,
							`  -d '{"type":"video","path":"/Users/you/Movies/a.mp4","video":{"loop":true,"muted":true,"rate":0.8}}'`,
							``,
							`# 清除背景`,
							`curl -X POST ${apiOrigin()}/dsh-theme-manager/background/clear`
						].join("\n")
					),
					h("div", null, "页面最多 ", String(BG_POLL_MS / 1000), " 秒后跟随外部改动；也可在页面里用 window.__dshTheme.set({…})。")
				)
			);
		}

		/** 调色盘：一个槽位一行 —— 色块（系统取色器）+ 可粘贴的颜色值输入 + 重置。 */
		function PaletteCard() {
			const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
			const [drafts, setDrafts] = React.useState({});
			const [invalid, setInvalid] = React.useState({});
			const palette = state.palette;
			const customCount = Object.keys(palette).length;

			const commit = (slot, text) => {
				const ok = setSlotColor(slot.key, text);
				const nextDrafts = Object.assign({}, drafts);
				delete nextDrafts[slot.key];
				setDrafts(nextDrafts);
				const nextInvalid = Object.assign({}, invalid);
				if (ok) delete nextInvalid[slot.key];
				else nextInvalid[slot.key] = true;
				setInvalid(nextInvalid);
			};

			const rows = PALETTE_SLOTS.map((slot) => {
				const current = slotValue(slot);
				const draft = drafts[slot.key];
				const text = draft === undefined ? current : draft;
				const isInvalid = invalid[slot.key] === true;
				return h(
					"div",
					{ className: "dsh-theme-manager-palette-row", key: slot.key },
					h(
						"div",
						{ className: "dsh-theme-manager-palette-main" },
						h("div", { className: "dsh-theme-manager-row-name" }, slot.label),
						h("div", { className: "dsh-theme-manager-row-meta" }, slot.hint)
					),
					h("input", {
						type: "color",
						className: "dsh-theme-manager-color",
						value: toHex6(current),
						title: "系统取色器：macOS 里可以用吸管直接取屏幕上任意位置的颜色",
						"data-testid": "theme-manager-color-" + slot.key,
						onChange: (event) => commit(slot, event.target.value)
					}),
					h("input", {
						type: "text",
						className: "dsh-theme-manager-hex",
						value: text,
						spellCheck: false,
						placeholder: "#RRGGBB",
						title: "粘贴任意 CSS 颜色（#RGB / #RRGGBB / #RRGGBBAA / rgb() / rgba()），回车或失焦生效",
						"data-invalid": String(isInvalid),
						"data-testid": "theme-manager-hex-" + slot.key,
						onChange: (event) => {
							const next = Object.assign({}, drafts);
							next[slot.key] = event.target.value;
							setDrafts(next);
						},
						onBlur: (event) => commit(slot, event.target.value),
						onKeyDown: (event) => {
							if (event.key === "Enter") commit(slot, event.currentTarget.value);
						}
					}),
					h(
						"button",
						{
							type: "button",
							className: "dsh-theme-manager-mini",
							"data-testid": "theme-manager-color-reset-" + slot.key,
							onClick: () => resetSlot(slot.key)
						},
						"重置"
					)
				);
			});

			return h(
				"div",
				{ className: "dsh-theme-manager-group" },
				h(
					"div",
					{ className: "dsh-theme-manager-group-head" },
					h("span", { className: "dsh-theme-manager-group-title" }, "主色调 / 背景色"),
					h(
						"span",
						{ className: "dsh-theme-manager-group-count" },
						customCount === 0 ? "当前跟随主题默认色" : customCount + " 项已自定义"
					)
				),
				rows,
				h(
					"div",
					{ className: "dsh-theme-manager-presets" },
					h(
						"button",
						{
							type: "button",
							className: "dsh-theme-manager-mini",
							"data-testid": "theme-manager-palette-reset",
							onClick: resetPalette
						},
						"恢复默认"
					)
				)
			);
		}

		function ThemeManagerSettings() {
			return h(
				"div",
				{ className: "dsh-theme-manager-root" },
				h(
					"div",
					{ className: "dsh-theme-manager-intro-desc" },
					"这个页面只做两件事：换一个「主色调」，或者给页面换一张「背景」（图片 / 视频）。两者都立即生效，只作用于本机。"
				),
				h(BackgroundCard, { key: "background" }),
				h(PaletteCard, { key: "palette" })
			);
		}
		/* ═══════════════ 合并自 dsh-ui-harmonizer（MIT）的「界面统一」段 ═══════════════
		 * 下面这段是 dsh-ui-harmonizer 0.8.3 的 **逐字副本**（其 lib/client.js 里
		 * factory 体的全部内容），只改了三处 style 标签的命名空间，功能一行未改：
		 *   · 官方 UI 规范化 —— 顶部栏单行化、按钮胶囊族、设置页头统一、
		 *     原生 title 悬浮提示改用官方气泡渲染；
		 *   · 插件视觉协调 —— better-sidebar（面板/开关/根类同步）、genui 工具面板、
		 *     第三方设置页自动补标题与间距；
		 *   · 界面定制 —— 对话内容宽度、对话字号、工作区字号、UI 字体、圆角卡片
		 *     （设置 → 通用设置 → 界面定制，与原来完全一样）；
		 *   · 圆角卡片覆盖层（shell.overlay）。
		 * 为什么合并：本机外观层只留本插件一个入口，不再单独挂载 dsh-ui-harmonizer。
		 * 它的 localStorage 键（harness-ui-enhancer.state）**原样保留** —— 用户原有的
		 * 宽度/字号/字体设置不会丢。
		 * 上游：https://github.com/Physicolor/dsh-ui-harmonizer · MIT
		 * 重新生成：node tools/inline-harmonizer.mjs
		 */
		/* @@HARMONIZER-INLINE-START@@ */
		function harmonizerHalf(require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		//#region \0dsh-css:D:\dsh-home\plugins\harness-ui-enhancer\src\client\enhancer.module.css.mjs
		const css = ":root{--enhancer-content-width:748px;--enhancer-font-size:14px;--enhancer-font-line:21px;--enhancer-sidebar-scale:1;--enhancer-chat-scale:1}div[data-phase]{--dsh-chat-content-width:var(--enhancer-content-width)}[data-input-scroll],[data-slot=conversation\\.session] [class$=_bubble]{font-size:var(--enhancer-font-size);line-height:var(--enhancer-font-line)}[data-slot=\"conversation.composer.bar\"] [class$=_trigger]{font-size:calc(13px * var(--enhancer-chat-scale,1));line-height:calc(20px * var(--enhancer-chat-scale,1));height:calc(28px * var(--enhancer-chat-scale,1))}[data-slot=\"conversation.composer.bar\"] [class$=_trigger] svg,[data-slot=\"conversation.composer.bar\"] [class$=_add] svg{width:calc(14px * var(--enhancer-chat-scale,1));height:calc(14px * var(--enhancer-chat-scale,1))}[data-slot=\"conversation.composer.bar\"] [class$=_primary] svg{width:calc(16px * var(--enhancer-chat-scale,1));height:calc(16px * var(--enhancer-chat-scale,1))}[role=menu] [class^=_list_]{padding:calc(4px * var(--enhancer-chat-scale,1));border-radius:calc(12px * var(--enhancer-chat-scale,1));min-width:calc(218px * var(--enhancer-chat-scale,1));max-width:calc(360px * var(--enhancer-chat-scale,1))}[role=menu] [class^=_item_]{font-size:calc(14px * var(--enhancer-chat-scale,1));line-height:calc(22px * var(--enhancer-chat-scale,1));min-height:calc(40px * var(--enhancer-chat-scale,1));padding:calc(8px * var(--enhancer-chat-scale,1)) calc(10px * var(--enhancer-chat-scale,1));border-radius:calc(10px * var(--enhancer-chat-scale,1));gap:calc(8px * var(--enhancer-chat-scale,1))}[role=menu] [class^=_itemIcon_],[role=menu] [class^=_check_]{width:calc(16px * var(--enhancer-chat-scale,1));height:calc(16px * var(--enhancer-chat-scale,1))}[role=menu] [class^=_label_]{font-size:calc(12px * var(--enhancer-chat-scale,1));line-height:calc(16px * var(--enhancer-chat-scale,1));padding:calc(8px * var(--enhancer-chat-scale,1)) calc(10px * var(--enhancer-chat-scale,1))}[data-slot=sidebar] [class$=_newSession]{font-size:calc(14px * var(--enhancer-sidebar-scale));height:calc(38px * var(--enhancer-sidebar-scale))}[data-slot=sidebar] [class$=_newSessionLabel]{max-width:calc(200px * var(--enhancer-sidebar-scale))}[data-slot=sidebar] [class$=_brand] svg{width:calc(182px * var(--enhancer-sidebar-scale));height:calc(24px * var(--enhancer-sidebar-scale))}:not([data-sidebar-collapsed]) [data-slot=sidebar] [class$=_logoRow] [class$=_iconButton]{width:calc(28px * var(--enhancer-sidebar-scale));height:calc(28px * var(--enhancer-sidebar-scale))}:not([data-sidebar-collapsed]) [data-slot=sidebar] [class$=_logoRow] [class$=_iconButton] svg{width:calc(16px * var(--enhancer-sidebar-scale));height:calc(16px * var(--enhancer-sidebar-scale))}[data-sidebar-collapsed] [data-slot=sidebar] [class$=_logoRow] [class$=_iconButton]{width:36px;height:36px}[data-sidebar-collapsed] [data-slot=sidebar] [class$=_logoRow] [class$=_iconButton] svg{width:16px;height:16px}[data-slot=sidebar\\.settings] [class$=_trigger]{font-size:calc(14px * var(--enhancer-sidebar-scale));height:calc(34px * var(--enhancer-sidebar-scale))}[data-slot=\"sidebar.footer.action\"] [class$=_badge]{font-size:calc(14px * var(--enhancer-sidebar-scale));height:calc(49px * var(--enhancer-sidebar-scale))}[data-slot=\"sidebar.footer.action\"] [class$=_badge] svg{width:calc(14px * var(--enhancer-sidebar-scale));height:calc(14px * var(--enhancer-sidebar-scale))}[data-slot=\"sidebar.footer.action\"] [class$=_badgeCount]{font-size:calc(12px * var(--enhancer-sidebar-scale));line-height:calc(16px * var(--enhancer-sidebar-scale))}[data-slot=sidebar\\.workspaces]{font-size:calc(14px * var(--enhancer-sidebar-scale))}[data-slot=sidebar\\.workspaces] [class$=_title]{font-size:calc(14px * var(--enhancer-sidebar-scale));line-height:calc(20px * var(--enhancer-sidebar-scale))}[data-slot=sidebar\\.workspaces] [class$=_meta],[data-slot=sidebar\\.workspaces] [class$=_time]{font-size:calc(12px * var(--enhancer-sidebar-scale))}[data-slot=sidebar\\.workspaces] [class$=_sectionHeader]{font-size:calc(13px * var(--enhancer-sidebar-scale))}:not([data-sidebar-collapsed]) [data-slot=sidebar\\.workspaces] [class$=_iconButton]{width:calc(28px * var(--enhancer-sidebar-scale));height:calc(28px * var(--enhancer-sidebar-scale))}:not([data-sidebar-collapsed]) [data-slot=sidebar\\.workspaces] [class$=_iconButton] svg{width:calc(16px * var(--enhancer-sidebar-scale));height:calc(16px * var(--enhancer-sidebar-scale))}[data-sidebar-collapsed] [data-slot=sidebar\\.workspaces] [class$=_iconButton]{width:36px;height:36px}[data-sidebar-collapsed] [data-slot=sidebar\\.workspaces] [class$=_iconButton] svg{width:16px;height:16px}html #root{width:100%;margin-right:0}html #root>div[data-slot=root]>div>div:nth-child(2){margin-bottom:0}[data-slot=conversation\\.session]>[class$=_viewArea]{margin-right:var(--dsh-sidebar-width,0px);transition:margin-right var(--ds-transition-duration-slow) var(--ds-ease-in-out)}div[class$=_composerSeat]{margin-right:var(--dsh-sidebar-width,0px);transition:margin-right var(--ds-transition-duration-slow) var(--ds-ease-in-out)}body.dsx-stats-active [data-conversation-scroll]:has([data-conversation-composer-overlay])>[class$=_composerSeat]{right:calc(var(--dsh-scrollbar-width,0px) + var(--dsx-rail-w,220px))}html.enhc-center-card-on div:has(>[data-slot=conversation]){border-radius:18px 0 0}html.enhc-center-card-on .enhc-center-card{display:block}.enhc-center-card{box-sizing:border-box;border-top:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-shadow-lv3);pointer-events:none;background:0 0;border-bottom:none;border-left:none;border-right:none;border-radius:18px 0 0;display:none}html.enhc-center-card-on .enhc-center-card-wrapped{border-top:none;border-radius:0;box-shadow:-20px 10px 36px -18px #0000001c,0 -10px 26px -16px #0000000f,16px 26px 42px -22px #00000014}html.enhc-center-card-on [data-slot=\"conversation.session.header\"]>header{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l2);border-radius:18px 0 0}";
		const tagId = "dsh-theme-manager/harmonizer.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-theme-manager";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/client/i18n.ts
		/**
		* Minimal i18n for dsh-ui-harmonizer.
		*
		* Every getter re-evaluates on each call so switching Settings → Language
		* takes effect without a page reload. Detection priority:
		*   1. localStorage key 'dsh-language' (written by the official Settings panel)
		*   2. <html lang="…"> attribute (synced by the product when the setting changes)
		*   3. navigator.language (fallback for SSR / private mode)
		*/
		/** Detect current locale, re-evaluated on every call. */
		function detectLocale() {
			try {
				const stored = localStorage.getItem("dsh-language");
				if (stored !== null && stored !== "") return stored;
			} catch {}
			try {
				const htmlLang = document.documentElement.lang;
				if (htmlLang) return htmlLang;
			} catch {}
			try {
				return navigator.language;
			} catch {
				return "zh-CN";
			}
		}
		function isZh() {
			return detectLocale().startsWith("zh");
		}
		function getRowWidthTitle() {
			return isZh() ? "对话内容宽度" : "Chat Content Width";
		}
		function getRowWidthDesc() {
			return isZh() ? "对话列的最大宽度，滑动即时预览" : "Maximum width of the chat column; preview on slide";
		}
		function getRowFontSizeTitle() {
			return isZh() ? "对话字号" : "Chat Font Size";
		}
		function getRowFontSizeDesc() {
			return isZh() ? "markdown 正文与输入框文字大小" : "Font size for markdown body and input box";
		}
		function getRowSidebarSizeTitle() {
			return isZh() ? "工作区字号" : "Workspace Font Size";
		}
		function getRowSidebarSizeDesc() {
			return isZh() ? "左侧工作区列表、按钮与图标的整体大小" : "Overall size of the left workspace list, buttons and icons";
		}
		function getRowFontTitle() {
			return isZh() ? "UI 字体" : "UI Font";
		}
		function getRowFontDesc() {
			return isZh() ? "界面与对话使用的字体栈" : "Font stack used by the interface and chat";
		}
		function getRowCardTitle() {
			return isZh() ? "圆角卡片" : "Rounded Card";
		}
		function getRowCardDesc() {
			return isZh() ? "将对话区域显示为左上圆角的卡片，附投影" : "Display the chat area as a rounded card with shadow";
		}
		function getFontLabel(id) {
			const zh = isZh();
			switch (id) {
				case "default": return zh ? "系统默认（HarmonyOS Sans SC）" : "System Default (HarmonyOS Sans SC)";
				case "harmony": return "HarmonyOS Sans SC";
				case "yahei": return zh ? "微软雅黑优先" : "Microsoft YaHei";
				case "noto": return "Noto Sans SC";
				case "serif": return zh ? "衬线（宋体风）" : "Serif";
				case "mono": return zh ? "等宽" : "Monospace";
				default: return id;
			}
		}
		//#endregion
		//#region src/client/state.ts
		/**
		* State and CSS application for Harness UI Enhancer.
		*
		* Two channels push values into the page:
		* - Static override rules in enhancer.module.css read CSS custom properties
		*   (--enhancer-*) which applyState() updates on <html>.
		* - Markdown font shorthand (font: <weight> <size>/<line> <family>) cannot be
		*   expressed through a custom property, so applyState() also rewrites one
		*   dynamic <style data-plugin="harness-ui-enhancer"> tag holding the body
		*   --dsw-font-markdown-* overrides. The tag carries the plugin id so the
		*   loader's unload sweep removes it together with the bundled stylesheet.
		*/
		/** Font presets: id → stack (null keeps the product default). Labels are
		*  resolved at render time via getFontLabel() so language switches take effect
		*  without a page reload. */
		const FONT_PRESETS = [
			{
				id: "default",
				stack: null
			},
			{
				id: "harmony",
				stack: "'HarmonyOS Sans SC', 'HarmonyOS Sans', 'PingFang SC', 'Microsoft YaHei', sans-serif"
			},
			{
				id: "yahei",
				stack: "'Microsoft YaHei', 'PingFang SC', 'Segoe UI', sans-serif"
			},
			{
				id: "noto",
				stack: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif"
			},
			{
				id: "serif",
				stack: "Georgia, 'Times New Roman', 'Songti SC', 'SimSun', serif"
			},
			{
				id: "mono",
				stack: "'JetBrains Mono', 'SF Mono', Consolas, 'Courier New', monospace"
			}
		];
		/** Resolved preset with locale-aware label (for use in components). */
		function getPresetLabel(id) {
			return getFontLabel(id);
		}
		/** Product defaults; the plugin applies these on boot and treats them as the neutral baseline. */
		const DEFAULT_STATE = {
			width: 748,
			fontSize: 14,
			sidebarSize: 14,
			fontId: "default",
			card: false
		};
		/** localStorage key holding the persisted enhancer state. */
		const STORAGE_KEY = "harness-ui-enhancer.state";
		/**
		* Read the persisted state, falling back to defaults on any parse or shape
		* error (the key may be absent, corrupted, or from an older schema).
		* @returns the merged persisted state.
		*/
		function loadState() {
			try {
				const raw = localStorage.getItem(STORAGE_KEY);
				if (raw === null) return { ...DEFAULT_STATE };
				const parsed = JSON.parse(raw);
				const state = {
					...DEFAULT_STATE,
					...parsed
				};
				if (!Number.isFinite(state.width) || state.width < 600 || state.width > 1200) state.width = DEFAULT_STATE.width;
				if (!Number.isFinite(state.fontSize) || state.fontSize < 12 || state.fontSize > 24) state.fontSize = DEFAULT_STATE.fontSize;
				if (!Number.isFinite(state.sidebarSize) || state.sidebarSize < 12 || state.sidebarSize > 20) state.sidebarSize = DEFAULT_STATE.sidebarSize;
				if (typeof state.fontId !== "string" || !FONT_PRESETS.some((p) => p.id === state.fontId)) state.fontId = DEFAULT_STATE.fontId;
				if (typeof state.card !== "boolean") state.card = DEFAULT_STATE.card;
				return state;
			} catch {
				return { ...DEFAULT_STATE };
			}
		}
		/** Persist the current state to localStorage. */
		function saveState(state) {
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
			} catch {}
		}
		/** CSS custom properties consumed by enhancer.module.css. */
		const ROOT_PROPERTIES = [
			"--enhancer-content-width",
			"--enhancer-font-size",
			"--enhancer-font-line",
			"--enhancer-sidebar-scale",
			"--enhancer-chat-scale"
		];
		/** One <style data-plugin> tag lazily created and reused for the dynamic markdown rules. */
		let dynamicStyle = null;
		/**
		* Render the markdown font overrides for the current state.
		* @param state - current enhancer state.
		* @returns the CSS text for the dynamic style tag.
		*/
		function markdownCss(state) {
			const fam = FONT_PRESETS.find((p) => p.id === state.fontId)?.stack ?? "var(--dsw-font-family)";
			const fs = state.fontSize;
			const lh = Math.round(fs * 28 / 16);
			const fmt = (weight, size, line, family) => `${weight} ${size}px/${line}px ${family}`;
			return [
				"body {",
				`  --dsw-font-markdown-base: ${fmt(400, fs, lh, fam)};`,
				`  --dsw-font-markdown-base-strong: ${fmt(600, fs, lh, fam)};`,
				`  --dsw-font-markdown-base-italic: ${fmt(400, fs, lh, fam)};`,
				`  --dsw-font-markdown-base-strong-italic: ${fmt(600, fs, lh, fam)};`,
				`  --dsw-font-markdown-h1: ${fmt(700, Math.round(fs * 1.5), Math.round(fs * 2.125), fam)};`,
				`  --dsw-font-markdown-h2: ${fmt(700, Math.round(fs * 1.375), Math.round(fs * 2), fam)};`,
				`  --dsw-font-markdown-h3: ${fmt(700, Math.round(fs * 1.25), Math.round(fs * 1.875), fam)};`,
				`  --dsw-font-markdown-h4: ${fmt(600, fs, Math.round(fs * 1.75), fam)};`,
				`  --dsw-font-markdown-code: ${fmt(400, Math.round(fs * .875), Math.round(fs * 1.375), fam)};`,
				`  --dsw-font-markdown-code-block: ${fmt(400, Math.round(fs * .8125), Math.round(fs * 1.375), fam)};`,
				`  --dsw-font-markdown-small: ${fmt(400, Math.round(fs * .875), Math.round(fs * 1.5), fam)};`,
				`  --dsw-font-markdown-table: ${fmt(400, Math.round(fs * .9375), Math.round(fs * 1.5625), fam)};`,
				"}"
			].join("\n");
		}
		/**
		* Push the current state into the page: root custom properties plus the
		* dynamic markdown style tag, and persist to localStorage. Idempotent; safe
		* to call on every slider move.
		* @param state - current enhancer state.
		*/
		function applyState(state) {
			saveState(state);
			const root = document.documentElement;
			root.style.setProperty("--enhancer-content-width", `${state.width}px`);
			root.style.setProperty("--enhancer-font-size", `${state.fontSize}px`);
			root.style.setProperty("--enhancer-font-line", `${Math.round(state.fontSize * 1.5)}px`);
			root.style.setProperty("--enhancer-sidebar-scale", String(state.sidebarSize / 14));
			root.style.setProperty("--enhancer-chat-scale", String(state.fontSize / 14));
			root.classList.toggle("enhc-center-card-on", state.card);
			if (dynamicStyle === null) {
				dynamicStyle = document.createElement("style");
				dynamicStyle.dataset.plugin = "dsh-theme-manager";
				dynamicStyle.dataset.dshThemeManagerLayer = "界面字体（通用设置 · 界面定制）";
				dynamicStyle.dataset.enhancerDynamic = "markdown";
				document.head.appendChild(dynamicStyle);
			}
			dynamicStyle.textContent = markdownCss(state);
		}
		/**
		* Dispose the dynamic style tag. Called from the plugin fiber's effect
		* disposer so stopping/updating the plugin removes it.
		*/
		function disposeDynamicStyle() {
			if (dynamicStyle !== null) {
				dynamicStyle.remove();
				dynamicStyle = null;
			}
			const root = document.documentElement;
			for (const property of ROOT_PROPERTIES) root.style.removeProperty(property);
			root.classList.remove("enhc-center-card-on");
		}
		//#endregion
		//#region src/client/components.tsx
		/**
		* Harness UI Enhancer — React components.
		*
		* One surface: SettingsGeneralRow, the "界面定制" block inside Settings →
		* General. It reads and writes one shared EnhancerState through the props
		* passed by apply(). Everything is plain React.createElement — no JSX — and
		* styles are inline so the component file carries no CSS module of its own
		* (the plugin-wide rules live in enhancer.module.css).
		*/
		/** Icon path constants copied from @deepseek-ai/dsh-client-ui-primitives. */
		const CHEVRON_PATH = "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z";
		const CHECK_PATH = "M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z";
		/** Custom font selector: product selector-pill button + fixed menu.
		* Holds a local mirror of the selected id so the pill label updates
		* immediately on pick; external changes are adopted via the effect. */
		function FontSelector({ value, onChange, presets }) {
			const [local, setLocal] = react.useState(value);
			react.useEffect(() => {
				setLocal(value);
			}, [value]);
			const [open, setOpen] = react.useState(false);
			const [pos, setPos] = react.useState(null);
			const wrapRef = react.useRef(null);
			react.useEffect(() => {
				if (!open) return;
				const onDown = (e) => {
					if (wrapRef.current !== null && !wrapRef.current.contains(e.target)) setOpen(false);
				};
				const onKey = (e) => {
					if (e.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", onDown);
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("pointerdown", onDown);
					document.removeEventListener("keydown", onKey);
				};
			}, [open]);
			const selectedLabel = getPresetLabel((presets.find((p) => p.id === local) ?? presets[0]).id);
			const toggle = (e) => {
				if (!open) {
					const rect = e.currentTarget.getBoundingClientRect();
					const vw = window.innerWidth;
					const vh = window.innerHeight;
					const MARGIN = 12;
					const estHeight = 8 + presets.length * 40 + 2;
					const openDown = rect.bottom + 4 + estHeight <= vh - MARGIN;
					setPos({
						left: Math.min(Math.max(rect.right - 218, MARGIN), vw - 218 - MARGIN),
						top: openDown ? rect.bottom + 4 : rect.top - estHeight - 4,
						maxHeight: vh - 24
					});
				}
				setOpen((v) => !v);
			};
			const pillStyle = {
				display: "inline-flex",
				alignItems: "center",
				gap: 12,
				height: 36,
				padding: "0 14px",
				border: "none",
				borderRadius: 18,
				background: "var(--dsw-alias-bg-module-platform)",
				font: "inherit",
				fontSize: 14,
				lineHeight: "22px",
				color: "var(--dsw-alias-label-primary)",
				cursor: "pointer",
				whiteSpace: "nowrap",
				maxWidth: "100%"
			};
			const menuStyle = {
				position: "fixed",
				zIndex: 1100,
				boxSizing: "border-box",
				minWidth: 218,
				maxWidth: 360,
				padding: 4,
				display: "flex",
				flexDirection: "column",
				border: "1px solid var(--dsw-alias-border-inverted)",
				borderRadius: 12,
				background: "var(--dsw-specific-menu)",
				boxShadow: "var(--dsw-shadow-lv3)",
				...pos
			};
			const itemStyle = {
				display: "flex",
				alignItems: "center",
				gap: 8,
				width: "100%",
				minHeight: 40,
				padding: "8px 10px",
				border: "none",
				borderRadius: 10,
				background: "transparent",
				cursor: "pointer",
				fontSize: 14,
				lineHeight: "22px",
				color: "var(--dsw-alias-label-primary)",
				textAlign: "left"
			};
			const checkIcon = react.createElement("svg", {
				width: 16,
				height: 16,
				viewBox: "0 0 16 16",
				fill: "none",
				style: { flex: "none" }
			}, react.createElement("path", {
				d: CHECK_PATH,
				fill: "currentColor"
			}));
			return react.createElement("div", {
				ref: wrapRef,
				style: {
					position: "relative",
					display: "inline-flex",
					maxWidth: "100%"
				}
			}, [react.createElement("button", {
				type: "button",
				style: open ? {
					...pillStyle,
					background: "var(--dsw-alias-interactive-bg-hover)"
				} : pillStyle,
				"aria-haspopup": "menu",
				"aria-expanded": open,
				onClick: toggle,
				key: "trigger"
			}, [react.createElement("span", {
				key: "label",
				style: {
					overflow: "hidden",
					textOverflow: "ellipsis",
					whiteSpace: "nowrap",
					minWidth: 0
				}
			}, selectedLabel), react.createElement("svg", {
				key: "chevron",
				width: 14,
				height: 14,
				viewBox: "0 0 14 14",
				fill: "none",
				style: {
					flex: "none",
					color: "var(--dsw-alias-label-tertiary)"
				}
			}, react.createElement("path", {
				d: CHEVRON_PATH,
				fill: "currentColor"
			}))]), open && pos !== null ? react.createElement("div", {
				key: "menu",
				role: "menu",
				style: {
					...menuStyle,
					maxHeight: pos.maxHeight,
					overflowY: "auto"
				}
			}, presets.map((p) => react.createElement("button", {
				key: p.id,
				type: "button",
				role: "menuitem",
				style: itemStyle,
				onMouseEnter: (e) => {
					e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover)";
				},
				onMouseLeave: (e) => {
					e.currentTarget.style.background = "transparent";
				},
				onClick: () => {
					setLocal(p.id);
					setOpen(false);
					onChange(p.id);
				}
			}, [react.createElement("span", {
				key: "label",
				style: {
					flex: 1,
					minWidth: 0,
					overflow: "hidden",
					textOverflow: "ellipsis",
					whiteSpace: "nowrap"
				}
			}, getPresetLabel(p.id)), p.id === local ? react.createElement("span", {
				key: "check",
				style: { flex: "none" }
			}, checkIcon) : null]))) : null]);
		}
		/** Slider row: title + description left, range + value right. */
		function SettingsRow({ title, desc, control }) {
			return react.createElement("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "16px 0",
				borderBottom: "1px solid var(--dsw-alias-border-l2)"
			} }, [react.createElement("div", {
				key: "text",
				style: {
					flex: 1,
					minWidth: 0,
					display: "flex",
					flexDirection: "column",
					gap: 4,
					paddingRight: 48
				}
			}, [react.createElement("div", {
				key: "title",
				style: {
					fontSize: 14,
					lineHeight: "22px",
					color: "var(--dsw-alias-label-primary)"
				}
			}, title), react.createElement("div", {
				key: "desc",
				style: {
					fontSize: 12,
					lineHeight: "18px",
					color: "var(--dsw-alias-label-tertiary)"
				}
			}, desc)]), react.createElement("div", {
				key: "control",
				style: {
					flex: "none",
					maxWidth: "60%",
					minWidth: 0
				}
			}, control)]);
		}
		/** Range control with product styling (class uitw-slider from enhancer.module.css).
		* Holds a local mirror of the value so the thumb tracks the pointer
		* immediately; external value changes (another surface editing the same knob)
		* are adopted via the effect. */
		function SliderControl({ min, max, step, value, onChange, unit }) {
			const [local, setLocal] = react.useState(value);
			react.useEffect(() => {
				setLocal(value);
			}, [value]);
			return react.createElement("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: 10,
				flex: "none"
			} }, [react.createElement("input", {
				key: "range",
				type: "range",
				min,
				max,
				step,
				value: local,
				className: "uitw-slider",
				style: {
					width: 160,
					accentColor: "var(--dsw-alias-brand-primary)"
				},
				onChange: (e) => {
					const next = Number(e.target.value);
					setLocal(next);
					onChange(next);
				}
			}), react.createElement("span", {
				key: "value",
				style: {
					width: 48,
					fontSize: 13,
					lineHeight: "20px",
					color: "var(--dsw-alias-label-secondary)",
					textAlign: "right",
					fontVariantNumeric: "tabular-nums"
				}
			}, `${local}${unit}`)]);
		}
		/** Product-style switch toggle (track + thumb). A controlled button that
		* flips on click; the active state uses the DeepSeek business blue.
		* Holds a local mirror of the value so the thumb slides and the fill changes
		* immediately on click; external value changes (another surface editing the
		* same switch) are adopted via the effect. Without the mirror the parent's
		* in-place state mutation never re-renders this component and the click gives
		* no visual feedback. */
		function SwitchControl({ checked, onChange }) {
			const [local, setLocal] = react.useState(checked);
			react.useEffect(() => {
				setLocal(checked);
			}, [checked]);
			const track = {
				position: "relative",
				display: "inline-flex",
				alignItems: "center",
				width: 36,
				height: 22,
				padding: 0,
				border: "none",
				borderRadius: 11,
				cursor: "pointer",
				background: local ? "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-border-l3)",
				transition: "background var(--ds-transition-duration-fast) var(--ds-ease-in-out)",
				flex: "none"
			};
			const thumb = {
				position: "absolute",
				top: 3,
				left: local ? 17 : 3,
				width: 16,
				height: 16,
				borderRadius: 8,
				background: "#fff",
				boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
				transition: "left var(--ds-transition-duration-fast) var(--ds-ease-in-out)"
			};
			return react.createElement("button", {
				type: "button",
				role: "switch",
				"aria-checked": local,
				style: track,
				onClick: () => {
					const next = !local;
					setLocal(next);
					onChange(next);
				}
			}, react.createElement("span", { style: thumb }));
		}
		/** The interface customization block registered in Settings -> General. */
		function SettingsGeneralRow({ state, onApply, presets }) {
			return react.createElement("div", { style: {
				display: "flex",
				flexDirection: "column"
			} }, [
				react.createElement(SettingsRow, {
					key: "width",
					title: getRowWidthTitle(),
					desc: getRowWidthDesc(),
					control: react.createElement(SliderControl, {
						min: 748,
						max: 1e3,
						step: 4,
						value: state.width,
						unit: "px",
						onChange: (v) => {
							onApply({ width: v });
						}
					})
				}),
				react.createElement(SettingsRow, {
					key: "font",
					title: getRowFontSizeTitle(),
					desc: getRowFontSizeDesc(),
					control: react.createElement(SliderControl, {
						min: 12,
						max: 20,
						step: 1,
						value: state.fontSize,
						unit: "px",
						onChange: (v) => {
							onApply({ fontSize: v });
						}
					})
				}),
				react.createElement(SettingsRow, {
					key: "sidebar",
					title: getRowSidebarSizeTitle(),
					desc: getRowSidebarSizeDesc(),
					control: react.createElement(SliderControl, {
						min: 12,
						max: 20,
						step: 1,
						value: state.sidebarSize,
						unit: "px",
						onChange: (v) => {
							onApply({ sidebarSize: v });
						}
					})
				}),
				react.createElement(SettingsRow, {
					key: "font-family",
					title: getRowFontTitle(),
					desc: getRowFontDesc(),
					control: react.createElement(FontSelector, {
						value: state.fontId,
						presets,
						onChange: (v) => {
							onApply({ fontId: v });
						}
					})
				}),
				react.createElement(SettingsRow, {
					key: "center-card",
					title: getRowCardTitle(),
					desc: getRowCardDesc(),
					control: react.createElement(SwitchControl, {
						checked: state.card,
						onChange: (v) => {
							onApply({ card: v });
						}
					})
				})
			]);
		}
		//#endregion
		//#region src/client/card-overlay.tsx
		/**
		* Harness UI Enhancer — rounded center-column card overlay.
		*
		* Other than a left sidebar, DeepSeek Harness's main content area is a flat
		* `--dsw-alias-bg-base` fill with no real card surface, separated only by the
		* neighbors' hairline borders. This component adds the "rounded card" chrome
		* the user asked for, non-invasively, without touching any harness source.
		*
		* Wrapped-card model (v0.8.0): the AppFrame's shell.overlay outlet is ITSELF
		* a stacking context (`z-index:20; position:absolute; inset:0`), so nothing
		* registered inside it can ever out-paint the session header (raised to 21 to
		* mask the widgets rail). Instead of fighting layers, the card is split by
		* painting surface:
		*
		* - The SESSION HEADER (the highest relevant element, z-21) carries the
		*   card's top edge while it exists: border-top + the 14px top-left radius,
		*   styled in enhancer.module.css under the card-on root class — so the card
		*   visibly WRAPS the header at zero pixel cost, and nothing can hide it.
		* - This overlay becomes a pure SHADOW CASTER in that mode: one transparent
		*   box spanning header + content (from the column's own top) casting
		*   --dsw-shadow-lv3, whose fringes read as the card's elevation, including
		*   the left bleed over the sidebar. No border/radius → no doubled lines,
		*   and the header never clips the shadow (it paints above it like content).
		* - Routes without a session header (e.g. trajectory) fall back to this box
		*   drawing the classic self-contained card: border-top + radius + shadow.
		*
		* Visibility is controlled purely by the `enhc-center-card-on` class on
		* <html> (flipped by applyState from the Settings toggle), so the component
		* stays mounted for cheap geometry tracking and a class flip turns its paint
		* on/off with zero re-render. All side effects are owned by the fiber.
		*/
		/** The overlay's top edge sits 1px below the column top so the drop shadow has
		* room to render inside the viewport (a flush top would clip it). */
		const TOP_SHIM = 1;
		/**
		* Find the center column element. The AppFrame wraps the conversation slot in
		* `div.centerCol`, and the slot outlet (whose wrapper is display:contents) is
		* its direct DOM child — a stable, hash-independent seam.
		* @returns the center column element, or null if not yet mounted.
		*/
		function findCenterColumn() {
			const slot = document.querySelector("[data-slot=\"conversation\"]");
			if (slot === null || slot === void 0) return null;
			const parent = slot.parentElement;
			if (parent === null || parent === void 0) return null;
			return parent;
		}
		/**
		* Passive rounded-card chrome overlay. Renders a transparent box aligned to
		* the center column; what it paints (full card vs. shadow only) comes from
		* `.enhc-center-card` / `.enhc-center-card-wrapped` in enhancer.module.css,
		* gated by the root class. Geometry tracks the column via ResizeObserver
		* (fires on sidebar drag / collapse, details open-close, window resize) plus
		* a slow settle poll so a transition-ended layout still lands correctly. The
		* wrapped flag re-evaluates on every measure so route switches (conversation
		* ↔ trajectory) flip the paint mode within ≤400ms without extra observers.
		*/
		function CenterColCard() {
			const [box, setBox] = react.useState(null);
			react.useEffect(() => {
				const col = findCenterColumn();
				if (col === null || col === void 0) return;
				let timer = null;
				let __lastBox = null; // [dsh-patch] 空转短路用
				const measure = () => {
					const r = col.getBoundingClientRect();
					const wrapped = document.querySelector("[data-slot='conversation.session.header'] > header") !== null;
					if (r.width > 0 && r.height > 0) {
						const __next = {
							left: r.left,
							top: r.top,
							width: r.width,
							height: r.height,
							wrapped
						};
						const __prev = __lastBox; // [dsh-patch] 未变则不重渲染
						if (
							__prev !== null &&
							__prev.left === __next.left &&
							__prev.top === __next.top &&
							__prev.width === __next.width &&
							__prev.height === __next.height &&
							__prev.wrapped === __next.wrapped
						) return;
						__lastBox = __next;
						setBox(__next);
					}
				};
				measure();
				const observer = new ResizeObserver(measure);
				observer.observe(col);
				window.addEventListener("resize", measure);
				timer = window.setInterval(() => {
					if (document.visibilityState === "hidden") return; // [dsh-patch] 隐藏时跳过同步布局
					measure();
				}, 400);
				return () => {
					observer.disconnect();
					window.removeEventListener("resize", measure);
					if (timer !== null) window.clearInterval(timer);
				};
			}, []);
			if (box === null) return react.createElement("div", { className: "enhc-center-card" });
			return react.createElement("div", {
				className: box.wrapped ? "enhc-center-card enhc-center-card-wrapped" : "enhc-center-card",
				style: {
					position: "absolute",
					left: box.left,
					top: box.top + TOP_SHIM,
					width: box.width,
					height: Math.max(box.height - TOP_SHIM, 0),
					pointerEvents: "none"
				}
			});
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Harness UI Enhancer — browser half entry（已裁剪：只留「界面定制」）。
		*
		* Registers one settings surface plus the rounded-card overlay:
		* - SettingsGeneralRow (order 30), the "界面定制" sizing block
		*   （对话内容宽度 / 对话字号 / 工作区字号 / UI 字体 / 圆角卡片）
		* - CenterColCard (shell.overlay), the rounded center-column card
		*
		* One shared EnhancerState lives in the apply closure; the surface receives
		* it plus an onApply callback that mutates it and pushes CSS. The fiber's
		* effect disposer removes the dynamic markdown style tag and root properties.
		*/
		/** Plugin id stamped on the dynamic style tag (loader unload sweep key). */
		const PLUGIN_ID = "dsh-theme-manager";
		/** Required services: the slot registry (React is a platform module). */
		const inject = ["slots"];
		/**
		* Client plugin body: restore persisted state, apply CSS, register surfaces.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			const state = loadState();
			applyState(state);
			ctx.effect(() => {
				applyState(state);
				return disposeDynamicStyle;
			}, `${PLUGIN_ID}: css lifecycle`);
			const patch = (next) => {
				Object.assign(state, next);
				applyState(state);
			};
			const surfaceProps = {
				state,
				onApply: patch,
				presets: FONT_PRESETS
			};
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "ui-enhancer",
				order: 30
			}, () => react.createElement(SettingsGeneralRow, surfaceProps)));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "enhancer-center-card",
				order: 30
			}, () => react.createElement(CenterColCard)));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;		}
		/* @@HARMONIZER-INLINE-END@@ */

		/** 挂载「界面定制」段（字号 / 宽度 / 字体 / 圆角卡片）。它抛错也不该拖垮本插件的其它功能（背景、主色调）。 */
		function applyHarmonizer(ctx) {
			try {
				const half = harmonizerHalf(require);
				if (half !== null && half !== undefined && typeof half.apply === "function") half.apply(ctx);
			} catch (error) {
				console.warn("[dsh-theme-manager] 界面定制段挂载失败（其它功能不受影响）：", error);
			}
		}

		/* ───────────────────────── 插件入口 ───────────────────────── */

		function apply(ctx) {
			ensureStyle();
			install();
			installBackground();
			applyHarmonizer(ctx);
			if (ctx && ctx.slots && typeof ctx.slots.inject === "function") {
				ctx.slots.inject("settings.section", () =>
					ctx.slots.register(
						{
							name: "settings.section",
							id: "theme-manager",
							order: 30,
							label: () => "主题"
						},
						ThemeManagerSettings
					)
				);
			}
		}

		exports.name = "dsh-theme-manager";
		exports.inject = ["slots"];
		exports.apply = apply;
		/** 供离线测试用的内部句柄（运行时不依赖）。 */
			exports.__internal = {
			ensureStyle: ensureStyle,
			applyPalette: applyPalette,
			getSnapshot: getSnapshot,
			install: install,
			normalizeColor: normalizeColor,
			paletteCss: paletteCss,
			refresh: refresh,
			resetPalette: resetPalette,
			resetSlot: resetSlot,
			setSlotColor: setSlotColor,
			slotValue: slotValue,
			toHex6: toHex6,
			PALETTE_SLOTS: PALETTE_SLOTS,
			/* 页面背景（图片 / 视频）：离线测试与页面调试都用得到。 */
			applyBackground: applyBackground,
			installBgClip: installBgClip,
			measureBgClip: measureBgClip,
			bgCss: bgCss,
			bgDefault: BG_DEFAULT,
			bgMediaUrl: bgMediaUrl,
			bgNormalize: bgNormalize,
			installBackground: installBackground,
			readBgCache: readBgCache,
			writeBgCache: persistBgCache,
			pushBackground: pushBackground,
			pullBackground: pullBackground,
			startBackgroundSync: startBackgroundSync,
			BG_API: BG_API,
			BG_LAYER_ID: BG_LAYER_ID,
			BG_STYLE_ID: BG_STYLE_ID,
			/* 合并进来的「界面统一」段（dsh-ui-harmonizer 逐字副本）。 */
			applyHarmonizer: applyHarmonizer,
			harmonizerHalf: harmonizerHalf
		};
		return module.exports;
	}
});
