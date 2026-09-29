// tools/inline-harmonizer.mjs — 把 dsh-ui-harmonizer 的浏览器半边**逐字**内联进
// 本插件的 lib/client.js（合并外观层，页面上只留 dsh-theme-manager 一个入口）。
//
//   node tools/inline-harmonizer.mjs              # 用 vendor 副本（推荐，幂等）
//   node tools/inline-harmonizer.mjs <路径>        # 用指定 client.js，并刷新 vendor 副本
//
// 设计：
//   · 只替换 lib/client.js 里 @@HARMONIZER-INLINE-START@@ 与 @@HARMONIZER-INLINE-END@@
//     之间的内容，其余代码一个字都不动（可反复执行）。
//   · 源码逐字搬运，唯一改动是 style 标签的命名空间（避免与「还装着的原插件」互相判重），
//     以及日志前缀；**localStorage 键 `harness-ui-enhancer.state` 原样保留**。
//   · 每条替换都要求命中，命中数为 0 直接报错退出 —— 上游改版时宁可失败也不要静默改坏。
//
// 上游：dsh-ui-harmonizer（MIT，Physicolor）https://github.com/Physicolor/dsh-ui-harmonizer
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const DEST = path.join(ROOT, "lib", "client.js");
const VENDOR_DIR = path.join(HERE, "vendor");
const VENDOR = path.join(VENDOR_DIR, "dsh-ui-harmonizer-0.8.3-client.js");
const DEFAULT_SRC = "/Users/lixiongwei/.dsh/profiles/desktop/node_modules/dsh-ui-harmonizer/lib/client.js";

const arg = process.argv[2];
let src = VENDOR;
if (arg !== undefined) {
	src = arg;
} else if (!existsSync(VENDOR)) {
	src = DEFAULT_SRC;
}
if (!existsSync(src)) {
	console.error(`源文件不存在：${src}\n请传入 dsh-ui-harmonizer 的 lib/client.js 路径（或在 tools/vendor/ 放一份副本）。`);
	process.exit(2);
}
const raw = readFileSync(src, "utf8");

/* ── 1. 提取 factory 体 ── */
const OPEN = "factory: (require) => {";
const CLOSE = "\n\t}\n});";
const a = raw.indexOf(OPEN);
const b = raw.lastIndexOf(CLOSE);
if (a < 0 || b < 0 || b <= a) {
	console.error("没找到 factory 外壳（上游打包格式变了？）：检查 factory: (require) => { … }\\n});");
	process.exit(2);
}
let body = raw.slice(a + OPEN.length, b);

/* ── 2. 命名空间替换（必须全部命中） ── */
const RULES = [
	['const tagId = "dsh-ui-harmonizer/enhancer.module.css";', 'const tagId = "dsh-theme-manager/harmonizer.module.css";'],
	['tag.dataset.plugin = "dsh-ui-harmonizer";', 'tag.dataset.plugin = "dsh-theme-manager";'],
	['const STYLE_TAG_ID = "harness-ui-harmonizer/title-tooltip";', 'const STYLE_TAG_ID = "dsh-theme-manager/title-tooltip";'],
	['style.dataset.plugin = "harness-ui-harmonizer";', 'style.dataset.plugin = "dsh-theme-manager";'],
	/* 动态 markdown 字体层会出现在「主题」页的「其它主题层」列表里（它定义了
	   --dsw-font-markdown-*）。顺带打一个自报属性，好让那一行显示成人话，而不是
	   光秃秃一个 dsh-theme-manager。 */
	[
		'dynamicStyle.dataset.plugin = "harness-ui-enhancer";',
		'dynamicStyle.dataset.plugin = "dsh-theme-manager";\n\t\t\t\tdynamicStyle.dataset.dshThemeManagerLayer = "界面字体（通用设置 · 界面定制）";'
	],
	['const PLUGIN_ID = "harness-ui-enhancer";', 'const PLUGIN_ID = "dsh-theme-manager";'],
	["console.info(`[harness-ui-enhancer] injected", "console.info(`[dsh-theme-manager] injected"],
	["console.debug(`[harness-ui-enhancer] fillSectionTitle", "console.debug(`[dsh-theme-manager] fillSectionTitle"]
];
const applied = [];
for (const [from, to] of RULES) {
	const count = body.split(from).length - 1;
	if (count === 0) {
		console.error(`替换未命中（上游可能改版）：${from}`);
		process.exit(3);
	}
	body = body.split(from).join(to);
	applied.push(`${count}× ${from.slice(0, 62)}${from.length > 62 ? "…" : ""}`);
}

/* ── 3. 组装内联函数 ── */
const inlined = `\t\tfunction harmonizerHalf(require) {${body}\t\t}\n`;

/* ── 4. 写回 dest 的标记区 ── */
const dest = readFileSync(DEST, "utf8");
const START = "/* @@HARMONIZER-INLINE-START@@ */\n";
const END = "\t\t/* @@HARMONIZER-INLINE-END@@ */";
const s = dest.indexOf(START);
const e = dest.indexOf(END);
if (s < 0 || e < 0 || e <= s) {
	console.error("lib/client.js 里找不到 @@HARMONIZER-INLINE-START/END@@ 标记");
	process.exit(4);
}
const next = `${dest.slice(0, s + START.length)}${inlined}${dest.slice(e)}`;
writeFileSync(DEST, next, "utf8");

/* ── 5. 留一份源码副本：原包卸载后就地取材 ── */
if (src !== VENDOR) {
	mkdirSync(VENDOR_DIR, { recursive: true });
	copyFileSync(src, VENDOR);
}

const lines = inlined.split("\n").length - 1;
console.log(`内联完成：${path.relative(ROOT, DEST)}`);
console.log(`  来源：${src}`);
console.log(`  内联 ${lines} 行（原 factory 体 ${body.split("\n").length - 1} 行 + 包装）`);
for (const line of applied) console.log(`  · ${line}`);
console.log(`  源码副本：${path.relative(ROOT, VENDOR)}`);
