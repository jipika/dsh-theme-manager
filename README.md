<div align="center">
  <img src="assets/icon.svg" width="72" alt="dsh-theme-manager icon">
</div>

# dsh-theme-manager

> 给 DeepSeek Harness 的**窄口径**外观插件。设置 → 左侧导航「主题」里只有两件事：
> 换**主色调 / 背景色**，换**页面背景**（图片 / 视频，也能被本机 HTTP 接口远程更换）。
> 另外把「界面定制」并了进来（设置 → 通用设置的 **工作区字号 / UI 字体**，原
> `dsh-ui-harmonizer` 的那一块；对话内容宽度 / 对话字号 / 圆角卡片已删除）。除此之外什么都不管。

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> **拥有**：设置页「主题」（`settings.section id=theme-manager`）；本插件的三张 `<style>`
> （设置页样式 / 调色盘 / 背景）；背景层 `#dsh-theme-manager-bg-layer`（插在 `body` 最前面）；
> host 侧路由 `/dsh-theme-manager/*` 与状态文件 `$DSH_HOME/state/theme-manager/background.json`；
> 「界面定制」段（`settings.general.item` 里一行：工作区字号 / UI 字体）。
> **冲突时**：对话列宽度完全归官方拖拽（本插件不再写 `--dsh-chat-content-width`）；会话滚动行为归
> `dsh-think-ux` / `dsh-smooth-stream`；MenuSurface token（`--dsw-menu-surface-fill` 等）**一律不改**
> （菜单保持官方毛玻璃）。
> **回滚**：删 profile `cordis.patch.yml` 里 id `theme-manager` 的 insert + 重启应用；只回滚背景
> → 主题页点「清除背景」，或删 `~/.dsh/state/theme-manager/background.json`。

> **入口**：设置 → 左侧导航「主题」；界面定制在 设置 → 通用设置 → 「界面定制」。
> **改 `lib/client.js` 或 `lib/index.js` 后必须重启应用**（client bundle 与 host 半边都在启动时读进内存）。

---

## 它做什么（v0.9.0 的边界）

| 块 | 位置 | 内容 |
| --- | --- | --- |
| 主色调 / 背景色 | 设置 → 主题 | **2 个颜色槽**：主色调（品牌 / 强调色）、背景色（页面底色）；每个槽 = 系统取色器 + 粘贴任意 CSS 颜色 + 重置 |
| 页面背景 | 设置 → 主题 | 图片 / 视频壁纸（本地绝对路径 · 拖拽 · 网络地址），适配方式、透出范围、不透明度 / 模糊 / 暗化、壁纸文字颜色、毛玻璃遮罩 |
| 界面定制 | 设置 → 通用设置 | 工作区字号、UI 字体（原 `dsh-ui-harmonizer` 的设置项；对话内容宽度 / 对话字号 / 圆角卡片已删除） |

不注册模型工具、不发外部网络请求（只跟自己的 host 路由通信）。

## v0.9.0 删掉了什么（以及为什么）

| 删掉 | 原因 |
| --- | --- |
| **主题层逐层开关面板** | 它管理的是「注入了 `--dsw-*` 的 `<style>` 层」，不是颜色 / 背景；与「设置 → 插件」的职责重叠。连带 `localStorage` 的 `off.v1` / `managed.v1`、接管逻辑、MutationObserver 自愈一起删 |
| **菜单分组标题修补**（跟随面板 / 官方叠色两档） | 模型选择菜单里分组名的吸顶与叠色，是布局修补，与主题 / 背景无关 |
| 内联段里的**「官方 UI 规范化」** | 顶部栏单行化、按钮胶囊族、设置页头统一、原生 `title` 气泡渲染 —— 不是主题职责 |
| 内联段里的**「插件视觉协调」** | better-sidebar 面板 / 开关同步、genui 工具面板、第三方设置页补标题与间距 —— 不是主题职责 |
| 调色盘其余 **7 个槽 + 6 套预设** | 只留「主色调」与「背景色」；配色预设与单槽功能重复 |
| `tools/inline-harmonizer.mjs` + `tools/vendor/` | 内联段已按需裁剪，不再与上游逐字同步 —— 留着生成脚本会把裁剪覆盖回去 |

**保留**：页面背景的全部能力（含毛玻璃遮罩、透出范围、文字颜色）、对外 HTTP 接口、host 半边。
内联段里另保留了 5 条**布局让位**规则（会话区 / 输入框按 `--dsh-sidebar-width` 给右侧栏让位）——
它们不是外观美化，删掉会让右侧文件面板盖住内容。

精简幅度：

| | 0.8.6 | 0.9.0 |
| --- | --- | --- |
| `lib/client.js` | 3552 行 | 2458 行 |
| 内联段 CSS 规则 | 97 条 | 39 条 |
| 离线测试 | 3 文件 / 175 项 | 2 文件 / 155 项 |

## 主色调 / 背景色

主题页下半部分：**两个槽**，各自三种改法（系统取色器 / 粘贴任意 CSS 颜色 / 重置）。

- 用户选的颜色写进**独立**一张 `<style id="dsh-theme-manager-palette">`，选择器是
  `html body:not([data-dsh-colors=off]):not([data-ds-dark-theme])` —— 特异性 (0,2,2)
  高于主题层（0,1,1），所以**主题层重建或顺序变化都不会盖掉用户调的颜色**；
- 只覆盖**改过**的槽位，其余 token 仍走主题默认；只作用于**浅色模式**；
- 状态存 `localStorage["dsh-theme-manager:palette.v1"]`；早期版本存的其它 7 个槽位会被自动忽略。

| 槽 | token |
| --- | --- |
| 主色调 | `--dsw-alias-brand-primary`、`--dsw-alias-button-primary-fill`、`--dsw-specific-sidebar-nav-item-active-accent` |
| 背景色 | `--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1`（**刻意不含** `--dsw-specific-sidebar-fill`） |

> **背景色不碰左侧栏**（v0.9.2 起）：`--dsw-specific-sidebar-fill` 是侧栏底色的输入，
> macOS 上官方还拿它算窗口材质（`[data-platform="darwin"] ._sidebarCol` 的
> `color-mix(… 97%, #7a9bf0)` 40% 混色 + 蓝紫双段渐变）。早先把它列进「背景色」槽，
> 结果是**换个背景色就把左侧材质一起洗平**。现在背景色只写会话主区的两个 token，
> 侧栏交还官方 —— 材质、渐变、选中态强调色（主色调槽那条）都照旧。

菜单类浮层（模型选择 / 右键菜单）**完全跟随官方外观**：调色盘只在用户真的改过槽位时才注入
`<style>`，且从不写 `--dsw-menu-surface-fill` / `--dsw-menu-backdrop-filter`。

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

## 界面定制（原 dsh-ui-harmonizer，已裁剪）

设置 → 通用设置 → 「界面定制」，现在只剩两行：

- **工作区字号**（`--enhancer-sidebar-scale`，12–20px）：左侧工作区列表 / 按钮 / 图标的整体大小；
- **UI 字体**（6 套预设）：只覆盖 markdown 的 `--dsw-font-markdown-*-font-family` 变量，
  **不再接管字号 / 行高 / 字重**（官方 `--dsh-content-font-size` + `--dsh-content-font-delta` 说了算）；
- 状态键仍是 `localStorage["harness-ui-enhancer.state"]`，但只读 `sidebarSize` / `fontId` ——
  已删除的 `width` / `fontSize` / `card` 在首次载入后即被覆写清除（不会有幽灵设置继续生效）。

**已删除的三项**（用户要求）：对话内容宽度（连同 `div[data-phase]{--dsh-chat-content-width}` 覆盖，
对话列宽度完全回归官方拖拽）、对话字号（连同 composer 栏 / 菜单的 `--enhancer-chat-scale` 缩放）、
圆角卡片（`shell.overlay` 覆盖层 + `.enhc-center-card*` 全部规则与 `html.enhc-center-card-on` 类）。

裁剪掉的（v0.9.0）：官方 UI 规范化、better-sidebar / genui 协调、设置页统一头、原生 `title`
气泡、第三方设置页补标题与间距 —— 这些都不属于「主题 / 外观」，且与 `dsh-ui-fixes`、
`dsh-plugin-polish` 的职责重叠。裁剪后 CSS 只剩 `--enhancer-sidebar-scale` 驱动的侧栏缩放规则，以及 5 条右侧栏让位规则（约 3.3KB）。

内联段现在是**本插件自有代码**：`tools/inline-harmonizer.mjs` 与 `tools/vendor/`（上游逐字副本 +
生成脚本）已删除 —— 否则重新生成会把裁剪覆盖回去。
上游参考：<https://github.com/Physicolor/dsh-ui-harmonizer>（MIT）。

## 装了什么

```
dsh-theme-manager
  ├─ lib/index.js   host 半边：/dsh-theme-manager/* 路由（状态读写 + 媒体流 + Range）、
  │                 状态落盘 $DSH_HOME/state/theme-manager/background.json
  ├─ lib/client.js  浏览器半边：主色调 / 背景色调色盘、页面背景层、
  │                 设置页（settings.section id=theme-manager）、
  │                 内联的「界面定制」段（已裁剪）
  └─ tests/         两个离线回归（见下）
```

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

- 调色盘只作用于**浅色模式**；暗色模式是另一套 token，不做覆盖。
- 背景的「透出范围」是**属性选择器**（`[data-slot="sidebar"]` 等）实现的，官方前端大改结构时可能失效；
  背景层参数（不透明度 / 模糊 / 暗化 / 内容底板）不受影响。
- 浏览器里打开 DSH Web（非桌面外壳）时，文件选择器**拿不到绝对路径** —— 此时只做临时 blob 预览并给出提示，
  要持久化请手填绝对路径或用 HTTP 接口。
- 「界面定制」的 CSS 选择器依赖官方 CSS Modules 的**类名后缀**，与上游一样属于版本敏感型补丁。
- 本插件不再提供「主题层逐层开关」：装了新的主题插件后，要停用它请到「设置 → 插件」。

## 测试

```bash
node tests/host-api-test.mjs         # 66 项：真实 HTTP —— 状态归一化与钳制、落盘、Range 206/416、扩展名白名单、CORS、413
node tests/background-test.mjs       # 89 项：stub DOM 真跑 client.js —— 背景层生成/复用/移除、参数→CSS、与 host 往返、
                                     #        主色调调色盘只注入改过的槽、内联「界面定制」段只剩两个设置项、已删三项不复发
npm test                             # 两个一起跑
```

两个测试都**不需要重启应用、不需要浏览器**：host 部分把 handler 挂到真实 `node:http` 上打请求，
client 部分用最小 DOM stub 跑真的 `factory`。视觉与采样行为另用 Chromium 模拟真实布局验证。

`tests/host-api-test.mjs` 依赖 `/tmp/dsh-theme-test/` 里的媒体 fixture（`pic.png` / `clip.mp4` /
`notes.txt` / `x.svg`），机器重启后 `/tmp` 被清空会 `ENOENT`，先重建即可：

```bash
mkdir -p /tmp/dsh-theme-test/home && cd /tmp/dsh-theme-test
python3 -c "open('pic.png','wb').write(b'\x89PNG\r\n\x1a\n'+b'0'*2048); open('clip.mp4','wb').write(b'ftypisom'+b'0'*2048); open('notes.txt','w').write('x'); open('x.svg','w').write('<svg/>')"
```

## License

MIT © 2026 jipika

`lib/client.js` 里的「界面定制」段派生自 [dsh-ui-harmonizer](https://github.com/Physicolor/dsh-ui-harmonizer)
v0.8.3（MIT，版权归其作者），v0.9.0 起按本插件的窄口径做过裁剪，不再逐字同步。
