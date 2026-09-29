// dsh-theme-manager — browser half.
//
// 目的：给 DSH 一个「主题管理」页 —— 把注入到页面里的每一个**主题层**列出来，
// 每层一个开关，开关立即生效且记在本机（localStorage），不用重启应用、也不用改
// 任何插件源码。以后装了别的主题插件，它的样式层会自动出现在这里。
//
// 什么是「主题层」：任何往 `document.head` 注入 `<style>`、并且**定义**了
// `--dsw-*` token 的样式表（`--dsw-[a-z0-9-]+\s*:`）。用「定义」而不是「出现」
// 作判据，是为了把只**引用** token 的功能性样式（布局修复、滚动条修补…）排除掉。
//
// 开关怎么做：`<style>.disabled = true` —— 浏览器原生属性，置真即整张样式表
// 失效，改回 false 立刻恢复；不需要插件配合，因此对第三方主题插件同样有效。
// 状态按「层标识」持久化，页面重新加载（或主题插件重建自己的 style 标签）后由
// 本插件重新应用 —— 靠 MutationObserver 盯住 head / body 的子节点变化。
//
// ⚠️ 托管边界（v0.2.0 重写，v0.1 在这里踩过坑）：
//   · 宿主的样式**不能**靠「标签带 id / data-* 属性」来判定 —— 官方
//     `@deepseek-ai/dsh-client-ui-theme` 把每个 CSS 文件都注入成
//     `<style data-plugin="@deepseek-ai/dsh-client-ui-theme" data-plugin-css="…/tokens.css">`，
//     按旧规则它们全被判成「可关闭」，而且 key 撞成同一个，一按「全部关闭」就把整套
//     `--dsw-*` token 关掉 → 整个界面失去样式。
//   · 现在分三类：
//       ① 本主题层（`data-dsh-claude-theme`）—— 自动托管，可直接开关（**自报优先**，
//          不管这张标签还带什么属性）；
//       ② 其它层 —— 默认**只读**，要在行尾点「接管」才纳入管理（用户显式确认）；
//       ③ 宿主层 —— 只有**官方 CSS 注入器加载的组件样式**才算：`data-plugin` 在官方
//          命名空间 **且**带 `data-plugin-css`（真实文件路径）。永远只读。
//   · 托管之外的层一律被强制 `disabled = false` —— 这同时是自愈：历史上被误关的
//     宿主样式，插件下次运行时会自己恢复。
//   · v0.5 修的坑（用户实测报障：主题页只剩调色盘能动）：v0.2–v0.4 把「带 data-plugin」
//     当宿主的同义词，但实测这个属性是**运行时统一补的来源标记**（值常是
//     `@deepseek-ai/dsh-api-remotes`，与真正注入者无关），于是 dsh-claude-theme 自己的
//     三层全被判成「宿主 · 只读」。同一原因还让 key 塌陷（8 张样式表共用一个值）。
//     现在：自报优先 + 宿主判据收紧到「官方 + 有 data-plugin-css」+ key 优先取 id。
//
// 卸载/回滚：删掉 profile `cordis.patch.yml` 里 id 为 theme-manager 的 insert 行
// + 重启应用；本插件的开关状态只影响本机 localStorage，不写入任何插件配置。
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
		/** 被关闭的层（层标识数组）。 */
		const OFF_KEY = "dsh-theme-manager:off.v1";
		/** 用户显式「接管」的层（只有它们才允许关闭；本主题的层自动托管）。 */
		const MANAGED_KEY = "dsh-theme-manager:managed.v1";
		/** token **定义**（不是 var() 引用）：`--dsw-alias-bg-base:` 这种。 */
		const TOKEN_DEF_RE = /--dsw-[a-z0-9-]+\s*:/g;
		/** 宿主 CSS 注入器的标记属性（官方各包统一用 `data-plugin` + `data-plugin-css`）。 */
		const HOST_PLUGIN_ATTR = "data-plugin";
		/** 官方命名空间：只有它们注入的样式才是「界面自身」，永久只读。 */
		const OFFICIAL_PLUGIN_RE = /^@deepseek-ai\//;
		/** dsh-claude-theme 四个层的友好名字（其余按标签标识显示）。 */
		const KNOWN_LAYERS = {
			"claude-theme:colors": "配色 token（暖米色皮肤）",
			"claude-theme:fonts": "衬线字体",
			"claude-theme:surface": "浮层实色（菜单不透明）",
			"claude-theme:badge": "徽章修补（推荐标签）"
		};

		/* ── 调色盘 ─────────────────────────────────────────────────────
		 * 用户选的每个颜色写进一张**独立**的 <style data-dsh-theme-manager="palette">，
		 * 选择器比主题的 COLOR_CSS 高一级（`html body:not(...)` = (0,2,2) 压 (0,1,1)），
		 * 所以主题层重建、或顺序变化都不会盖掉用户调的颜色。只作用于浅色模式：
		 * 暗色模式是另一套 token，混用会很难看。 */
		const PALETTE_KEY = "dsh-theme-manager:palette.v1";
		const PALETTE_STYLE_ID = "dsh-theme-manager-palette";
		const PALETTE_TAG = "palette";

		/* ── 菜单分组标题 ────────────────────────────────────────────────
		 * 官方 `._1weZzq_groupTitle`（模型选择 / 下拉菜单里「DeepSeek 账号」「GPT」这些
		 * 分组名）是 sticky 条，**又叠了一层** `background: var(--dsw-specific-menu)`：
		 * 面板本体已经用同一 token 做过毛玻璃（`.wGg57a_panel::before` + backdrop-filter），
		 * 标题在半透明面板上再叠一层半透明白 → 比面板亮一截，看着像一块「白色实心背景」。
		 * 这里把叠色换成**同款毛玻璃**：backdrop-filter 只模糊背后内容、不叠加颜色，
		 * 所以标题与面板颜色一致，同时保留吸顶时挡住滚动内容的能力。
		 * 选择器用属性子串（hash 前缀随版本变，后缀 `_groupTitle` 不变）。 */
		const MENU_KEY = "dsh-theme-manager:menu.v1";
		const MENU_STYLE_ID = "dsh-theme-manager-menu";
		const MENU_TAG = "menu";
		const MENU_FLAT_CSS = [
			"/* 菜单分组标题（「command」「heihi」「GPT」这些组名）：",
			"   官方是 sticky 吸顶条，且又叠了一层 --dsw-specific-menu；面板本身已经用同一个",
			"   token 做过毛玻璃，标题再叠一层 → 比面板亮一截，滚动到顶部吸顶时最明显。",
			"   这里把它变回普通流内元素、背景透明：颜色与面板完全一致，也没有「顶部那条」。",
			"   （吸顶时若要同色，只能靠 backdrop-filter 再采一次背面，实测会在顶部渲染成更亮的",
			"   一块，所以干脆不吸顶 —— 分组名跟随列表滚动。） */",
			'[class*="_groupTitle"] {',
			"  background: transparent !important;",
			"  backdrop-filter: none !important;",
			"  -webkit-backdrop-filter: none !important;",
			"  position: static !important;",
			"  top: auto !important;",
			"}"
		].join("\n");
		/** 调色盘槽位：一个槽 = 用户眼里的一个颜色 = 一组同族 token。 */
		const PALETTE_SLOTS = [
			{
				key: "brand",
				label: "品牌色 / 强调色",
				hint: "新会话按钮、选中态、侧栏高亮",
				tokens: ["--dsw-alias-brand-primary", "--dsw-alias-button-primary-fill", "--dsw-specific-sidebar-nav-item-active-accent"],
				fallback: "#D97757"
			},
			{
				key: "bg",
				label: "页面底色",
				hint: "会话区 / 侧栏底",
				tokens: ["--dsw-alias-bg-base", "--dsw-alias-bg-layer-1", "--dsw-specific-sidebar-fill"],
				fallback: "#FAF9F5"
			},
			{
				key: "surface",
				label: "卡片 / 次级表面",
				/* 刻意不含 `--dsw-menu-surface-fill` 与 `--dsw-specific-menu`：它们是模型选择
				   等 MenuSurface 浮层的表面色，用户要求这类菜单保持官方默认外观，主题与调色盘都不改。 */
				hint: "设置弹窗、卡片面、分组条（不含模型选择菜单）",
				tokens: ["--dsw-alias-bg-layer-2"],
				fallback: "#FAF9F5"
			},
			{
				key: "sunken",
				label: "次级底色",
				hint: "输入框、代码块、分组条",
				tokens: ["--dsw-alias-bg-layer-3", "--dsw-alias-bg-overlay", "--dsw-specific-input-major"],
				fallback: "#F0EEE6"
			},
			{
				key: "bubble",
				label: "气泡 / 高亮块",
				hint: "用户消息气泡",
				tokens: ["--dsw-specific-bubble", "--dsw-specific-bubble-highlight"],
				fallback: "#F0EEE6"
			},
			{
				key: "text",
				label: "主文字",
				hint: "正文、标题",
				tokens: ["--dsw-alias-label-primary", "--dsw-alias-label-primary-bluish"],
				fallback: "#141413"
			},
			{
				key: "textDim",
				label: "次要文字",
				hint: "副标题、参数说明",
				tokens: ["--dsw-alias-label-secondary", "--dsw-alias-label-primary-dimmed"],
				fallback: "#3D3D3A"
			},
			{
				key: "textMuted",
				label: "弱化文字",
				hint: "时间戳、占位符、分组标题",
				tokens: ["--dsw-alias-label-tertiary", "--dsw-alias-label-caption"],
				fallback: "#87867F"
			},
			{
				key: "border",
				label: "边框 / 分隔线",
				hint: "支持 rgba() 写半透明",
				tokens: ["--dsw-alias-border-l1", "--dsw-alias-border-l2", "--dsw-alias-border-l3"],
				fallback: "rgba(20,20,19,0.10)"
			}
		];
		/** 现成配色，一键铺满整块调色盘。 */
		const PALETTE_PRESETS = [
			{ key: "claude", label: "Claude 暖米色", swatch: "#D97757", colors: {} },
			{
				key: "graphite",
				label: "石墨灰 + 琥珀",
				swatch: "#E0A458",
				colors: { brand: "#C98A3A", bg: "#F6F6F4", surface: "#FFFFFF", sunken: "#ECECE8", bubble: "#ECECE8", text: "#181A1B", textDim: "#3F4447", textMuted: "#878C90", border: "rgba(24,26,27,0.12)" }
			},
			{
				key: "ocean",
				label: "海蓝",
				swatch: "#2F7FD1",
				colors: { brand: "#2F7FD1", bg: "#F4F7FB", surface: "#FFFFFF", sunken: "#E6EDF6", bubble: "#E6EDF6", text: "#0F1720", textDim: "#38495C", textMuted: "#8194A8", border: "rgba(15,23,32,0.12)" }
			},
			{
				key: "forest",
				label: "森绿",
				swatch: "#3F8F5B",
				colors: { brand: "#3F8F5B", bg: "#F4F8F4", surface: "#FFFFFF", sunken: "#E6F0E8", bubble: "#E6F0E8", text: "#111A13", textDim: "#3A4C3E", textMuted: "#84988A", border: "rgba(17,26,19,0.12)" }
			},
			{
				key: "violet",
				label: "雾紫",
				swatch: "#7C6BD6",
				colors: { brand: "#7C6BD6", bg: "#F7F5FC", surface: "#FFFFFF", sunken: "#EBE7F7", bubble: "#EBE7F7", text: "#16121F", textDim: "#443C5C", textMuted: "#928AA8", border: "rgba(22,18,31,0.12)" }
			},
			{
				key: "ink",
				label: "纯白 + 墨黑",
				swatch: "#1A1A1A",
				colors: { brand: "#1A1A1A", bg: "#FFFFFF", surface: "#FFFFFF", sunken: "#F2F2F2", bubble: "#F2F2F2", text: "#111111", textDim: "#3D3D3D", textMuted: "#8A8A8A", border: "rgba(0,0,0,0.12)" }
			}
		];

		/* ───────────────────────── 状态存储 ───────────────────────── */

		function readList(key) {
			try {
				const raw = window.localStorage.getItem(key);
				if (raw === null) return [];
				const parsed = JSON.parse(raw);
				return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
			} catch (error) {
				return [];
			}
		}

		function writeList(key, list) {
			try {
				window.localStorage.setItem(key, JSON.stringify(list));
			} catch (error) {
				/* 隐私模式 / 配额满：开关仍然当场生效，只是不记忆 */
			}
		}

		function readOff() {
			/* 清掉 v0.1 旧规则留下的宿主层标识（`attr:data-plugin=…`）：它们既不该被关，
			 * 也永远匹配不到新 key。 */
			return readList(OFF_KEY).filter((key) => key.indexOf("attr:data-plugin=") !== 0);
		}

		function writeOff(list) {
			writeList(OFF_KEY, list);
		}

		function readManaged() {
			return readList(MANAGED_KEY);
		}

		function writeManaged(list) {
			writeList(MANAGED_KEY, list);
		}

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

		/** 菜单分组标题模式：只认 `"official"`（官方叠色），其余一律当 `"flat"`（跟随面板）。 */
		function readMenuFlat() {
			try {
				return window.localStorage.getItem(MENU_KEY) !== "official";
			} catch (error) {
				return true;
			}
		}

		function persistMenu() {
			try {
				window.localStorage.setItem(MENU_KEY, menuFlat ? "flat" : "official");
			} catch (error) {
				/* 同上：写不进去也仍然当场生效 */
			}
		}

		let off = new Set(readOff());
		let managed = new Set(readManaged());
		let palette = readPalette();
		/** 菜单分组标题：默认 `flat`（跟随面板毛玻璃），可切回 `official`（官方叠色）。 */
		let menuFlat = readMenuFlat();
		const listeners = new Set();
		let snapshot = { layers: [], off: new Set(), managed: new Set(), palette: {}, menuFlat: true, bg: null, bgNotice: null, version: 0 };

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
				layers: scanLayers(),
				off: new Set(off),
				managed: new Set(managed),
				palette: Object.assign({}, palette),
				menuFlat: menuFlat,
				bg: bg,
				bgNotice: bgNotice,
				version: snapshot.version + 1
			};
			emit();
		}

		/* ───────────────────────── 主题层识别 ───────────────────────── */

		/** 内容哈希：给没有 id / data 属性的标签一个尽量稳定的标识。 */
		function hashCss(css) {
			let hash = 5381;
			const text = css.slice(0, 4096);
			for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
			return hash.toString(16);
		}

		/**
		 * 该样式表是不是一个主题层。两条判据，命中其一即可：
		 *   ① 通用：**定义**了 DSH 主题 token（`--dsw-xxx:`）—— 第三方主题走的这条；
		 *   ② 自报：标签带 `data-dsh-claude-theme` —— 本主题的「字体」「徽章」两层只改
		 *      color / font-family，不定义 token，只能靠插件自报的属性认出来。
		 * 只 `var(--dsw-…)` 引用的功能性样式两条都不命中，不会被误列。
		 */
		function isThemeLayer(el) {
			if (el.getAttribute("data-dsh-claude-theme")) return true;
			return /--dsw-[a-z0-9-]+\s*:/.test(el.textContent || "");
		}

		/**
		 * 该样式表是不是「宿主」—— 也就是界面自身的组件样式（关掉会缺胳膊少腿）。
		 *
		 * ⚠️ 这里连着踩了两版坑，判据最终收敛成一件事：**官方 CSS 注入器加载的组件样式表**
		 * = 有 `data-plugin-css`（真实文件路径）**且** `data-plugin` 在官方命名空间。
		 *
		 *   1. v0.2 把「带 data-plugin」当宿主的同义词 —— 但 DSH 运行时会给「经它注入的
		 *      样式」统一补一个 `data-plugin`，实测值是 `@deepseek-ai/dsh-api-remotes`，
		 *      **与真正注入者无关**（dsh-ui-fixes / dsh-memory / dsh-todo-float 的样式层
		 *      都被标成它）。于是 dsh-claude-theme 自己的三层（同时带 `data-dsh-claude-theme`
		 *      与 `data-plugin=@deepseek-ai/dsh-api-remotes`）全被判成宿主 → 行尾只剩
		 *      「宿主 · 只读」，用户再也关不掉任何一层，页面上能动的只剩调色盘。
		 *   2. 那就把「官方命名空间」当宿主？也不行：上面那批运行时标记正好也叫
		 *      `@deepseek-ai/*`。真正的官方组件样式人人都带 `data-plugin-css`
		 *      （`@deepseek-ai/dsh-client-ui-theme/tokens.css` 这种），运行时补的标记没有。
		 *
		 * 再加一条**自报优先**：带 `data-dsh-claude-theme` 的层永远是「本主题层」，
		 * 不管它还带什么属性。
		 */
		function isHostLayer(el) {
			if (el.getAttribute("data-dsh-claude-theme") !== null) return false;
			const plugin = el.getAttribute(HOST_PLUGIN_ATTR);
			if (plugin === null) return false;
			if (el.getAttribute("data-plugin-css") === null) return false;
			return OFFICIAL_PLUGIN_RE.test(plugin);
		}

		function dataAttrs(el) {
			const out = [];
			const attrs = el.attributes;
			for (let i = 0; i < attrs.length; i++) {
				const name = attrs[i].name;
				if (name.indexOf("data-") === 0 && name !== OWN_ATTR) out.push({ name: name, value: attrs[i].value });
			}
			return out;
		}

		/**
		 * 稳定且**唯一**的层标识。
		 *
		 * v0.1 只取「第一个 data-* 属性」→ 官方 ui-theme 的十几个 `data-plugin="…"`
		 * 标签塌成同一个 key（一关就全关）。
		 * v0.2 起按 `data-plugin-css` → `data-plugin` 取 key，但仍不够：实测页面上
		 * `data-plugin="@deepseek-ai/dsh-api-remotes"` 被 **8 张**样式表共用，
		 * `data-plugin="dsh-ui-fixes"` 被 7 张共用（这个属性由运行时统一补，不区分来源）。
		 * 于是现在：
		 *   ① 自报的 `data-dsh-claude-theme` 最高优先；
		 *   ② 其次 `id`（页面里 dsh-*-style 这类标签基本都有）；
		 *   ③ 再其次 `data-plugin-css`（官方组件样式逐文件唯一）；
		 *   ④ 只有 `data-plugin` 时，拼上**内容哈希**兜底，避免同值塌陷。
		 */
		function layerKey(el) {
			const own = el.getAttribute("data-dsh-claude-theme");
			if (own) return "claude-theme:" + own;
			if (el.id) return "id:" + el.id;
			const css = el.getAttribute("data-plugin-css");
			if (css !== null) return "plugin:" + css;
			const plugin = el.getAttribute(HOST_PLUGIN_ATTR);
			if (plugin !== null) return "plugin:" + plugin + "#" + hashCss(el.textContent || "");
			const attrs = dataAttrs(el);
			if (attrs.length > 0) return "attr:" + attrs.map((a) => a.name + "=" + a.value).join("&");
			return "hash:" + hashCss(el.textContent || "");
		}

		/** 标签是否带可识别标识（id 或自报的 data-* 属性）。无标识的层无法判断归属，
		 *  和宿主层一样只读 —— 「接管」只对能认出来的层开放。 */
		function hasIdentity(el) {
			if (el.id) return true;
			return dataAttrs(el).length > 0;
		}

		/** 可关闭 = 本主题层（自动托管）或用户显式接管的层；宿主层永远不行。 */
		function isManaged(el) {
			if (isHostLayer(el)) return false;
			if (el.getAttribute("data-dsh-claude-theme")) return true;
			return managed.has(layerKey(el));
		}

		function tokenNames(css) {
			const found = css.match(TOKEN_DEF_RE) || [];
			const unique = [];
			const seen = new Set();
			for (const item of found) {
				const name = item.replace(/\s*:$/, "");
				if (seen.has(name)) continue;
				seen.add(name);
				unique.push(name);
			}
			return unique;
		}

		/** 展示用来源描述：把 id / css 路径 / data-plugin 都摊开写，出问题一眼能对上 DOM。 */
		function originOf(el) {
			const own = el.getAttribute("data-dsh-claude-theme");
			const plugin = el.getAttribute(HOST_PLUGIN_ATTR);
			const css = el.getAttribute("data-plugin-css");
			if (isHostLayer(el)) return "宿主样式 · " + (css !== null ? css : plugin);
			const parts = [];
			if (own) parts.push("data-dsh-claude-theme=" + own);
			if (el.id) parts.push("id=" + el.id);
			if (css !== null) parts.push(css);
			if (plugin !== null) parts.push("data-plugin=" + plugin);
			if (parts.length === 0) {
				const attrs = dataAttrs(el);
				if (attrs.length > 0) parts.push(attrs[0].name + (attrs[0].value ? "=" + attrs[0].value : ""));
			}
			return parts.length > 0 ? parts.join(" · ") : "无标识";
		}

		/** 展示用名字：自报层用中文别名，其次 id，再其次 css 文件名 / 包名。 */
		function nameOf(el, key) {
			/* 插件自报的友好名（合并进来的「界面统一」段会给自己的动态层打上这个属性）。 */
			const friendly = el.getAttribute("data-dsh-theme-manager-layer");
			if (friendly) return friendly;
			const own = el.getAttribute("data-dsh-claude-theme");
			if (own) return KNOWN_LAYERS[key] || "dsh-claude-theme · " + own;
			if (el.id) return el.id.replace(/-style$/, "");
			const css = el.getAttribute("data-plugin-css");
			if (css !== null) return css.split("/").pop();
			const plugin = el.getAttribute(HOST_PLUGIN_ATTR);
			if (plugin !== null) return plugin;
			const attrs = dataAttrs(el);
			if (attrs.length > 0) return attrs[0].value || attrs[0].name;
			return "无标识样式表";
		}

		function listStyleTags() {
			if (typeof document === "undefined" || !document.head) return [];
			const out = [];
			for (const el of Array.from(document.head.querySelectorAll("style"))) {
				/* 本插件自己的标签（配置层 "own" 与调色盘层 "palette"）都不参与扫描 ——
				 * 调色盘本身就定义了 --dsw-*，不排除的话会把自己列成一个可关的层。 */
				if (el.getAttribute(OWN_ATTR) !== null) continue;
				out.push(el);
			}
			return out;
		}

		function scanLayers() {
			const layers = [];
			for (const el of listStyleTags()) {
				if (!isThemeLayer(el)) continue;
				const css = el.textContent || "";
				const key = layerKey(el);
				const tokens = tokenNames(css);
				const host = isHostLayer(el);
				const own = el.getAttribute("data-dsh-claude-theme") !== null;
				const managedNow = isManaged(el);
				layers.push({
					key: key,
					group: own ? "claude-theme" : host ? "host" : "other",
					name: nameOf(el, key),
					origin: originOf(el),
					tokenCount: tokens.length,
					sample: tokens.slice(0, 3).join("  "),
					hostLayer: host,
					manageable: managedNow,
					canTakeOver: !host && !managedNow && hasIdentity(el),
					disabled: managedNow && off.has(key)
				});
			}
			const rank = { "claude-theme": 0, other: 1, host: 2 };
			layers.sort((a, b) => rank[a.group] - rank[b.group]);
			return layers;
		}

		/* ───────────────────────── 应用 / 开关 ───────────────────────── */

		/** 把持久化的开关状态应用到当前 DOM（每次 DOM 变化后重跑，幂等）。
		 *  托管之外的层一律强制恢复（自愈：历史上被误关的宿主样式会自己回来）。 */
		function applyDisabled() {
			for (const el of listStyleTags()) {
				if (!isThemeLayer(el)) continue;
				const want = isManaged(el) && off.has(layerKey(el));
				if (el.disabled !== want) el.disabled = want;
			}
		}

		function persist() {
			writeOff(Array.from(off));
		}

		function toggleLayer(key) {
			if (off.has(key)) off.delete(key);
			else off.add(key);
			persist();
			applyDisabled();
			refresh();
		}

		/** 显式接管：把一个原本只读的层纳入管理（默认保持「开」，不改视觉）。 */
		function takeOver(key) {
			managed.add(key);
			writeManaged(Array.from(managed));
			refresh();
		}

		/** 交还管理权：从托管集合里移除，并把该层恢复为启用。 */
		function release(key) {
			managed.delete(key);
			off.delete(key);
			writeManaged(Array.from(managed));
			persist();
			applyDisabled();
			refresh();
		}

		function setAllDisabled(nextOff) {
			for (const layer of snapshot.layers) {
				if (!layer.manageable) continue;
				if (nextOff) off.add(layer.key);
				else off.delete(layer.key);
			}
			persist();
			applyDisabled();
			refresh();
		}

		function rescan() {
			applyDisabled();
			refresh();
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

		/** 按当前模式注入 / 撤掉菜单分组标题的修补（幂等）。 */
		function applyMenuFix() {
			if (typeof document === "undefined" || !document.head) return;
			let el = document.getElementById(MENU_STYLE_ID);
			if (!menuFlat) {
				if (el !== null && typeof el.remove === "function") el.remove();
				return;
			}
			if (el === null) {
				el = document.createElement("style");
				el.id = MENU_STYLE_ID;
				el.setAttribute(OWN_ATTR, MENU_TAG);
				document.head.appendChild(el);
			}
			if (el.textContent !== MENU_FLAT_CSS) el.textContent = MENU_FLAT_CSS;
		}

		function setMenuFlat(next) {
			const value = next === true;
			if (menuFlat === value) return;
			menuFlat = value;
			persistMenu();
			applyMenuFix();
			refresh();
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

		/** 套用现成配色（`claude` 预设 = 清空覆盖，回到主题原色）。 */
		function applyPreset(presetKey) {
			const preset = PALETTE_PRESETS.filter((item) => item.key === presetKey)[0];
			if (!preset) return;
			const next = {};
			for (const key of Object.keys(preset.colors)) {
				const color = normalizeColor(preset.colors[key]);
				if (color !== null) next[key] = color;
			}
			palette = next;
			persistPalette();
			applyPalette();
			refresh();
		}

		let observer = null;

		function install() {
			persist(); /* 把 v0.1 过滤掉的脏标识写回，保证 localStorage 里不留失效 key */
			applyPalette();
			applyMenuFix();
			applyDisabled();
			refresh();
			if (observer !== null) return;
			if (typeof MutationObserver === "undefined") return;
			observer = new MutationObserver(() => {
				applyDisabled();
				refresh();
			});
			if (document.head) observer.observe(document.head, { childList: true });
			if (document.body) observer.observe(document.body, { childList: true });
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
		/* 白字模式的文字与组件必须成套切换：只改 color 会让输入框白底白字。
		   这些变量局限于列容器，不影响弹窗、设置页之外的 portal 或用户的全局主题。 */
		const BG_DARK_TOKENS = [
			"color-scheme: dark",
			"--dsw-alias-bg-base: #1F1E1C",
			"--dsw-alias-bg-layer-1: #262523",
			"--dsw-alias-bg-layer-2: #2B2A27",
			"--dsw-alias-bg-layer-3: #302E2B",
			"--dsw-alias-bg-overlay: #3A3835",
			"--dsw-alias-bg-module-platform: #262523",
			"--dsw-specific-sidebar-fill: #201F1D",
			"--dsw-specific-sidebar-nav-item-active: #2B2A27",
			"--dsw-specific-sidebar-nav-item-hover: #262523",
			"--dsw-specific-input-major: #262523",
			"--dsw-specific-bubble: #2B2A27",
			"--dsw-specific-bubble-highlight: #302E2B",
			"--dsw-specific-selector: #2B2A27",
			"--dsw-alias-label-primary: #F0EEE6",
			"--dsw-alias-label-primary-bluish: #F0EEE6",
			"--dsw-alias-label-primary-dimmed: #D4D1C8",
			"--dsw-alias-label-secondary: #D4D1C8",
			"--dsw-alias-label-tertiary: #B6B3A9",
			"--dsw-alias-label-caption: #A6A39A",
			"--dsw-alias-label-primary-foreground: #141413",
			"--dsw-alias-label-primary-inverted: #141413",
			"--dsw-alias-border-l1: rgba(240,238,230,.08)",
			"--dsw-alias-border-l2: rgba(240,238,230,.12)",
			"--dsw-alias-border-l3: rgba(240,238,230,.16)",
			"--dsw-alias-border-l4: rgba(240,238,230,.22)",
			"--dsw-alias-interactive-bg-hover: rgba(240,238,230,.08)",
			"--dsw-alias-interactive-bg-hover-solid: #302E2B",
			"--dsw-alias-interactive-bg-active: rgba(240,238,230,.14)",
			"--dsw-alias-button-elevated-fill: #2B2A27",
			"--dsw-alias-button-floating-hover: #302E2B",
			"--dsw-alias-markdown-code-block: #262523",
			"--dsw-alias-markdown-inline-code: #2B2A27",
			"--dsw-alias-link: #9BC4FF",
			"--dsw-alias-scrollbar-bg-l1: #4A4844",
			"--dsw-alias-scrollbar-bg-l2: #4A4844"
		].join("; ");
		const BG_LIGHT_TOKENS = [
			"color-scheme: light",
			"--dsw-alias-bg-base: #FAF9F7",
			"--dsw-alias-bg-layer-1: #F5F4F1",
			"--dsw-alias-bg-layer-2: #F0EFEC",
			"--dsw-alias-bg-layer-3: #EAE9E5",
			"--dsw-alias-bg-overlay: #FFFFFF",
			"--dsw-alias-bg-module-platform: #F5F4F1",
			"--dsw-specific-sidebar-fill: #F6F5F2",
			"--dsw-specific-sidebar-nav-item-active: #EAE9E5",
			"--dsw-specific-sidebar-nav-item-hover: #F0EFEC",
			"--dsw-specific-input-major: #FFFFFF",
			"--dsw-specific-bubble: #F0EFEC",
			"--dsw-specific-bubble-highlight: #EAE9E5",
			"--dsw-specific-selector: #EAE9E5",
			"--dsw-alias-label-primary: #191919",
			"--dsw-alias-label-primary-bluish: #191919",
			"--dsw-alias-label-primary-dimmed: #333333",
			"--dsw-alias-label-secondary: #414141",
			"--dsw-alias-label-tertiary: #626262",
			"--dsw-alias-label-caption: #737373",
			"--dsw-alias-label-primary-foreground: #FFFFFF",
			"--dsw-alias-label-primary-inverted: #FFFFFF",
			"--dsw-alias-border-l1: rgba(25,25,25,.08)",
			"--dsw-alias-border-l2: rgba(25,25,25,.12)",
			"--dsw-alias-border-l3: rgba(25,25,25,.16)",
			"--dsw-alias-border-l4: rgba(25,25,25,.22)",
			"--dsw-alias-interactive-bg-hover: rgba(25,25,25,.06)",
			"--dsw-alias-interactive-bg-hover-solid: #EAE9E5",
			"--dsw-alias-interactive-bg-active: rgba(25,25,25,.12)",
			"--dsw-alias-button-elevated-fill: #FFFFFF",
			"--dsw-alias-button-floating-hover: #F0EFEC",
			"--dsw-alias-markdown-code-block: #F0EFEC",
			"--dsw-alias-markdown-inline-code: #EAE9E5",
			"--dsw-alias-link: #175CD3",
			"--dsw-alias-scrollbar-bg-l1: #CAC8C2",
			"--dsw-alias-scrollbar-bg-l2: #CAC8C2"
		].join("; ");

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
				/* 手动黑字 / 白字：按列覆盖成套文本和组件变量，绝不随视频画面自行翻转。 */
				const textTokens = state.textColor === "white" ? BG_DARK_TOKENS : BG_LIGHT_TOKENS;
				const textShadow = state.textColor === "white" ? "0 1px 3px rgba(0,0,0,.7)" : "0 1px 3px rgba(255,255,255,.85)";
				rows.push(`${CARD_SIDEBAR}, ${CARD_MAIN} { ${textTokens}; color: var(--dsw-alias-label-primary); text-shadow: ${textShadow}; }`);
				/* macOS 原生“新会话”按钮写死了白色，需跟着当前文字模式切换。 */
				rows.push(`${CARD_SIDEBAR} [class$="_newSession"] { background: color-mix(in srgb, var(--dsw-specific-input-major) 88%, transparent) !important; color: var(--dsw-alias-label-primary) !important; }`);
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
				version: "0.8.5",
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
			".dsh-theme-manager-row[data-off=true] .dsh-theme-manager-row-name{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}",
			".dsh-theme-manager-empty{padding:14px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-theme-manager-badge{flex:none;padding:2px 8px;border-radius:999px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);background:var(--dsw-alias-bg-layer-3)}",
			".dsh-theme-manager-mini{flex:none;height:26px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}",
			".dsh-theme-manager-mini:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-theme-manager-switch{flex:none;position:relative;box-sizing:border-box;width:38px;height:22px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-bg-layer-3);cursor:pointer;transition:background .16s ease}",
			".dsh-theme-manager-switch[data-on=true]{background:var(--dsw-alias-brand-primary,var(--dsw-specific-sidebar-nav-item-active-accent,#D97757))}",
			".dsh-theme-manager-switch-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .16s ease}",
			".dsh-theme-manager-switch[data-on=true] .dsh-theme-manager-switch-knob{transform:translateX(16px)}",
			".dsh-theme-manager-actions{display:flex;flex-wrap:wrap;gap:8px}",
			".dsh-theme-manager-btn{box-sizing:border-box;height:30px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}",
			".dsh-theme-manager-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-theme-manager-note{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-theme-manager-note code{padding:0 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-3);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}",
			".dsh-theme-manager-warn{display:flex;align-items:center;gap:10px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
			".dsh-theme-manager-warn-main{flex:1;min-width:0}",
			".dsh-theme-manager-palette-row{display:flex;align-items:center;gap:10px;padding:9px 12px;border-top:0.5px solid var(--dsw-alias-border-l1)}",
			".dsh-theme-manager-palette-row:first-of-type{border-top:none}",
			".dsh-theme-manager-palette-main{flex:1;min-width:0}",
			".dsh-theme-manager-color{flex:none;width:36px;height:26px;padding:0;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;cursor:pointer}",
			".dsh-theme-manager-hex{flex:none;width:132px;height:26px;box-sizing:border-box;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}",
			".dsh-theme-manager-hex[data-invalid=true]{border-color:var(--dsw-alias-state-error-primary,#c0392b);color:var(--dsw-alias-state-error-primary,#c0392b)}",
			".dsh-theme-manager-presets{display:flex;flex-wrap:wrap;gap:6px;padding:10px 12px;border-top:0.5px solid var(--dsw-alias-border-l1)}",
			".dsh-theme-manager-swatch{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}",
			".dsh-theme-manager-swatch:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-theme-manager-swatch[data-active=true]{border-color:var(--dsw-alias-brand-primary,var(--dsw-specific-sidebar-nav-item-active-accent,#D97757));color:var(--dsw-alias-label-primary)}",
			".dsh-theme-manager-swatch i{display:inline-block;width:10px;height:10px;border-radius:50%;border:0.5px solid var(--dsw-alias-border-l3)}",
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

		function LayerRow(props) {
			const layer = props.layer;
			const on = !layer.disabled;
			const tail = layer.manageable
				? h(Switch, {
						on: on,
						label: (on ? "关闭 " : "开启 ") + layer.name,
						testId: "theme-manager-switch-" + layer.key,
						onToggle: () => toggleLayer(layer.key)
					})
				: layer.canTakeOver
					? h(
							"button",
							{
								type: "button",
								className: "dsh-theme-manager-mini",
								"data-testid": "theme-manager-takeover-" + layer.key,
								onClick: () => takeOver(layer.key)
							},
							"接管"
						)
					: h("span", { className: "dsh-theme-manager-badge" }, layer.hostLayer ? "宿主 · 只读" : "只读");
			return h(
				"div",
				{ className: "dsh-theme-manager-row", "data-off": String(layer.disabled) },
				h(
					"div",
					{ className: "dsh-theme-manager-row-main" },
					h("div", { className: "dsh-theme-manager-row-name" }, layer.name),
					h(
						"div",
						{ className: "dsh-theme-manager-row-meta" },
						layer.origin + " · " + layer.tokenCount + " 个 token" + (layer.sample ? " · " + layer.sample + " …" : "")
					)
				),
				tail
			);
		}

		function Group(props) {
			return h(
				"div",
				{ className: "dsh-theme-manager-group" },
				h(
					"div",
					{ className: "dsh-theme-manager-group-head" },
					h("span", { className: "dsh-theme-manager-group-title" }, props.title),
					h("span", { className: "dsh-theme-manager-group-count" }, props.layers.length + " 层")
				),
				props.layers.length === 0
					? h("div", { className: "dsh-theme-manager-empty" }, props.empty)
					: props.layers.map((layer) => h(LayerRow, { key: layer.key, layer: layer }))
			);
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
						h("div", { className: "dsh-theme-manager-row-meta" }, "面板 / 全部透出时生效；黑字与白字手动切换，输入框一起变色")
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
						h("div", { className: "dsh-theme-manager-row-meta" }, slot.hint + " · 影响 " + slot.tokens.length + " 个 token")
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

			const presets = PALETTE_PRESETS.map((preset) =>
				h(
					"button",
					{
						type: "button",
						key: preset.key,
						className: "dsh-theme-manager-swatch",
						"data-active": String(customCount === 0 && preset.key === "claude"),
						"data-testid": "theme-manager-preset-" + preset.key,
						title: "套用这套配色",
						onClick: () => applyPreset(preset.key)
					},
					h("i", { style: { background: preset.swatch }, "aria-hidden": true }),
					preset.label
				)
			);

			return h(
				"div",
				{ className: "dsh-theme-manager-group" },
				h(
					"div",
					{ className: "dsh-theme-manager-group-head" },
					h("span", { className: "dsh-theme-manager-group-title" }, "调色盘（浅色模式）"),
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
					presets,
					h(
						"button",
						{
							type: "button",
							className: "dsh-theme-manager-mini",
							"data-testid": "theme-manager-palette-reset",
							onClick: resetPalette
						},
						"恢复默认配色"
					),
					h(
						"button",
						{
							type: "button",
							className: "dsh-theme-manager-mini",
							"data-testid": "theme-manager-menu-group-toggle",
							title:
								"菜单里的分组标题（「DeepSeek 账号」「GPT」这些）官方在毛玻璃面板上又叠了一层半透明白，比面板亮一截。" +
								"「跟随面板」= 把叠色换成同款毛玻璃（颜色与面板一致，吸顶时照样挡住滚动内容）；「官方叠色」= 回到官方原样。",
							onClick: () => setMenuFlat(state.menuFlat !== true)
						},
						state.menuFlat !== false ? "菜单分组标题 · 跟随面板" : "菜单分组标题 · 官方叠色"
					)
				)
			);
		}

		function ThemeManagerSettings() {
			const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
			const [showHost, setShowHost] = React.useState(false);
			const themeLayers = state.layers.filter((layer) => layer.group === "claude-theme");
			const otherLayers = state.layers.filter((layer) => layer.group === "other");
			const hostLayers = state.layers.filter((layer) => layer.group === "host");
			const offCount = state.layers.filter((layer) => layer.disabled).length;
			/* 「配色层被关着」是最容易被误解的状态：界面看起来像"主题不见了"，其实是
			 * 主题的 token 覆盖被关掉、颜色回落到官方默认或下面调色盘的值。 */
			const colorsLayer = state.layers.filter((layer) => layer.key === "claude-theme:colors")[0];
			const colorsOff = colorsLayer !== undefined && colorsLayer.disabled === true;
			return h(
				"div",
				{ className: "dsh-theme-manager-root" },
				h(
					"div",
					null,
					h(
						"div",
						{ className: "dsh-theme-manager-intro-desc" },
						"页面上每一个定义了 ",
						h("code", null, "--dsw-*"),
						" token 的样式表都算一个「主题层」。本主题（dsh-claude-theme）的层可以直接开关；别的插件的层点「接管」后也能开关；只有界面自身的组件样式（官方包经 CSS 注入器加载的那些）是只读的。当前共 ",
						state.layers.length,
						" 层，其中 ",
						offCount,
						" 层已关闭。"
					)
				),
				colorsOff
					? h(
							"div",
							{ className: "dsh-theme-manager-warn", "data-testid": "theme-manager-colors-off" },
							h(
								"div",
								{ className: "dsh-theme-manager-warn-main" },
								"⚠ 主题的「配色 token」层当前是关闭的 —— 界面上的颜色来自官方默认或下面的调色盘，不是 dsh-claude-theme 的暖米色。"
							),
							h(
								"button",
								{
									type: "button",
									className: "dsh-theme-manager-mini",
									"data-testid": "theme-manager-colors-on",
									onClick: () => toggleLayer("claude-theme:colors")
								},
								"开启配色层"
							)
						)
					: null,
				h(Group, {
					title: "当前主题 · dsh-claude-theme",
					layers: themeLayers,
					empty: "没检测到 dsh-claude-theme 的样式层 —— 插件可能没有挂载。"
				}),
				h(BackgroundCard, { key: "background" }),
				h(PaletteCard, { key: "palette" }),
				h(Group, {
					title: "其它主题层（点「接管」后才可开关）",
					layers: otherLayers,
					empty: "除了本主题以外，目前没有别的插件在改 --dsw-* token。装了新的主题插件后，它的层会自动出现在这里。"
				}),
				h(
					"div",
					{ className: "dsh-theme-manager-group" },
					h(
						"div",
						{ className: "dsh-theme-manager-group-head" },
						h("span", { className: "dsh-theme-manager-group-title" }, "宿主样式（只读 · 关掉整个界面会失去样式）"),
						h(
							"button",
							{ type: "button", className: "dsh-theme-manager-mini", onClick: () => setShowHost(!showHost) },
							(showHost ? "收起" : "展开") + " " + hostLayers.length + " 层"
						)
					),
					showHost
						? hostLayers.length === 0
							? h("div", { className: "dsh-theme-manager-empty" }, "没有检测到宿主样式层。")
							: hostLayers.map((layer) => h(LayerRow, { key: layer.key, layer: layer }))
						: h(
								"div",
								{ className: "dsh-theme-manager-empty" },
								"宿主（官方包）注入的 " + hostLayers.length + " 张样式表折叠在这里，始终启用。"
							)
				),
				h(
					"div",
					{ className: "dsh-theme-manager-actions" },
					h(
						"button",
						{ type: "button", className: "dsh-theme-manager-btn", onClick: () => setAllDisabled(false) },
						"全部开启"
					),
					h(
						"button",
						{ type: "button", className: "dsh-theme-manager-btn", onClick: () => setAllDisabled(true) },
						"全部关闭（只影响已接管的层）"
					),
					h("button", { type: "button", className: "dsh-theme-manager-btn", onClick: rescan }, "重新扫描")
				),
				h(
					"div",
					{ className: "dsh-theme-manager-note" },
					"· 开关是「页面级」的：被关掉的层在下次打开页面时由本插件重新关闭；要彻底移除某个主题插件，请到「设置 → 插件」里卸载它。",
					h("br"),
					"· 只有官方 CSS 注入器加载的组件样式（带 ",
					h("code", null, "data-plugin-css"),
					" 的官方包）会被强制保持启用；页面上那个 ",
					h("code", null, "data-plugin"),
					" 属性是运行时统一补的来源标记（实测常是 ",
					h("code", null, "@deepseek-ai/dsh-api-remotes"),
					"，与真正注入者无关），不影响开关。"
				)
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
		const css = ":root{--enhancer-content-width:748px;--enhancer-font-size:14px;--enhancer-font-line:21px;--enhancer-sidebar-scale:1;--enhancer-chat-scale:1}div[data-phase]{--dsh-chat-content-width:var(--enhancer-content-width)}[data-input-scroll],[data-slot=conversation\\.session] [class$=_bubble]{font-size:var(--enhancer-font-size);line-height:var(--enhancer-font-line)}[data-slot=\"conversation.composer.bar\"] [class$=_trigger]{font-size:calc(13px * var(--enhancer-chat-scale,1));line-height:calc(20px * var(--enhancer-chat-scale,1));height:calc(28px * var(--enhancer-chat-scale,1))}[data-slot=\"conversation.composer.bar\"] [class$=_trigger] svg,[data-slot=\"conversation.composer.bar\"] [class$=_add] svg{width:calc(14px * var(--enhancer-chat-scale,1));height:calc(14px * var(--enhancer-chat-scale,1))}[data-slot=\"conversation.composer.bar\"] [class$=_primary] svg{width:calc(16px * var(--enhancer-chat-scale,1));height:calc(16px * var(--enhancer-chat-scale,1))}[role=menu] [class^=_list_]{padding:calc(4px * var(--enhancer-chat-scale,1));border-radius:calc(12px * var(--enhancer-chat-scale,1));min-width:calc(218px * var(--enhancer-chat-scale,1));max-width:calc(360px * var(--enhancer-chat-scale,1))}[role=menu] [class^=_item_]{font-size:calc(14px * var(--enhancer-chat-scale,1));line-height:calc(22px * var(--enhancer-chat-scale,1));min-height:calc(40px * var(--enhancer-chat-scale,1));padding:calc(8px * var(--enhancer-chat-scale,1)) calc(10px * var(--enhancer-chat-scale,1));border-radius:calc(10px * var(--enhancer-chat-scale,1));gap:calc(8px * var(--enhancer-chat-scale,1))}[role=menu] [class^=_itemIcon_],[role=menu] [class^=_check_]{width:calc(16px * var(--enhancer-chat-scale,1));height:calc(16px * var(--enhancer-chat-scale,1))}[role=menu] [class^=_label_]{font-size:calc(12px * var(--enhancer-chat-scale,1));line-height:calc(16px * var(--enhancer-chat-scale,1));padding:calc(8px * var(--enhancer-chat-scale,1)) calc(10px * var(--enhancer-chat-scale,1))}[data-slot=sidebar] [class$=_newSession]{font-size:calc(14px * var(--enhancer-sidebar-scale));height:calc(38px * var(--enhancer-sidebar-scale))}[data-slot=sidebar] [class$=_newSessionLabel]{max-width:calc(200px * var(--enhancer-sidebar-scale))}[data-slot=sidebar] [class$=_brand] svg{width:calc(182px * var(--enhancer-sidebar-scale));height:calc(24px * var(--enhancer-sidebar-scale))}:not([data-sidebar-collapsed]) [data-slot=sidebar] [class$=_logoRow] [class$=_iconButton]{width:calc(28px * var(--enhancer-sidebar-scale));height:calc(28px * var(--enhancer-sidebar-scale))}:not([data-sidebar-collapsed]) [data-slot=sidebar] [class$=_logoRow] [class$=_iconButton] svg{width:calc(16px * var(--enhancer-sidebar-scale));height:calc(16px * var(--enhancer-sidebar-scale))}[data-sidebar-collapsed] [data-slot=sidebar] [class$=_logoRow] [class$=_iconButton]{width:36px;height:36px}[data-sidebar-collapsed] [data-slot=sidebar] [class$=_logoRow] [class$=_iconButton] svg{width:16px;height:16px}[data-slot=sidebar\\.settings] [class$=_trigger]{font-size:calc(14px * var(--enhancer-sidebar-scale));height:calc(34px * var(--enhancer-sidebar-scale))}[data-slot=\"sidebar.footer.action\"] [class$=_badge]{font-size:calc(14px * var(--enhancer-sidebar-scale));height:calc(49px * var(--enhancer-sidebar-scale))}[data-slot=\"sidebar.footer.action\"] [class$=_badge] svg{width:calc(14px * var(--enhancer-sidebar-scale));height:calc(14px * var(--enhancer-sidebar-scale))}[data-slot=\"sidebar.footer.action\"] [class$=_badgeCount]{font-size:calc(12px * var(--enhancer-sidebar-scale));line-height:calc(16px * var(--enhancer-sidebar-scale))}[data-slot=sidebar\\.workspaces]{font-size:calc(14px * var(--enhancer-sidebar-scale))}[data-slot=sidebar\\.workspaces] [class$=_title]{font-size:calc(14px * var(--enhancer-sidebar-scale));line-height:calc(20px * var(--enhancer-sidebar-scale))}[data-slot=sidebar\\.workspaces] [class$=_meta],[data-slot=sidebar\\.workspaces] [class$=_time]{font-size:calc(12px * var(--enhancer-sidebar-scale))}[data-slot=sidebar\\.workspaces] [class$=_sectionHeader]{font-size:calc(13px * var(--enhancer-sidebar-scale))}:not([data-sidebar-collapsed]) [data-slot=sidebar\\.workspaces] [class$=_iconButton]{width:calc(28px * var(--enhancer-sidebar-scale));height:calc(28px * var(--enhancer-sidebar-scale))}:not([data-sidebar-collapsed]) [data-slot=sidebar\\.workspaces] [class$=_iconButton] svg{width:calc(16px * var(--enhancer-sidebar-scale));height:calc(16px * var(--enhancer-sidebar-scale))}[data-sidebar-collapsed] [data-slot=sidebar\\.workspaces] [class$=_iconButton]{width:36px;height:36px}[data-sidebar-collapsed] [data-slot=sidebar\\.workspaces] [class$=_iconButton] svg{width:16px;height:16px}[data-slot=settings\\.section] h2[class$=_title],[data-slot=settings\\.section] h2[class$=_heading]{margin:0 0 -8px;font-size:18px;font-weight:600;line-height:26px}[data-slot=settings\\.section] p[class$=_intro]{border-bottom:1px solid var(--dsw-alias-border-l2);margin:0 0 12px;padding-bottom:12px;font-size:13px;line-height:20px}[data-slot=settings\\.section] .dsh_notification_subtitle,[data-slot=settings\\.section] [class$=_head]>[class$=_sub]{border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:12px}[data-slot=settings\\.section] [class$=_titleRow]>svg{display:none}[data-slot=settings\\.section] .dsh_notification_heading{gap:4px}[data-slot=settings\\.section] h2.dsh_notification_title{margin-bottom:0}[data-slot=settings\\.section] h2.enhc-settings-title{color:var(--dsw-alias-label-primary);margin:0 0 -8px;font-size:18px;font-weight:600;line-height:26px}button[class$=_crumb],button[class$=_crumbCurrent]{max-width:560px}[class$=_versionPicker] select{-webkit-appearance:none;appearance:none;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:18px;min-width:0;height:32px;padding:0 32px 0 14px;font-size:13px;line-height:20px}[class$=_versionPicker] select:hover{background-color:var(--dsw-alias-interactive-bg-hover)}[class$=_versionPicker] select:focus-visible{outline:2px solid var(--dsw-alias-border-l3);outline-offset:1px}[class$=_versionPicker] select option{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px}input[type=range].CG7lXq_uitw-slider{-webkit-appearance:none;appearance:none;background:var(--dsw-alias-border-l2);cursor:pointer;border-radius:2px;outline:none;height:4px}input[type=range].CG7lXq_uitw-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;background:var(--dsw-alias-bg-layer-2);border:2px solid var(--dsw-alias-brand-primary);cursor:pointer;border-radius:50%;width:14px;height:14px}input[type=range].CG7lXq_uitw-slider::-moz-range-thumb{background:var(--dsw-alias-bg-layer-2);border:2px solid var(--dsw-alias-brand-primary);cursor:pointer;border-radius:50%;width:14px;height:14px}input[type=range].CG7lXq_uitw-slider::-moz-range-track{background:var(--dsw-alias-border-l2);border-radius:2px;height:4px}body [class$=_toggleButton]{border:1px solid var(--dsw-alias-border-l2);width:32px;height:32px;color:var(--dsw-alias-label-secondary);background:0 0;border-radius:16px}body [class$=_toggleButton]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.nArs4W_toggleButton[aria-pressed=true],.nArs4W_toggleButton[aria-pressed=true]:hover{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted);border-color:#0000}body [class$=_toggleCluster]{background:var(--dsw-alias-bg-base);border-radius:0;align-items:center;gap:6px;height:56px;padding:0 8px 0 12px;top:0;right:0}html.enhc-panel-open body [class$=_toggleCluster]{border-radius:12px;height:auto;padding:4px;top:8px;right:8px}body .nArs4W_panel{background:var(--dsw-alias-bg-layer-1);border:none;border-left:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-shadow-lv3);border-radius:14px 0 0 14px;top:6px;overflow:hidden}body .nArs4W_panelResize{left:0}body .nArs4W_bottomPanel{background:var(--dsw-alias-bg-base);border-top:1px solid var(--dsw-alias-border-l2)}[data-slot=\"conversation.session.header\"]>header{transition:margin-right var(--ds-transition-duration-slow) var(--ds-ease-in-out);margin-right:max(var(--dsh-sidebar-width,0px), 90px)!important;border-bottom:none!important;padding:12px 20px!important}[data-slot=\"conversation.session.header\"]>header{z-index:21;background:var(--dsw-alias-bg-base);position:relative}[data-slot=\"conversation.session.header\"]>header:after{content:none}[class$=_tabs]{align-items:center;gap:8px;margin:0 0 12px 8px;display:flex}[class$=_tabs] [class*=_tab]{border:1px solid var(--dsw-alias-border-l2,transparent);background:var(--dsw-alias-bg-layer-1);height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:14px;flex:none;justify-content:center;align-items:center;padding:0 14px;font-size:13px;line-height:20px;display:inline-flex}[class$=_tabs] [class*=_tab]:hover:not(:disabled):not([class*=_tabActive]){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}[class$=_tabs] [class*=_tabActive],[class$=_tabs] [class*=_tab][aria-selected=true]{background:var(--dsw-alias-state-business-primary);color:#fff;border-color:#0000}[class$=_tabs] [class*=_tab]:after{content:none}body .nArs4W_tabBar{height:44px;min-height:44px}body .nArs4W_panel:not(.nArs4W_panelHidden) .nArs4W_tabBar{padding-right:90px}body .nArs4W_panel .nArs4W_tab{border-right:none;align-self:stretch;gap:6px;height:auto;padding:0 12px;font-size:14px;line-height:20px}body .nArs4W_panel .nArs4W_tab svg{width:16px;height:16px}body .nArs4W_panel .nArs4W_tabClose{width:16px;height:16px}body .nArs4W_panel .nArs4W_tabClose svg{width:14px;height:14px}body .nArs4W_panel .nArs4W_tabBarPlus{width:20px;height:20px}body .nArs4W_panel .nArs4W_tabBarPlus svg{width:16px;height:16px}body .nArs4W_panel .nArs4W_pane{background:var(--dsw-alias-bg-layer-1)}body .nArs4W_panel .nArs4W_paneContent,body .nArs4W_panel .nArs4W_paneTab,body .nArs4W_panel .nArs4W_explorer,body .nArs4W_panel .nArs4W_explorerBody{min-width:0;max-width:100%}body .nArs4W_panel .nArs4W_explorerBody{overflow-x:hidden}body .nArs4W_panel .nArs4W_explorerRow{max-width:100%}html #root{width:100%;margin-right:0}html #root>div[data-slot=root]>div>div:nth-child(2){margin-bottom:0}[data-slot=conversation\\.session]>[class$=_viewArea]{margin-right:var(--dsh-sidebar-width,0px);transition:margin-right var(--ds-transition-duration-slow) var(--ds-ease-in-out)}[data-slot=conversation\\.session] [class$=_flowItem]{content-visibility:auto;contain-intrinsic-size:auto 120px}div[class$=_composerSeat]{margin-right:var(--dsh-sidebar-width,0px);transition:margin-right var(--ds-transition-duration-slow) var(--ds-ease-in-out)}body.dsx-stats-active [data-conversation-scroll]:has([data-conversation-composer-overlay])>[class$=_composerSeat]{right:calc(var(--dsh-scrollbar-width,0px) + var(--dsx-rail-w,220px))}html.enhc-center-card-on div:has(>[data-slot=conversation]){border-radius:18px 0 0}html.enhc-center-card-on .enhc-center-card{display:block}.enhc-center-card{box-sizing:border-box;border-top:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-shadow-lv3);pointer-events:none;background:0 0;border-bottom:none;border-left:none;border-right:none;border-radius:18px 0 0;display:none}html.enhc-center-card-on .enhc-center-card-wrapped{border-top:none;border-radius:0;box-shadow:-20px 10px 36px -18px #0000001c,0 -10px 26px -16px #0000000f,16px 26px 42px -22px #00000014}html.enhc-center-card-on [data-slot=\"conversation.session.header\"]>header{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l2);border-radius:18px 0 0}html.enhc-center-card-on:not(.enhc-panel-open) [class$=_toggleCluster]:before{content:\"\";background:var(--dsw-alias-border-l2);height:1px;position:absolute;top:0;left:0;right:0}[data-genui-panel]{box-sizing:border-box;contain:inline-size;display:block;width:100%!important;max-width:var(--enhancer-content-width,748px)!important;min-width:0!important;margin:10px auto 2px!important}[data-genui]{contain:inline-size;min-width:0!important;max-width:100%!important}[data-genui-tool]{contain:inline-size;min-width:0!important;max-width:100%!important}[data-genui-panel-body]{min-width:0!important;max-width:100%!important;overflow-x:auto!important}[data-genui-panel] svg,[data-genui] svg,[data-genui] pre,[data-genui] canvas,[data-genui] img,[data-genui-mermaid] svg{height:auto;max-width:100%!important}[class*=panelToggle]{box-sizing:border-box;max-width:100%!important;padding:11px 16px!important}[class*=panelToggle] [class*=panelTitle]{flex:1!important;min-width:0!important}[class*=panelToggle] [class*=panelBadge],[class*=panelToggle] [class*=panelChevron]{margin-left:8px;flex:none!important}[class*=toolFallback]{min-width:0!important}[class*=toolFallbackMeta]{flex:1!important;min-width:0!important}[class*=tlTime]{flex:none!important;min-width:0!important}[data-genui-panel-body] [class*=banner],[data-genui-tool] [class*=banner],[data-genui] [class*=banner]{width:auto!important;max-width:100%!important;margin-left:0!important;margin-right:0!important;padding-left:16px!important;padding-right:16px!important}[data-genui-tool] [class*=steps],[data-genui] [class*=steps]{padding-left:16px!important;padding-right:16px!important}";
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
		function getGeneralTitle() {
			return isZh() ? "通用设置" : "General";
		}
		function getGeneralDesc() {
			return isZh() ? "管理语言、外观、界面与对话行为等基础偏好。" : "Manage language, appearance, interface and chat behavior preferences.";
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
		/** Returns the [introPrefix, title] pairs for the title-fill logic,
		*  keyed by current locale. */
		function getKnownTitles() {
			if (isZh()) return [["管理侧边卡片", "侧边卡片"]];
			return [["Manage side cards", "Side Cards"]];
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
		/** The General settings page header block (title + description), registered first in General. */
		function GeneralHeader() {
			return react.createElement("div", { style: {
				display: "flex",
				flexDirection: "column",
				gap: 4,
				padding: "4px 0 12px",
				borderBottom: "1px solid var(--dsw-alias-border-l2)"
			} }, [react.createElement("div", {
				key: "title",
				style: {
					fontSize: 18,
					fontWeight: 600,
					lineHeight: "26px",
					color: "var(--dsw-alias-label-primary)"
				}
			}, getGeneralTitle()), react.createElement("div", {
				key: "desc",
				style: {
					fontSize: 13,
					lineHeight: "20px",
					color: "var(--dsw-alias-label-tertiary)"
				}
			}, getGeneralDesc())]);
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
		//#region src/client/title-tooltip.ts
		/**
		* Unified native-title tooltips ("tooltip harmonizer").
		*
		* The product ships a styled Tooltip primitive (@deepseek-ai/dsh-client-ui-primitives)
		* — dark inverted bubble, `--dsw-alias-tooltip-bg`, fixed positioning in the
		* z-index-100 popup band, 500ms hover delay, immediate on keyboard focus — but
		* any element that only carries the raw HTML `title` attribute (e.g. the model
		* selector trigger `_trigger`) never routes through it and falls back to the
		* OS-native tooltip, which looks foreign next to the rest of the UI.
		*
		* This module harmonizes exactly those stragglers: whenever hovering/focusing
		* an element with a `title` would pop the native tooltip, the attribute is
		* temporarily lifted and the same text is shown in a bubble that replicates
		* the official primitive's geometry and tokens (values extracted from the
		* compiled `.bubble` stylesheet):
		*
		* - placed 8px below the anchor (`side="bottom"` like the product's own
		*   toolbar tooltips), flipped above when there is no room below;
		* - horizontally centered on the anchor, clamped to a 12px viewport margin;
		* - 500ms hover delay, keyboard focus shows immediately;
		* - padding 3px 7px, radius 8px, font 13px/20px, white-space pre-line,
		*   max-width 50vw, z-index 100 (the shell's menu/tooltip/modal band);
		* - 0.15s fade-in on var(--ds-ease-in-out), disabled under reduced motion.
		*
		* The `title` attribute itself stays in the DOM the whole time except during
		* an active hover (that removal is what suppresses the native popup; some app
		* components also key labels off it, so it is restored verbatim — and if the
		* app rewrote the title mid-hover, its newer value wins). Everything else is
		* owned by the returned disposer: listeners, timers, the bubble node and the
		* injected <style> tag disappear together with the plugin fiber.
		*/
		/** Hover delay before the bubble appears; mirrors the product's own toolbars (delayMs=500). */
		const HOVER_DELAY_MS = 500;
		/** Viewport margin the bubble never crosses, mirroring the primitive's EDGE_MARGIN. */
		const EDGE_MARGIN = 12;
		/** Gap between the anchor edge and the bubble, mirroring the primitive (+/-8). */
		const ANCHOR_GAP = 8;
		/** CSS for the bubble. Literal `enhc-tt-*` classes (runtime-set, unhashed),
		*  official alias tokens with conservative fallbacks for boot-time hovers. */
		const TOOLTIP_CSS = `
.enhc-tt-bubble {
  position: fixed;
  z-index: 100;
  width: max-content;
  max-width: 50vw;
  box-sizing: border-box;
  padding: 3px 7px;
  border-radius: 8px;
  background: var(--dsw-alias-tooltip-bg, #16181d);
  color: var(--dsw-static-neutral-bluish-00, #f9fafb);
  font-size: 13px;
  line-height: 20px;
  white-space: pre-line;
  overflow-wrap: break-word;
  pointer-events: none;
  animation: enhc-tt-in 0.15s var(--ds-ease-in-out, ease-in-out);
}
.enhc-tt-bubble[data-side="bottom"] { transform: translate(-50%); }
.enhc-tt-bubble[data-side="top"] { transform: translate(-50%, -100%); }
@keyframes enhc-tt-in { 0% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .enhc-tt-bubble { animation: none; }
}
`;
		/** Opt-out marker: an ancestor carrying this attribute keeps its native tooltip. */
		const OPT_OUT_SELECTOR = "[data-enhc-no-tooltip]";
		/** Tag id of the injected stylesheet (swept together with the plugin tags). */
		const STYLE_TAG_ID = "dsh-theme-manager/title-tooltip";
		/** Currently presented tip, if any. */
		let active = null;
		/** Pending show timer (null when nothing scheduled). */
		let showTimer = null;
		/** Lazily created bubble node; display toggled via [hidden]. */
		let bubble = null;
		/**
		* Resolve the effective anchor for a hover/focus target: the nearest element
		* carrying a `title`, unless opted out or meaningless (html/body document
		* titles). Returns null when the native tooltip should simply stay silent.
		* @param target - event target from the delegated listener.
		* @returns the anchor element or null.
		*/
		function resolveAnchor(target) {
			const anchor = (target instanceof Element ? target : null)?.closest("[title]") ?? null;
			if (anchor === null) return null;
			const tag = anchor.tagName;
			if (tag === "HTML" || tag === "BODY") return null;
			if (anchor.closest(OPT_OUT_SELECTOR) !== null) return null;
			if ((anchor.getAttribute("title") ?? "").trim() === "") return null;
			return anchor;
		}
		/**
		* Create the singleton bubble node (hidden) plus its style tag.
		* @returns the bubble element.
		*/
		function ensureBubble() {
			if (document.getElementById("enhc-tt-style") === null) {
				const style = document.createElement("style");
				style.id = "enhc-tt-style";
				style.dataset.plugin = "dsh-theme-manager";
				style.dataset.pluginDynamic = STYLE_TAG_ID;
				style.textContent = TOOLTIP_CSS;
				document.head.appendChild(style);
			}
			if (bubble === null || !bubble.isConnected) {
				bubble = document.createElement("div");
				bubble.className = "enhc-tt-bubble";
				bubble.dataset.side = "bottom";
				bubble.setAttribute("role", "tooltip");
				bubble.hidden = true;
				document.body.appendChild(bubble);
			}
			return bubble;
		}
		/**
		* Compute bottom/top placement and clamp horizontally, mirroring the
		* primitive's fit(): measure after setting text, flip sides vertically when
		* the preferred side would clip, and slide into the viewport horizontally.
		* @param el - anchor element.
		*/
		function place(el) {
			const tip = ensureBubble();
			const r = el.getBoundingClientRect();
			const x = r.left + r.width / 2;
			let side = "bottom";
			let y = r.bottom + ANCHOR_GAP;
			tip.style.left = `${x}px`;
			tip.style.top = `${y}px`;
			const box = tip.getBoundingClientRect();
			const fitsBelow = r.bottom + ANCHOR_GAP + box.height <= window.innerHeight - EDGE_MARGIN;
			const fitsAbove = r.top - ANCHOR_GAP - box.height >= EDGE_MARGIN;
			if (!fitsBelow && fitsAbove) {
				side = "top";
				y = r.top - ANCHOR_GAP;
			}
			let left = x;
			if (box.right > window.innerWidth - EDGE_MARGIN) left += window.innerWidth - EDGE_MARGIN - box.right;
			if (left < EDGE_MARGIN) left = EDGE_MARGIN;
			tip.dataset.side = side;
			tip.style.left = `${left}px`;
			tip.style.top = `${y}px`;
		}
		/**
		* Show the bubble for the given anchor immediately (keyboard focus path uses
		* zero delay, mirroring the primitive).
		* @param tip - active anchor + lifted text.
		*/
		function showNow(tip) {
			const tipEl = ensureBubble();
			tipEl.textContent = tip.title;
			tipEl.hidden = false;
			place(tip.el);
		}
		/**
		* Tear down the current presentation: cancel the pending timer, restore the
		* lifted title (unless the app already wrote a fresh one mid-hover) and hide
		* the bubble. Safe to call with nothing active.
		*/
		function settle() {
			if (showTimer !== null) {
				clearTimeout(showTimer);
				showTimer = null;
			}
			if (active !== null) {
				if (!active.el.hasAttribute("title")) active.el.setAttribute("title", active.title);
				active = null;
			}
			if (bubble !== null) bubble.hidden = true;
		}
		/**
		* Enter a new anchor: settle the previous one, lift the native title so the
		* browser cannot pop its own tooltip, and schedule the delayed show.
		* @param anchor - newly hovered element.
		*/
		function enter(anchor) {
			settle();
			const title = anchor.getAttribute("title");
			if (title === null || title.trim() === "") return;
			active = {
				el: anchor,
				title
			};
			anchor.removeAttribute("title");
			showTimer = window.setTimeout(() => {
				showTimer = null;
				if (active !== null) showNow(active);
			}, HOVER_DELAY_MS);
		}
		let teardownPrevious = null;
		/**
		* Mount the unified title-tooltip behavior. Idempotent: a second call first
		* disposes the previous instance.
		* @returns disposer removing listeners, timers, the bubble and the style tag.
		*/
		function mountTitleTooltips() {
			teardownPrevious?.();
			ensureBubble();
			const onMouseOver = (e) => {
				const anchor = resolveAnchor(e.target);
				if (anchor !== null && anchor === active?.el) return;
				if (anchor === null) return;
				enter(anchor);
			};
			const onMouseOut = (e) => {
				if (active === null) return;
				const to = e.relatedTarget;
				if (to instanceof Node && active.el.contains(to)) return;
				settle();
			};
			const onFocusIn = (e) => {
				const anchor = resolveAnchor(e.target);
				if (anchor === null || anchor === active?.el) return;
				settle();
				const title = anchor.getAttribute("title");
				if (title === null || title.trim() === "") return;
				active = {
					el: anchor,
					title
				};
				anchor.removeAttribute("title");
				showNow(active);
			};
			const onFocusOut = (e) => {
				if (active === null) return;
				const to = e.relatedTarget;
				if (to instanceof Node && active.el.contains(to)) return;
				settle();
			};
			const onLeave = () => settle();
			const onKeyDown = (e) => {
				if (e.key === "Escape") settle();
			};
			const onResize = () => {
				if (active !== null && active.el.isConnected) place(active.el);
				else settle();
			};
			document.addEventListener("mouseover", onMouseOver);
			document.addEventListener("mouseout", onMouseOut);
			document.addEventListener("focusin", onFocusIn);
			document.addEventListener("focusout", onFocusOut);
			document.addEventListener("scroll", onLeave, true);
			window.addEventListener("wheel", onLeave, { passive: true });
			window.addEventListener("resize", onResize);
			window.addEventListener("blur", onLeave);
			document.addEventListener("keydown", onKeyDown);
			const dispose = () => {
				settle();
				document.removeEventListener("mouseover", onMouseOver);
				document.removeEventListener("mouseout", onMouseOut);
				document.removeEventListener("focusin", onFocusIn);
				document.removeEventListener("focusout", onFocusOut);
				document.removeEventListener("scroll", onLeave, true);
				window.removeEventListener("wheel", onLeave);
				window.removeEventListener("resize", onResize);
				window.removeEventListener("blur", onLeave);
				document.removeEventListener("keydown", onKeyDown);
				bubble?.remove();
				bubble = null;
				document.getElementById("enhc-tt-style")?.remove();
				if (teardownPrevious === dispose) teardownPrevious = null;
			};
			teardownPrevious = dispose;
			return dispose;
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Harness UI Enhancer — browser half entry.
		*
		* Registers two surfaces in Settings → General:
		* - GeneralHeader (order -100), the unified page header
		* - SettingsGeneralRow (order 30), the "界面定制" sizing block
		*
		* One shared EnhancerState lives in the apply closure; both surfaces receive
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
			ctx.effect(() => {
				const syncToggleStates = () => {
					const panel = document.querySelector(".nArs4W_panel");
					const bottom = document.querySelector(".nArs4W_bottomPanel");
					const buttons = document.querySelectorAll(".nArs4W_toggleButton");
					if (!panel || !bottom || buttons.length < 2) {
						document.documentElement.classList.remove("enhc-panel-open");
						return;
					}
					const panelOpen = !panel.classList.contains("nArs4W_panelHidden");
					const bottomOpen = !bottom.classList.contains("nArs4W_bottomPanelHidden");
					buttons[0].setAttribute("aria-pressed", String(bottomOpen));
					buttons[1].setAttribute("aria-pressed", String(panelOpen));
					document.documentElement.classList.toggle("enhc-panel-open", panelOpen);
				};
				syncToggleStates();
				const observer = new MutationObserver(syncToggleStates);
				observer.observe(document.body, {
					attributes: true,
					childList: true,
					subtree: true,
					attributeFilter: ["class"]
				});
				return () => observer.disconnect();
			}, `${PLUGIN_ID}: better-sidebar toggle state sync`);
			ctx.effect(() => {
				if (true) return;
				const relocateTabs = () => {
					const titleCluster = document.querySelector("[class$=\"_titleCluster\"]");
					const actions = titleCluster?.querySelector("[class$=\"_headerActions\"]");
					const tabs = document.querySelector("[data-slot=\"conversation.session.header\"] [class$=\"_tabs\"]");
					if (!titleCluster || !tabs) return;
					if (tabs.parentElement === titleCluster) return;
					const ref = actions !== void 0 && actions !== null ? actions.nextSibling : null;
					titleCluster.insertBefore(tabs, ref);
				};
				relocateTabs();
				const observer = new MutationObserver(relocateTabs);
				observer.observe(document.body, {
					childList: true,
					subtree: true
				});
				return () => observer.disconnect();
			}, `${PLUGIN_ID}: session tabs relocation`);
			ctx.effect(() => {
				const FILL_CLASS = "enhc-settings-title";
				const fillSectionTitle = () => {
					const section = document.querySelector("[data-slot=\"settings.section\"]");
					if (section === null || section === void 0) return;
					const intro = section.querySelector("p[class$=\"_intro\"]");
					if (intro === null || intro === void 0) return;
					if (section.querySelector("h1, h2, h3") !== null) return;
					if (section.querySelector(`h2.${FILL_CLASS}`) !== null) return;
					let text = "";
					for (const el of document.querySelectorAll("[role=\"dialog\"] nav button")) if (el.getAttribute("aria-current") === "true" || el.classList.toString().includes("_active")) {
						text = el.textContent?.trim() ?? "";
						break;
					}
					if (text === "") {
						for (const el of document.querySelectorAll("[class$=\"_navCell\"]")) if (el.getAttribute("aria-current") === "true" || /(^|\s)\S*_active(\s|$)/.test(el.className)) {
							text = el.textContent?.trim() ?? "";
							break;
						}
					}
					if (text === "") {
						const it = intro.textContent?.trim() ?? "";
						text = getKnownTitles().find(([prefix]) => it.startsWith(prefix))?.[1] ?? "";
					}
					if (text === "") {
						console.debug(`[dsh-theme-manager] fillSectionTitle: no title found, intro=${JSON.stringify(intro.textContent?.trim())}`);
						return;
					}
					const title = document.createElement("h2");
					title.className = FILL_CLASS;
					title.textContent = text;
					intro.parentElement?.insertBefore(title, intro);
					console.info(`[dsh-theme-manager] injected settings section title: ${JSON.stringify(text)}`);
				};
				fillSectionTitle();
				const observer = new MutationObserver(fillSectionTitle);
				observer.observe(document.body, {
					childList: true,
					subtree: true,
					attributes: true,
					attributeFilter: [
						"class",
						"aria-current",
						"aria-expanded"
					]
				});
				const tick = window.setInterval(fillSectionTitle, 700);
				window.setTimeout(() => window.clearInterval(tick), 12e3);
				return () => {
					observer.disconnect();
					window.clearInterval(tick);
				};
			}, `${PLUGIN_ID}: settings section title fill`);
			ctx.effect(() => mountTitleTooltips(), `${PLUGIN_ID}: unified native-title tooltips`);
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
				id: "ui-enhancer-header",
				order: -100
			}, GeneralHeader));
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

		/** 挂载合并段。它抛错也不该拖垮本插件的其它功能（背景、主题层、调色盘）。 */
		function applyHarmonizer(ctx) {
			try {
				const half = harmonizerHalf(require);
				if (half !== null && half !== undefined && typeof half.apply === "function") half.apply(ctx);
			} catch (error) {
				console.warn("[dsh-theme-manager] 界面统一段挂载失败（其它功能不受影响）：", error);
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
			applyDisabled: applyDisabled,
			ensureStyle: ensureStyle,
			applyPalette: applyPalette,
			applyPreset: applyPreset,
			getSnapshot: getSnapshot,
			install: install,
			isHostLayer: isHostLayer,
			isManaged: isManaged,
			isThemeLayer: isThemeLayer,
			layerKey: layerKey,
			normalizeColor: normalizeColor,
			paletteCss: paletteCss,
			readOff: readOff,
			refresh: refresh,
			release: release,
			resetPalette: resetPalette,
			resetSlot: resetSlot,
			scanLayers: scanLayers,
			setAllDisabled: setAllDisabled,
			setSlotColor: setSlotColor,
			slotValue: slotValue,
			takeOver: takeOver,
			toHex6: toHex6,
			toggleLayer: toggleLayer,
			writeOff: writeOff,
			MENU_FLAT_CSS: MENU_FLAT_CSS,
			applyMenuFix: applyMenuFix,
			readMenuFlat: readMenuFlat,
			setMenuFlat: setMenuFlat,
			PALETTE_SLOTS: PALETTE_SLOTS,
			PALETTE_PRESETS: PALETTE_PRESETS,
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
