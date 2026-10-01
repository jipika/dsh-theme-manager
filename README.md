# dsh-theme-manager

> One settings page that lists every **theme layer** injected into the DSH page, switches
> each of them on or off, paints a **page background (image / video)** you can swap from the
> UI **or from any external program over a loopback HTTP API**, and carries the merged-in
> **UI-harmonizer** segments (official UI normalization, plugin reconciliation, chat width /
> font size / rounded card).
>
> 给 DeepSeek Harness 一个「主题管理」页：页面上每个定义了 `--dsw-*` token 的样式层逐层开关、
> 一栏调色盘、**页面背景（图片 / 视频）**、以及**本机 HTTP 对外接口**；
> 另外吸收了原先单独挂载的 `dsh-ui-harmonizer`（界面统一段）。

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> **拥有**：设置左侧导航「主题」页；本插件自己的四张 `<style>`（配置层 / 调色盘 / 菜单修补 / 背景）；
> 页面背景层 `#dsh-theme-manager-bg-layer`（插在 `body` 最前面，画在内容之下）；
> host 侧路由 `/dsh-theme-manager/*` 与状态文件 `$DSH_HOME/state/theme-manager/background.json`；
> 以及**从 `dsh-ui-harmonizer` 合并来的「界面统一」段**（`settings.general.item` 里的「界面定制」、
> `shell.overlay` 的圆角卡片、原生 title 气泡、better-sidebar / genui 协调、设置页规范器）。
> **冲突时**：`--dsh-chat-content-width` 让给 `dsh-ui-fixes`（官方拖拽优先）；会话滚动行为归
> `dsh-think-ux` / `dsh-smooth-stream`；`--dsw-menu-surface-fill` 等 MenuSurface token **一律不改**
> （菜单保持官方半透明毛玻璃）；`dsh-ui-harmonizer` 包**不要与本插件同时挂载**（同一份代码会跑两遍）。
> **回滚**：删 profile `cordis.patch.yml` 里 id `theme-manager` 的 insert + 重启应用；只回滚背景
> → 主题页点「清除背景」，或删 `~/.dsh/state/theme-manager/background.json`（不影响其它功能）。

> **入口**：设置 → 左侧导航「主题」；界面定制仍在 设置 → 通用设置 → 「界面定制」。
> **改 `lib/client.js` 或 `lib/index.js` 后必须重启应用**（client bundle 与 host 半边都在启动时读进内存）。

---

## 它解决什么

主题类插件（皮肤、配色、字体、某个组件的补救样式）都是往 `<head>` 注入一张 `<style>`。
装了多个主题插件后，谁盖谁、怎么单独关掉其中一层，以前只能靠改源码或卸载整包。
这个插件把这件事变成一个开关面板；页面背景与对外接口则补上了「外观层还差的那两块」。

## 主题层：判据与开关机制

- **主题层 = 定义了 `--dsw-*` token 的 `<style>`**（另外认自报 `data-dsh-claude-theme` 的层）。
  判据用「定义」（`--dsw-[a-z0-9-]+\s*:`），不是「出现」——只 `var(--dsw-…)` 引用的
  功能性样式（布局修复、滚动条修补）不会被误列。
- **开关 = `style.disabled`**。浏览器原生属性，置真整张样式表失效、置回 false
  立刻恢复。**不需要被管理的插件配合**，所以对第三方主题插件同样有效。
- **谁能被关**：
  1. **本主题层**（带 `data-dsh-claude-theme`）—— 自动托管，行尾直接给开关。**自报优先**；
  2. **其它层** —— 默认只读，点行尾「接管」后才出现开关（显式确认）；
  3. **宿主层** —— 只有**官方 CSS 注入器加载的组件样式**才算宿主：`data-plugin` 在官方
     命名空间（`@deepseek-ai/*`）**且**带 `data-plugin-css`（真实文件路径）。永远只读。
- **持久化**：`localStorage["dsh-theme-manager:off.v1"]`（关掉的层）与
  `["dsh-theme-manager:managed.v1"]`（接管的层）。页面重新加载、或主题插件重建自己的
  style 标签之后，本插件用 `MutationObserver` 盯住 `head` / `body` 的子节点变化，
  把开关状态重新应用上去。
- **自愈**：托管之外的层一律被强制 `disabled = false` —— 历史上被误关的宿主样式，
  插件下次运行时会自己恢复。
- 插件自报友好名：样式标签带 `data-dsh-theme-manager-layer="名字"` 时，列表里显示这个名字
  （合并段给动态字体层用了它，于是那一行显示为「界面字体（通用设置 · 界面定制）」而不是包名）。

## 页面背景（图片 / 视频）

设置 → 主题 → 「页面背景（图片 / 视频）」：

| 项 | 说明 |
| --- | --- |
| 背景类型 | 无 / 图片 / 视频（视频走 `<video>`，可静音、循环、0.1–4× 速率） |
| 本地文件 | **绝对路径**（手填、拖拽、或点「选择文件」）；桌面外壳里 `File` 对象带真实路径，直接用 |
| 网络地址 | `http(s)://…`，由浏览器直接加载，不经过 host |
| 适配方式 | `cover` 铺满 / `contain` 完整 / `fill` 拉伸 |
| 透出范围 | `底板`（只透明页面底板：侧栏与会话区保留原生底色）/ `面板`（各列容器与内容根透明，**背景铺满整个窗口**，推荐）/ `全部`（输入卡片也透出壁纸；正文在输入区前渐隐） |
| 不透明度 / 模糊 / 暗化 | 作用于背景层本身；模糊自带轻微放大，避免边缘露出底 |
| 壁纸上的文字颜色 | 在 `面板` / `全部` 档手动选择 `黑字` / `白字`，立即生效并保存；只改变透明区域文字，白底输入框等控件保持原样 |
| 毛玻璃遮罩（内容底板） | **默认打开**：只在每个列容器上铺一层 `color-mix(官方底色 N%)` + `backdrop-filter: blur(…) saturate(140%)`，避免嵌套遮罩把图片洗白。侧栏取 `--dsw-specific-sidebar-fill`，主区/右栏取 `--dsw-alias-bg-base`；关掉就是纯透明 |

实现要点（都是踩过的坑）：

- **本地文件必须由 host 读**：渲染进程读不到 `file://`（桌面外壳的 `webRequest` 只放行
  `about:` / `data:` / `blob:`）。页面里用**相对路径** `/dsh-theme-manager/media?p=…`，
  它会解析成 `dsh-app://app/...` 并由桌面外壳转发给 host（与 `dsh-preset-hotswap` 同一机制），
  因此没有跨源、CSP、端口问题。
- **媒体路由支持 Range**：`<video>` 可以拖进度条（206 + `Content-Range`；越界给 416）。
- **背景层插在 `body` 的第一个子节点**：文档顺序上早于 `#root`，所以永远在内容之下，
  不需要动任何 `z-index`，也不影响 portal 到 body 的官方弹窗（它照常在最上）。
- **透出范围按官方 shell 的三个列容器定位**（`SHELL_BASE` / `SHELL_COLUMNS` /
  `SHELL_CONTENT`）：`面板` 档只命中 `_sidebarCol`、`_centerCol`、`_rightbarCol`，
  不误改浮层或拖拽手柄；内容根的原生实色单独透明化。`[data-phase]` 也出现在
  输入框上，因此会话根必须同时限定 `_root`，不能用通配选择器。
- **毛玻璃遮罩每列只画一次**（`CARD_SIDEBAR` / `CARD_MAIN`）：默认侧栏用官方侧栏色、
  主区/右栏用官方页面底色，透明度 72%、模糊 20px。输入区仍透出连续壁纸；
  滚动正文在到达输入区前由视图层逐渐淡出，不再从输入卡片背后穿过。
  `全部` 档的输入卡片保留轻度毛玻璃，未就绪时沿用原生遮挡作为兜底。
  会话头与工作区列表的实色边缘也跟随背景。遮罩可关，
  滑块直接控制各列。状态里已有的 `card.enabled` 和参数优先于默认值。
- **清除背景会同时撤销所有覆盖样式**：透明底板只在媒体有效时存在，清除后立刻
  交还 DSH 原生底色。
- **媒体层有主题底色兜底**：图片加载前、失效时，或不透明度低于 100% 时，显示
  `--dsw-alias-bg-base`，避免透出桌面窗口或出现不受控的空白。
- **文字颜色由用户决定**：`黑字` / `白字` 只覆盖透明侧栏、会话标题与正文的文字变量。
  输入卡片和白底“新会话”按钮沿用原主题的文字与背景；不采样视频帧，也不切换组件底色。
  未设置背景时不注入这些覆盖样式。
- **轨迹页不遮挡正文**：DSH 0.2 的轨迹视图带 `data-conversation-composer-overlay`，
  原生样式据此将常驻输入区绝对定位在轨迹内容上；插件按该标记隐藏输入区座位，
  切回对话时原编辑器及草稿仍在。
- **只在「类型或地址变了」时重建元素**：调不透明度 / 模糊只改 CSS —— 否则每拖一下滑块都要
  重新下载图片。地址只由**源**决定（路径进 query，不带 revision）。
- **状态是双份的**：host 的 JSON 是权威，`localStorage["dsh-theme-manager:bg.v1"]` 只是首屏缓存
  （避免开页面闪一下白底）；页面每 4 秒（且回到前台时）拉一次 host，外部软件改了背景会跟上。

## 对外接口（本机 HTTP）

任何本机程序都能调：curl / 快捷指令 / 脚本 / 别的插件。**不需要 token**（插件注册的
prefix 路由不在 host 的鉴权网关后面；根路径 `/` 要 token，插件路由不要）。

```bash
BASE=http://127.0.0.1:<DSH 端口>/dsh-theme-manager     # 端口 = Web GUI 那个（桌面外壳同端口）

# 探活 + 端点清单（也会回一个 "port" 字段，页面就是靠它写出这段地址）
curl $BASE/health

# 读当前背景
curl $BASE/state

# 换成图片（本地绝对路径）
curl -X POST $BASE/background -H 'Content-Type: application/json' \
  -d '{"type":"image","path":"/Users/you/Pictures/a.jpg","coverage":"panels","dim":0.35,"blur":4}'

# 换成视频（可选 loop / muted / rate，也可写成顶层 loop、muted、rate）
curl -X POST $BASE/background -H 'Content-Type: application/json' \
  -d '{"type":"video","path":"/Users/you/Movies/a.mp4","video":{"loop":true,"muted":true,"rate":0.8}}'

# 只调参数（部分更新：没提到的字段保持原值）
curl -X POST $BASE/background -d '{"opacity":0.6,"card":{"enabled":true,"alpha":0.7}}' -H 'Content-Type: application/json'

# 清除背景
curl -X POST $BASE/background/clear

# 直接取媒体文件（支持 Range；只服务扩展名白名单里的媒体）
curl -o /tmp/pic.png "$BASE/media"
curl -H 'Range: bytes=0-1023' "$BASE/asset?p=/Users/you/Pictures/a.jpg"
```

- **字段**：`type`(`none|image|video`)、`path`、`url`、`source`(`{kind,value}`)、
  `fit`、`position`、`opacity`(0–1)、`blur`(0–60)、`dim`(0–1)、`coverage`(`base|panels|full`)、`textColor`(`black|white`)、
  `video.{loop,muted,rate}`、`card.{enabled,alpha,blur}`。未知字段丢弃，越界值钳制，
  `updatedBy` 记 `X-DSH-Theme-Source` 头（便于分辨是谁改的）。
- **类型会自动纠正**：声明 `image` 却给了 `.mp4` → 按扩展名纠正成 `video`；只给 `path` 时按扩展名推断。
- **路径不存在**也会写入成功，但回包带 `warning`（文件稍后才放进来也照样能用）。
- **安全边界**：路由只在回环（`127.0.0.1`）上；`/asset` 只服务**媒体扩展名白名单**
  （jpg/jpeg/png/webp/gif/avif/bmp/mp4/m4v/webm/ogv/ogg/mov），`.txt` 之类一律 415，
  **不含 svg**（同源渲染 SVG 可执行脚本）。请求体上限 64KB。
- 页面里还有一行旁路接口：`window.__dshTheme.get() / set({…}) / image(path) / video(path) / clear() / refresh()`。

## 合并进来的「界面统一」段（原 dsh-ui-harmonizer）

v0.8.0 起，`dsh-ui-harmonizer` 0.8.3 的浏览器半边合并进 `lib/client.js`
（调整 style 标签的命名空间、日志前缀和 DSH 0.2 的消息隐藏兼容；`localStorage["harness-ui-enhancer.state"]`
原样保留，所以你原有的宽度 / 字号 / 字体设置不会丢）。原先单独挂载的包已从两个 profile 的
`dsh.profile.bundles` 与 `dependencies` 里移除 —— **外观层只留本插件一个入口**。

带过来的能力（设置 → 通用设置 → 「界面定制」，与原来完全一样）：

- 官方 UI 规范化：顶部栏单行化、按钮胶囊族、设置页头统一、原生 `title` 提示改用官方气泡渲染；
- 插件视觉协调：better-sidebar（面板 / 开关 / 根类同步）、genui 工具面板、第三方设置页自动补标题与间距；
- 界面定制：对话内容宽度、对话字号、工作区字号、UI 字体、圆角卡片；
- 会话区圆角卡片覆盖层（`shell.overlay`）。

消息行的隐藏与高度由 DSH 管理。合并段不再给 `_flowItem` 设置
`content-visibility:auto` 和 `contain-intrinsic-size:auto 120px`：前者会覆盖
原生 `hidden="until-found"`，后者会在会话切换时引入估算高度变化。
该修正同时保存在 vendor 副本与内联产物中。

维护方式：

```bash
node tools/inline-harmonizer.mjs            # 用 tools/vendor/ 里的源码副本重新生成（幂等）
node tools/inline-harmonizer.mjs <client.js> # 用指定文件重新生成，并刷新 vendor 副本
```

- 生成脚本只替换 `@@HARMONIZER-INLINE-START/END@@` 之间的内容，其余代码一个字不动；
- 每条命名空间替换都要求命中，命中数为 0 直接报错退出（上游改版时宁可失败，也不要静默改坏）；
- 源码副本 `tools/vendor/dsh-ui-harmonizer-0.8.3-client.js` 随仓库保留 —— 原包卸载后仍可重建。
- 上游：<https://github.com/Physicolor/dsh-ui-harmonizer>（MIT）。

## 调色盘

一栏 9 个颜色槽（品牌色 / 页面底色 / 浮层 / 次级底色 / 气泡 / 主文字 / 次要文字 /
弱化文字 / 边框），每槽三种改法：系统取色器、粘贴任意 CSS 颜色、底部 6 套现成配色一键铺满。

- 用户选的颜色写进**独立**一张 `<style id="dsh-theme-manager-palette">`，选择器是
  `html body:not([data-dsh-colors=off]):not([data-ds-dark-theme])` —— 特异性 (0,2,2)
  高于主题 `COLOR_CSS` 的 (0,1,1)，所以**主题层重建或顺序变化都不会盖掉用户调的颜色**；
- 只覆盖**改过**的槽位，其余 token 仍走主题默认；只作用于**浅色模式**；
- 状态存 `localStorage["dsh-theme-manager:palette.v1"]`。

## 菜单浮层（不干预）

模型选择 / 右键菜单这类 `MenuSurface` 浮层**完全跟随官方外观**（`--dsw-menu-surface-fill`
与 `--dsw-menu-backdrop-filter` 由官方给出）。v0.4.1–v0.5.0 曾无条件把它们改成实色，
v0.6.0 起已删除：调色盘只在用户**真的改过某个槽位**时才注入 `<style>`。
要再给菜单做定制，请做成**带开关**的独立段落，别用「恒存在的标签写死 token」。

**分组标题**（「DeepSeek 账号」「GPT」这些组名）另有一档开关：`跟随面板`（默认，把叠色换成同款
毛玻璃、并取消吸顶）↔ `官方叠色`。状态存 `localStorage["dsh-theme-manager:menu.v1"]`。

## 装了什么

```
dsh-theme-manager
  ├─ lib/index.js   host 半边：/dsh-theme-manager/* 路由（状态读写 + 媒体流 + Range）、
  │                 状态落盘 $DSH_HOME/state/theme-manager/background.json
  ├─ lib/client.js  浏览器半边：主题层扫描/开关、调色盘、菜单修补、页面背景层、
  │                 设置页（settings.section id=theme-manager）、
  │                 合并进来的「界面统一」段
  ├─ tools/inline-harmonizer.mjs   合并段的生成器（+ tools/vendor 源码副本）
  └─ tests/         三个离线回归（见下）
```

不注册任何模型工具、不发任何外部网络请求（只跟自己的 host 路由通信）。

## 安装

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: theme-manager
      name: 'dsh-theme-manager'
```

```jsonc
// profile 的 package.json
"dependencies": { "dsh-theme-manager": "link:../../local-plugins/dsh-theme-manager" }
```

`desktop` profile 被 Electron 独占（CLI 子命令会被拒），需手改 `package.json` 再
`~/.dsh/bin/pnpm10 install --prefer-offline --ignore-scripts`。
改完 `lib/*.js` **重启应用**才生效（刷新页面不够）。

## 已知限制

- 只能管「注入 `<style>` 的主题」。若某插件通过 `<link>`、内联 `style=""` 或 CSS-in-JS 生效，
  它不会出现在列表里。
- 开关是页面级的：不改插件安装状态；要真正卸载某个主题插件，去「设置 → 插件」。
- 同名层被多个插件重复注入时，列表里会出现多行（各自独立开关）。
- 背景的「透出范围」是**属性选择器**（`[data-slot="sidebar"]` 等）实现的，官方前端大改结构时可能失效；
  背景层参数（不透明度 / 模糊 / 暗化 / 内容底板）不受影响。
- 浏览器里打开 DSH Web（非桌面外壳）时，文件选择器**拿不到绝对路径** —— 此时只做临时 blob 预览并给出提示，
  要持久化请手填绝对路径或用 HTTP 接口。
- 合并段的 CSS 选择器依赖官方 CSS Modules 的**类名后缀**，与上游一样属于版本敏感型补丁。

## 测试

```bash
node tests/layer-classify-test.mjs   # 24 项：主题层边界 / 接管 / key 唯一性 / 轨迹视图输入区（最小 DOM stub 真跑 client.js）
node tests/host-api-test.mjs         # 66 项：真实 HTTP —— 状态归一化与钳制、落盘、Range 206/416、扩展名白名单、CORS、413
node tests/background-test.mjs       # 85 项：stub DOM 真跑 client.js —— 背景层生成/复用/移除、参数→CSS、与 host 往返、
                                     #        合并段是否真的挂上（3 个 slot + 命名空间）
npm test                             # 三个一起跑
```

三个测试都**不需要重启应用、不需要浏览器**：host 部分把 handler 挂到真实 `node:http` 上打请求，
client 部分用最小 DOM stub 跑真的 `factory`。视觉与采样行为另用 Chromium 模拟真实布局验证。

## License

MIT © 2026 jipika

`lib/client.js` 中的「界面统一」段（`@@HARMONIZER-INLINE-START/END@@` 之间）是
[dsh-ui-harmonizer](https://github.com/Physicolor/dsh-ui-harmonizer) v0.8.3 的逐字副本，
版权归其作者（MIT）。详见该仓库 LICENSE。
