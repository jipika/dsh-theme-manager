/**
 * dsh-theme-manager 层分类回归测试
 * ---------------------------------------------------------------------------
 * 用最小 DOM stub 在 Node 里真跑 lib/client.js 的 factory，构造各种 <style>
 * 组合，断言 `__internal.scanLayers()` 给出的分类/开关权限：
 *
 *   ① 本主题层（只有 data-dsh-claude-theme）           → 可开关
 *   ② 本主题层 + 额外的 data-plugin（v0.4.1 的回归病例）→ 仍可开关（自报优先）
 *   ③ 官方宿主层（data-plugin="@deepseek-ai/…"）        → 只读，连接管都不给
 *   ④ 第三方插件层（data-plugin="dsh-xxx"）             → 归「其它主题层」，可接管后可开关
 *   ⑤ 无标识层                                          → 只读（无法判断归属）
 *   ⑥ applyDisabled：被关的本主题层 disabled=true；官方宿主层被强制恢复 false（自愈）
 *
 * 跑法：node tests/layer-classify-test.mjs [别的 client.js 路径]
 *   给一个路径可以对任意版本跑同一套断言（对照实验，验证 bug 确实存在于旧版）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = process.argv[2] || join(HERE, "..", "lib", "client.js");

/* ───────────────────────────── stub DOM ───────────────────────────── */

function makeStyle(attrs, css) {
	const map = new Map(Object.entries(attrs || {}));
	const el = {
		attributes: Array.from(map, ([name, value]) => ({ name, value })),
		getAttribute: (name) => (map.has(name) ? map.get(name) : null),
		setAttribute: (name, value) => {
			if (!map.has(name)) el.attributes.push({ name, value });
			map.set(name, value);
			if (name === "id") el.id = value;
		},
		textContent: css || "",
		id: map.get("id") || "",
		disabled: false
	};
	return el;
}

function setUpDom(tags, seed) {
	const store = new Map(Object.entries(seed || {}));
	const head = {
		querySelectorAll: (sel) => (sel === "style" ? tags.slice() : []),
		appendChild() {},
		contains: () => true
	};
	const created = [];
	const document = {
		head,
		body: {},
		getElementById: () => null,
		createElement: () => {
			const el = makeStyle({}, "");
			created.push(el);
			return el;
		},
		querySelector: () => null
	};
	const window = {
		localStorage: {
			getItem: (k) => (store.has(k) ? store.get(k) : null),
			setItem: (k, v) => store.set(k, String(v)),
			removeItem: (k) => store.delete(k)
		},
		getComputedStyle: () => ({ getPropertyValue: () => "" })
	};
	class MutationObserver {
		observe() {}
		disconnect() {}
	}
	let spec = null;
	const win = Object.assign(window, {
		__ModuleLoader__: { load: (s) => { spec = s; } }
	});
	return { win, document, store, MutationObserver, getSpec: () => spec, created };
}

async function loadPlugin(tags, seed) {
	const dom = setUpDom(tags, seed);
	globalThis.window = dom.win;
	globalThis.document = dom.document;
	globalThis.MutationObserver = dom.MutationObserver;
	globalThis.localStorage = dom.win.localStorage;
	// 每次都用带 query 的 URL 绕开 ESM 模块缓存，保证读到最新文件
	const mod = await import(pathToFileURL(TARGET).href + "?t=" + Date.now() + Math.random());
	const spec = dom.getSpec();
	const React = {
		createElement: () => ({}),
		useState: () => [undefined, () => {}],
		useSyncExternalStore: () => ({ layers: [], off: new Set(), managed: new Set(), palette: {}, version: 0 }),
		useEffect: () => {},
		useCallback: (fn) => fn
	};
	const exports = spec.factory((id) => (id === "react" ? React : {}));
	exports.__internal.install();
	return { api: exports.__internal, dom };
}

/* ───────────────────────────── 断言工具 ───────────────────────────── */

let pass = 0;
const failures = [];
function check(name, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (ok) pass++;
	else failures.push(`${name}\n      期望 ${JSON.stringify(expected)}\n      实得 ${JSON.stringify(actual)}`);
}
function row(layers, name) {
	return layers.filter((l) => l.name === name)[0] || null;
}

/* ───────────────────────────── 用例 ───────────────────────────── */

const CLAUDE_ONLY = makeStyle(
	{ "data-dsh-claude-theme": "colors" },
	"body{--dsw-alias-bg-base:#FAF9F5;--dsw-alias-label-primary:#141413}"
);
const CLAUDE_PLUS_PLUGIN = makeStyle(
	{ "data-dsh-claude-theme": "fonts", "data-plugin": "dsh-claude-theme" },
	"body{font-family:serif}"
);
const OFFICIAL_HOST = makeStyle(
	{ "data-plugin": "@deepseek-ai/dsh-client-ui-theme", "data-plugin-css": "@deepseek-ai/dsh-client-ui-theme/tokens.css" },
	":root{--dsw-alias-bg-base:#fff}"
);
const THIRD_PARTY = makeStyle(
	{ "data-plugin": "dsh-skill-mcp-panel", "data-plugin-css": "dsh-skill-mcp-panel/SkillsSection.module.css" },
	".SKV_page{--dsw-alias-label-primary:var(--dsw-alias-label-primary)}"
);
const THIRD_PARTY_2 = makeStyle(
	{ "data-plugin": "dsh-ui-harmonizer", "data-plugin-css": "dsh-ui-harmonizer/enhancer.module.css" },
	":root{--dsw-alias-bg-layer-2:#f5f3ed}"
);
const ANON = makeStyle({}, "body{--dsw-alias-border-l1:rgba(0,0,0,.1)}");
const NON_THEME = makeStyle({ id: "layout-fix" }, ".x{display:flex}");
/* DSH 运行时给「经它注入的样式」统一补的标记：值固定是 @deepseek-ai/dsh-api-remotes，
   与真正注入者无关 —— 它**不是**官方骨架（页面实测：8 张样式表共用它）。 */
const API_REMOTES = makeStyle(
	{ id: "dsh-memory-style", "data-plugin": "@deepseek-ai/dsh-api-remotes" },
	":root{--dsw-alias-bg-layer-3:#f0eee6}"
);
/* 官方命名空间但没有 data-plugin-css：不是官方 CSS 注入器加载的组件样式表。 */
const OFFICIAL_NO_CSS = makeStyle(
	{ "data-plugin": "@deepseek-ai/dsh-client-ui-renderer" },
	":root{--dsw-alias-label-primary-dimmed:#3d3d3a}"
);
/* 同 data-plugin、都无 id / 无 css：靠内容哈希区分（页面实测 dsh-ui-fixes 那一组）。 */
const DUP_A = makeStyle({ "data-plugin": "dsh-ui-fixes" }, ":root{--dsw-alias-a:1}");
const DUP_B = makeStyle({ "data-plugin": "dsh-ui-fixes" }, ":root{--dsw-alias-b:2}");

const TAGS = [CLAUDE_ONLY, CLAUDE_PLUS_PLUGIN, OFFICIAL_HOST, THIRD_PARTY, THIRD_PARTY_2, ANON, NON_THEME, API_REMOTES, OFFICIAL_NO_CSS, DUP_A, DUP_B];
const SEED = {
	// 历史状态：用户早就关过「配色」层；脏 key 必须被过滤掉
	"dsh-theme-manager:off.v1": JSON.stringify(["claude-theme:colors", "attr:data-plugin=@deepseek-ai/dsh-client-ui-theme"]),
	"dsh-theme-manager:managed.v1": JSON.stringify(["plugin:dsh-skill-mcp-panel/SkillsSection.module.css"])
};

const { api } = await loadPlugin(TAGS, SEED);
const layers = api.scanLayers();

check("总层数 = 10（非主题层不算）", layers.length, 10);

check("① 本主题层（只带 data-dsh-claude-theme）", (() => {
	const l = row(layers, "配色 token（暖米色皮肤）");
	return l && { group: l.group, hostLayer: l.hostLayer, manageable: l.manageable, canTakeOver: l.canTakeOver, disabled: l.disabled };
})(), { group: "claude-theme", hostLayer: false, manageable: true, canTakeOver: false, disabled: true });

check("② 本主题层 + 额外 data-plugin → 仍归本主题、仍可开关（v0.4.1 回归病例）", (() => {
	const l = row(layers, "衬线字体");
	return l && { group: l.group, hostLayer: l.hostLayer, manageable: l.manageable, canTakeOver: l.canTakeOver, origin: l.origin };
})(), {
	group: "claude-theme",
	hostLayer: false,
	manageable: true,
	canTakeOver: false,
	origin: "data-dsh-claude-theme=fonts · data-plugin=dsh-claude-theme"
});

check("③ 官方宿主层 → 只读、不可接管", (() => {
	const l = row(layers, "tokens.css");
	return l && { group: l.group, hostLayer: l.hostLayer, manageable: l.manageable, canTakeOver: l.canTakeOver, origin: l.origin };
})(), {
	group: "host",
	hostLayer: true,
	manageable: false,
	canTakeOver: false,
	origin: "宿主样式 · @deepseek-ai/dsh-client-ui-theme/tokens.css"
});

check("④ 第三方插件层 → 归「其它主题层」，接管后可开关", (() => {
	const l = row(layers, "SkillsSection.module.css");
	return l && { group: l.group, hostLayer: l.hostLayer, manageable: l.manageable, canTakeOver: l.canTakeOver, origin: l.origin };
})(), {
	group: "other",
	hostLayer: false,
	manageable: true,
	canTakeOver: false,
	origin: "dsh-skill-mcp-panel/SkillsSection.module.css · data-plugin=dsh-skill-mcp-panel"
});

check("④b 运行时标记 @deepseek-ai/dsh-api-remotes 的层 → 不算宿主、可接管（页面实测病例）", (() => {
	const l = row(layers, "dsh-memory");
	return l && { group: l.group, hostLayer: l.hostLayer, manageable: l.manageable, canTakeOver: l.canTakeOver, key: l.key };
})(), { group: "other", hostLayer: false, manageable: false, canTakeOver: true, key: "id:dsh-memory-style" });

check("④c 官方命名空间但没有 data-plugin-css → 不算骨架（那只是运行时标记）", (() => {
	const l = layers.filter((x) => x.origin.indexOf("@deepseek-ai/dsh-client-ui-renderer") >= 0)[0];
	return l && { hostLayer: l.hostLayer, group: l.group, canTakeOver: l.canTakeOver };
})(), { hostLayer: false, group: "other", canTakeOver: true });

check("④d 同 data-plugin、无 id 无 css 的两层 → key 靠内容哈希区分，不塌陷", (() => {
	const dup = layers.filter((l) => l.origin.indexOf("data-plugin=dsh-ui-fixes") >= 0);
	return { 层数: dup.length, 唯一key数: new Set(dup.map((l) => l.key)).size };
})(), { 层数: 2, 唯一key数: 2 });

check("⑤ 无标识层 → 只读（hash key 认不出归属）", (() => {
	const l = row(layers, "无标识样式表");
	return l && { group: l.group, hostLayer: l.hostLayer, manageable: l.manageable, canTakeOver: l.canTakeOver };
})(), { group: "other", hostLayer: false, manageable: false, canTakeOver: false });

check("⑥ 脏 key（attr:data-plugin=…）被过滤，不进 off 集合", Array.from(api.getSnapshot().off).sort(), ["claude-theme:colors"]);

check("⑥b 没改过任何颜色时调色盘不注入任何 CSS（菜单等浮层回到官方外观）", api.paletteCss(), "");
check("⑥c 改色后只写该槽位的 token，不碰 --dsw-menu-*（v0.4.1 的越权覆盖已删除）", (() => {
	api.setSlotColor("brand", "#7C6BD6");
	const css = api.paletteCss();
	return { 含品牌色: css.indexOf("--dsw-alias-brand-primary: #7C6BD6") >= 0, 含菜单token: /--dsw-menu-/.test(css) };
})(), { 含品牌色: true, 含菜单token: false });

check("⑦ off 命中本主题层 → disabled 落地到标签", CLAUDE_ONLY.disabled, true);
check("⑧ off 命中官方宿主层 → 强制恢复启用（自愈）", OFFICIAL_HOST.disabled, false);
check("⑨ 本主题层关掉后仍可被重新打开（toggle 语义）", (() => {
	api.toggleLayer("claude-theme:colors");
	return CLAUDE_ONLY.disabled;
})(), false);

/* 未接管的第三方层 → 可接管；接管后 → 可开关，且开关真落地 */
const harmonizer = row(layers, "enhancer.module.css");
check("⑩ 未接管的第三方层 → 可接管", { manageable: harmonizer.manageable, canTakeOver: harmonizer.canTakeOver, hostLayer: harmonizer.hostLayer }, { manageable: false, canTakeOver: true, hostLayer: false });
api.takeOver(harmonizer.key);
const harmonizerAfter = row(api.scanLayers(), "enhancer.module.css");
check("⑪ 接管后 → 可开关，且 key 稳定", { manageable: harmonizerAfter.manageable, canTakeOver: harmonizerAfter.canTakeOver, keyStable: harmonizerAfter.key === harmonizer.key }, { manageable: true, canTakeOver: false, keyStable: true });
api.toggleLayer(harmonizer.key);
check("⑫ 接管后关闭第三方层 → disabled 落地", THIRD_PARTY_2.disabled, true);

/* ───────────────────────────── 结果 ───────────────────────────── */

console.log(`\n目标文件：${TARGET}`);
console.log(`通过 ${pass} / ${pass + failures.length}`);
if (failures.length > 0) {
	console.log("\n失败项：");
	for (const f of failures) console.log("  ✗ " + f);
	process.exitCode = 1;
} else {
	console.log("全部通过 ✓");
}
console.log("备注：源文件 " + readFileSync(TARGET, "utf8").length + " 字符");
