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
			"/* 菜单分组标题：去掉官方多叠的一层半透明白，改用同款毛玻璃 */",
			'[class*="_groupTitle"] {',
			"  background: transparent !important;",
			"  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%)) !important;",
			"  -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%)) !important;",
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
		let snapshot = { layers: [], off: new Set(), managed: new Set(), palette: {}, menuFlat: true, version: 0 };

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

		/* ───────────────────────── 设置页样式 ───────────────────────── */

		const CSS = [
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
			".dsh-theme-manager-swatch i{display:inline-block;width:10px;height:10px;border-radius:50%;border:0.5px solid var(--dsw-alias-border-l3)}"
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
				h(Group, {
					title: "当前主题 · dsh-claude-theme",
					layers: themeLayers,
					empty: "没检测到 dsh-claude-theme 的样式层 —— 插件可能没有挂载。"
				}),
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

		/* ───────────────────────── 插件入口 ───────────────────────── */

		function apply(ctx) {
			ensureStyle();
			install();
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
			PALETTE_PRESETS: PALETTE_PRESETS
		};
		return module.exports;
	}
});
