# dsh-theme-manager

> One settings page that lists every **theme layer** injected into the DSH page and
> switches each of them on or off — live, no restart.
>
> 给 DeepSeek Harness 一个「主题管理」页：把页面上每个定义了 `--dsw-*` token 的
> 样式层列出来，逐层开关，改完立即生效并记在本机。

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> **入口**：设置 → 左侧导航「主题」。
> **回滚**：删 profile `cordis.patch.yml` 里 id `theme-manager` 的 insert + 重启应用。

---

## 它解决什么

主题类插件（皮肤、配色、字体、某个组件的补救样式）都是往 `<head>` 注入一张
`<style>`。装了多个主题插件后，谁盖谁、怎么单独关掉其中一层，以前只能靠改源码或
卸载整包。这个插件把这件事变成一个开关面板。

## 判据与开关机制

- **主题层 = 定义了 `--dsw-*` token 的 `<style>`**（另外认自报 `data-dsh-claude-theme` 的层）。
  判据用「定义」（`--dsw-[a-z0-9-]+\s*:`），不是「出现」——只 `var(--dsw-…)` 引用的
  功能性样式（布局修复、滚动条修补）不会被误列。
- **开关 = `style.disabled`**。浏览器原生属性，置真整张样式表失效、置回 false
  立刻恢复。**不需要被管理的插件配合**，所以对第三方主题插件同样有效。
- **谁能被关（v0.2 起的三类边界）**：
  1. **本主题层**（带 `data-dsh-claude-theme`）—— 自动托管，行尾直接给开关；
  2. **其它有标识的层** —— 默认只读，点行尾「接管」后才出现开关（显式确认）；
  3. **宿主层**（带 `data-plugin` / `data-plugin-css`）**与无标识层** —— 永远只读。

  这一条是踩坑换来的：官方 `@deepseek-ai/dsh-client-ui-theme` 会把**每个 CSS 文件**
  注入成 `<style data-plugin="@deepseek-ai/dsh-client-ui-theme" data-plugin-css="…/tokens.css">`
  （tokens / scrollbar / design-platform … 十几张）。v0.1 按「有 id 或 data-* 就可关」
  判定，并且层标识只取第一个 `data-*` 属性 → 十几张塌成同一个 key，一按「全部关闭」
  就把整套 `--dsw-*` token 关掉，**整个界面失去样式**。
- **持久化**：`localStorage["dsh-theme-manager:off.v1"]`（关掉的层）与
  `["dsh-theme-manager:managed.v1"]`（接管的层）。页面重新加载、或主题插件重建自己的
  style 标签之后，本插件用 `MutationObserver` 盯住 `head` / `body` 的子节点变化，
  把开关状态重新应用上去。
- **自愈**：托管之外的层一律被强制 `disabled = false` —— 历史上被误关的宿主样式，
  插件下次运行时会自己恢复；v0.1 遗留的脏标识（`attr:data-plugin=…`）也会被丢掉。
- 层标识优先级：`data-dsh-claude-theme` → `data-plugin-css`（宿主，逐文件唯一）→
  `id` → 全部 `data-*` 属性拼接 → 内容哈希。

## 菜单纯色面板（v0.4.1 起是固定行为，没有开关）

模型选择 / 右键菜单这类 `MenuSurface` 浮层固定用**纯色、不透明、无毛玻璃**的面板：

```css
--dsw-menu-surface-fill: var(--dsw-alias-bg-base, #FAF9F5);
--dsw-menu-backdrop-filter: none;
```

- 颜色写成 `var(--dsw-alias-bg-base)` **引用**而不是写死色值 —— 调色盘改「页面底色」时
  菜单跟着变，**永远是同一个颜色**；
- 官方 `--dsw-specific-menu` 的值本身就是 `var(--dsw-menu-surface-fill)`，所以菜单里的
  sticky 分组标题条会自动同色（整块单一颜色，不会出现两种灰）；
- 这两条声明无条件写入（调色盘 style 标签恒存在），**没有开关、也没有 localStorage 状态**。

**落点说明**：改动只在本插件；主题 `dsh-claude-theme` 仍然一个菜单 token 都不碰。

## 调色盘

一栏 9 个颜色槽（品牌色 / 页面底色 / 浮层 / 次级底色 / 气泡 / 主文字 / 次要文字 /
弱化文字 / 边框），每槽三种改法：

- **系统取色器**：点色块 —— macOS 里自带吸管，可以直接吸屏幕上任意位置的颜色；
- **粘贴色值**：右边文本框吃任意 CSS 颜色（`#RGB` / `#RRGGBB` / `#RRGGBBAA` /
  `rgb()` / `rgba()`），回车或失焦生效，非法输入标红且不写入；
- **现成配色**：底部 6 套预设（Claude 暖米色 / 石墨灰 + 琥珀 / 海蓝 / 森绿 / 雾紫 /
  纯白 + 墨黑）一键铺满；「恢复默认配色」清掉全部自定义。

实现要点：

- 用户选的颜色写进**独立**一张 `<style id="dsh-theme-manager-palette">`，选择器是
  `html body:not([data-dsh-colors=off]):not([data-ds-dark-theme])` —— 特异性 (0,2,2)
  高于主题 `COLOR_CSS` 的 (0,1,1)，所以**主题层重建或顺序变化都不会盖掉用户调的颜色**；
- 只覆盖**改过**的槽位，其余 token 仍走主题默认；只作用于**浅色模式**（暗色是另一套
  token，混用会难看）；
- 状态存 `localStorage["dsh-theme-manager:palette.v1"]`，形如
  `{"brand":"#7C6BD6","border":"rgba(0,0,0,.12)"}`；
- 调色盘标签带 `data-dsh-theme-manager="palette"`，扫描时同 `="own"` 一起被排除，
  不会把自己列成一个可关的层。

## 装了什么

- `lib/client.js`：设置页（`settings.section` slot，id `theme-manager`，左侧导航显示
  「主题」）+ 扫描 / 应用 / 持久化逻辑 + 一行自绘样式。
- `lib/index.js`：host 半边空实现（只为让 cordis 有一行可挂载的记录）。
- 不注册任何工具、不发任何网络请求、不写插件配置。

## 安装

```bash
dsh plugin --profile <profile> add dsh-theme-manager
```

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: theme-manager
      name: dsh-theme-manager
```

`desktop` profile 被 Electron 独占（CLI 子命令会被拒），需手改 `package.json`
（dependencies 加 `link:../../local-plugins/dsh-theme-manager`）+ `pnpm install`，
再 insert 同一行。

改完 `lib/client.js` 后重新打开页面（一次新导航）即加载新代码；界面没变化再重启应用。

## 已知限制

- 只能管「注入 `<style>` 的主题」。若某插件通过 `<link>`、内联 `style=""` 或
  CSS-in-JS 生效，它不会出现在列表里。
- 开关是页面级的：它不改插件的安装状态。要真正卸载某个主题插件，去「设置 → 插件」。
- 同名层被多个插件重复注入时，列表里会出现多行（各自独立开关）。

## License

MIT © 2026 jipika
