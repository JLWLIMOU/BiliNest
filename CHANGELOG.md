# Changelog

本项目更新日志，**面向发布者**：发布者据此快速核对改动、更新 GitHub Release，并撰写面向使用者的描述。
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## 发布流程（发布者必读）

1. 把 `[Unreleased]` 改名为 `[x.y.z] - 日期`（按语义化版本决定升几位）；
2. 同步更新 `package.json` 的 `version`；
3. 每个条目**本身就是面向使用者的描述**，可直接整理成 GitHub Release 的「新增 / 修复 / 变更」列表；
4. 条目下方的「涉及文件 / 技术细节」供核对用，**不要粘贴进 GitHub Release**；
5. 发布前建议快速验证：`npm start`（或双击 `launcher.vbs`）→ 登录 → 播放一个收藏夹视频（弹幕/字幕/画质）→ 设置里确认版本号；
6. 若涉及配置/存储键/端口文件（见各条「技术细节」），在 Release 描述里提示旧数据会自动迁移，无需用户手动操作。

---

## [1.1.0] - 2026-09-12

### Added（新增）

- **学习 UP主书签**：主页新增「学习 UP主」栏，输入 UID 添加 UP主 卡片（头像/名称/简介/粉丝数/星级评分），点击卡片跳转 B站个人主页。
  - 涉及文件：`server.mjs`、`public/storage.js`、`public/api.js`、`public/app.js`、`public/styles.css`
  - 技术细节：
    - 新增 `/x/web-interface/card` 代理路由获取 UP主 信息；
    - `studyUps` 存储于 localStorage，结构 `{ mid, name, face, sign, fans, videos, level, addedAt, stars }`；
    - 卡片点击 `window.open('https://space.bilibili.com/{mid}', '_blank')`；
    - 补充 `fmtCount`、`fixAvatar` 工具函数。

- **主页标签页**：主页从纵向堆叠改为标签页切换模式（继续学习 / 视频库 / 收藏夹库 / 学习 UP主），每次只显示一个栏位，标签状态持久化。
  - 涉及文件：`public/app.js`、`public/styles.css`、`public/storage.js`
  - 技术细节：
    - `renderDashboard()` 重写为标签栏 + 内容区两层结构；
    - `state.activeDashTab` 持久化到 localStorage，记住上次选中的标签；
    - 每个标签独占整个主页空间，默认显示更多卡片（继续学习 12 / 视频库 20 / 收藏夹 12 / UP主 12）；
    - 搜索框仅在「视频库」标签下显示。

- **移除学习 UP主**：学习 UP主 卡片右侧新增「✕」按钮，点击后弹出确认框，确认即从列表中移除。
  - 涉及文件：`public/app.js`
  - 技术细节：复用 `confirmAction()`（与「从收藏夹库移除」一致）；卡片渲染新增 `data-up-remove`，`onDashboardClick` 中在卡片跳转之前处理并 `stopPropagation`，避免误触发跳转 B站主页。

- **空状态补充「添加 UP主」入口**：仪表盘没有任何内容时（包括移除最后一个 UP主 之后），空状态在「打开内容源」旁新增「添加 UP主」按钮，避免进入再也加不了 UP主 的死角。
  - 涉及文件：`public/app.js`

- **自定义标签页**：标签栏末尾新增「＋」直接新建标签页（建完立即内联改名，双击标签也能改名；悬浮标签出现的「⋯」可重命名 / 删除标签页）。空标签页内有一张「＋ 添加内容」卡片，点开是四分区选择器：源收藏夹 / 视频库 / 收藏夹库 / 学习 UP主；库侧三个分区的条目带缩略图（封面 / 头像，无图时显示占位文字），源收藏夹列表不显示封面。选视频不再另做一套浏览界面——点「源收藏夹」里的收藏夹会直接进入右上角「内容源」那套收藏夹视图（自带搜索 / 排序 / 分页），只是带着「正在往哪个标签页加」的上下文。
  - 涉及文件：`public/storage.js`、`public/app.js`、`public/styles.css`
  - 技术细节：
    - `customTabs` 存于 localStorage，结构 `{ id, name, createdAt, items:[{ kind:'video'|'folder'|'up', id }] }`；`items` 只存库内实体的引用，不拷贝数据，删标签页不会删内容；
    - `tabMembers()` 解析成员时跳过已失效的引用（条目从库中删除后自愈）；成员按 视频 / 收藏夹库 / 学习 UP主 分组渲染，复用 `videoCard()` / `folderCard()` / `studyUpCard()`（三者新增可选 `ctx` 参数：`ctx.tab` 存在时卡片上的 ✕ 变为「从本标签页移除」，不动库）；
    - 选择器里「源收藏夹」分区勾选收藏夹本体 → 先写入 `studyFolders`（入库）再入页；点收藏夹行则关闭选择器、进入收藏夹视图（复用内容源那一套），并设置 `state.pendingTabId` 记录目标标签页；另外三个分区只入页（内容已在库）；已在本页的条目置灰、不可重复勾选；
    - 库侧三个分区支持排序：视频「星级 / 添加时间 / 播放量 / 发布时间」、收藏夹库「星级 / 添加时间 / 视频数」、UP主「星级 / 添加时间 / 粉丝数」，默认星级优先（次键为添加时间）；
    - 源收藏夹列表不显示封面：B站收藏夹列表接口本身不返回封面，显示占位图没有辨识度（`pickerRows()` 里给该分区行标记 `plain: true`，渲染时跳过缩略图）；
    - 新增 `ensureVideoInLibrary(bvid, media)`：把收藏夹里的单个视频补进「视频库」并返回库内 id，与内容源里的「加入学习」共用同一段「多P / 合集」归类逻辑；提交时逐条 await，失败的条目会单独计数并提示；
    - 主页标签栏改为数据驱动（`SYSTEM_TABS` + `customTabs()`）；新增 `normalizeDashTab()`，标签页被删或存储值非法时回落到「继续学习」；
    - 自定义标签页的搜索关键字各自记录（`state.tabQuery`，内存态，不持久化），不会与其他标签页串台。

- **收藏夹视图的卡片右上角状态区**：同一张视频卡片按来源渲染不同状态，一眼看出「在不在库里」和「在不在某个自定义标签页」。
  - 涉及文件：`public/app.js`、`public/styles.css`
  - 技术细节：
    - 蓝色 ✓ = 已在「学习列表」（库）；绿色 ✓ = 已在自定义标签页（从标签页进入时指当前页，从内容源进入时指任意标签页，悬浮显示标签页名）；
    - 从自定义标签页进来（`state.pendingTabId` 有值）时，未入库的视频显示一个**淡绿色 +**，悬浮提示「添加到「xx」标签页（同时加入学习列表）」，点一下同时完成入库 + 入页，随后变为蓝 ✓ + 绿 ✓；
    - 从右上角「内容源」进来（无上下文）时保留原有蓝色 +/✓，另加一个「添加到」按钮：点击弹出标签页菜单（已有标签页 + 「新建标签页并加入」），选完自动补上绿色 ✓；
    - 收藏夹视图头部在有上下文时显示「正在添加到「xx」标签页」；回主页即清除该上下文；
    - `addVideoToTab()` 复用 `ensureVideoInLibrary()` 完成「先入库再入页」；通用小面板 `openActionMenu()` 由标签页「⋯」菜单与本次的标签页选择菜单共用。

- **新标签页默认名自动编号**：连续新建时依次叫「新标签页」「新标签页2」「新标签页3」…；某个默认名被改掉后，该序号会重新空出来复用（改成「日语」后，再新建又叫「新标签页」）。
  - 涉及文件：`public/app.js`
  - 技术细节：`nextDefaultTabName()` 用现有标签页名做集合，取最小可用序号。

- **自定义标签页改成绿色强调色 + 与系统标签加分隔线**：系统标签页保持原来的蓝色，自定义标签页（选中态、悬浮态、下划线）改用绿色，与「加入标签页」的绿色 +/✓ 统一；系统标签与自定义标签之间加一条竖分隔线。
  - 涉及文件：`public/styles.css`
  - 技术细节：新增设计令牌 `--tab-green` / `--tab-green-soft`（深色模式单独取值），`.dash-tab.custom(.active/:hover)` 使用它；原来写死的绿色（`.card-flag-tab`、`.card-add-tab`）改为引用同一令牌；分隔线 `.dash-tabs-sep` 只在存在自定义标签页时渲染。

- **自定义标签页支持拖动排序**：按住标签横向拖动即可调整顺序，拖到「＋」上可移到最末。
  - 涉及文件：`public/app.js`、`public/styles.css`
  - 技术细节：自定义标签（含内部文字）标记 `draggable`；在 `els.dashboard` 上委托 `dragstart/dragover/drop/dragend`，`dragover` 时按鼠标在目标标签左/右半边显示 `.drop-before` / `.drop-after` 插入指示；落点交给 `moveCustomTab(srcId, targetId, after)` 重排 `customTabs` 数组并持久化；改名输入框上不触发拖动。

- **标签页过多时的处理：横向滚动**：系统标签固定在左侧，自定义标签放进可横向滚动的区域，标签再多也不会把「＋」挤出屏幕或撑破页面。
  - 涉及文件：`public/app.js`、`public/styles.css`
  - 技术细节：
    - 标签栏改为三段结构：系统标签（固定）+ 分隔线（固定）+ `.dash-tabs-scroll`（`flex:1; min-width:0; overflow-x:auto`，隐藏滚动条）；
    - 「＋」放在滚动区末尾并用 `position: sticky; right: 0`：**不溢出时它就是普通流式位置（跟在最后一个标签后面），只有内容溢出、横向滚动时才贴住右侧**保持可达；溢出时给一层左侧阴影说明有内容从下面滑过；
    - 滚动区向左滚出内容时左侧渐隐（`.scrolled` + `mask-image`）；鼠标滚轮在标签栏上时纵向增量转成横向滚动；
    - `syncTabsScroll()` 在每次渲染后把当前标签滚进可视区，并**预留贴住的「＋」的宽度**（不能用 `scrollIntoView`，它不知道右侧被覆盖，会把当前标签塞到「＋」底下）；窗口 resize 时重新计算；
    - 拖动排序时靠近滚动区两侧 48px 内自动滚动（rAF 循环），否则拖不到看不见的位置。

- **从标签页移除内容时可选「同时从库中删除」**：自定义标签页里卡片上的 ✕ 不再直接移除，改成二级确认框，内含一个**默认不勾选**的「同时从库中删除」复选框；勾选则连同库里的实体一起删（从「视频库」/「收藏夹库」/「学习 UP主」里删掉，其它标签页里的它也会一起消失）。
  - 涉及文件：`public/app.js`
  - 技术细节：`removeFromTab()` 改用 `confirmAction(msg, onConfirm, beforeClose)` 的 `beforeClose` 读取复选框；新增 `deleteFromLibrary(kind,id)`（不弹确认的裸删除）、`findLibraryItem()` / `libraryItemName()`、`dropMemberEverywhere(kind,id)`（清掉所有标签页里的悬空引用）；视频走 `doRemoveCustomVideo(..., silent)` 复用既有的整季删除 + 历史记录清理，并新增 `silent` 参数避免重复 toast。

### Fixed（修复）

- **主页标签页选中状态刷新后丢失**：`state.activeDashTab` 从未从 localStorage 恢复，「记住上次选中的标签」实际不生效（刷新后总是回到「继续学习」）。
  - 涉及文件：`public/app.js`
  - 技术细节：`init()` 中在 `loadDashboard()` 之前补 `state.activeDashTab = store.get('activeDashTab') || 'continue'`。

- **学习 UP主 卡片排版错误（竖排）**：卡片标记同时带有通用 `.card` 类，其 `flex-direction: column` 覆盖了 `.up-card` 的横排意图，导致头像居中在上、文字堆叠在下。
  - 涉及文件：`public/styles.css`
  - 技术细节：`.up-card` 显式补 `flex-direction: row`。

- **自定义标签页头部排版错乱**：头部用的是 `.dash-head`，但样式表里只有 `.section-head`，于是 `display` 落到默认的 `block`——标签页名和右侧计数被挤成上下两行，且搜索框底部与该行**零间距**，看起来又挤又不对齐。
  - 涉及文件：`public/app.js`、`public/styles.css`
  - 技术细节：两处 `.dash-head` 改用已有的 `.section-head`（flex + 居中 + space-between）；`.dash-search-wrap` 补 `margin-bottom: 18px`；计数改为紧跟标题的胶囊（`.tab-head` + `.tab-count`），不再被推到页面最右侧。

- **双击标签改名不生效**：第一次点击会 `renderDashboard()` 重建整个标签栏，第二次点击落在新节点上，`dblclick` 事件因此丢失。
  - 涉及文件：`public/app.js`
  - 技术细节：标签点击处理里，若点的已是当前标签则跳过重渲染（保住 DOM 节点）；同时用 `click` 的 `e.detail >= 2` 兜住第二次点击并转入改名，`.dash-tab-more`（⋯）上的双击不触发改名。

### Changed（变更）

- **主页两个栏位改名**：「添加的视频」→「视频库」，「学习收藏夹」→「收藏夹库」。同名的二级浏览页标题、内容选择器分区名、空状态提示、引导文案与各处提示语一并同步（`内容源` 弹窗内的「我的视频」保持不变，那是内容源自己的叫法）。
  - 涉及文件：`public/app.js`、`public/storage.js`、`public/index.html`、`README.md`

- **UP主 功能确定只做最小版本，完整规划作废**：本版本对 UP主 只做「本地书签」——输入 UID 添加、卡片展示头像/名称/简介/粉丝数/星级、点击卡片跳转 B站个人主页。原规划中的「搜索 UP主」「已关注列表」「站内 UP主 主页（投稿 / 合集 / 列表）」因功能过于复杂，已主动放弃，对应规划文档 `docs/feature-add-up.md` 一并删除。
  - 涉及文件：`docs/feature-add-up.md`（删除）、`CHANGELOG.md`
  - 技术细节：
    - 不新增以下代理路由：`/x/web-interface/wbi/search/type`、`/x/relation/followings`、`/x/space/upstat`、`/x/space/wbi/arc/search`、`/x/space/navnum`、`/x/polymer/web-space/seasons_series_list`、`/x/polymer/web-space/seasons_archives_list`、`/x/series/archives`；
    - 不新增以下前端 API 与视图：`searchUser` / `myFollowing` / `userUpstat` / `userVideos` / `spaceNavnum` / `seasonsSeriesList` / `seasonArchives` / `seriesArchives`、`upSpaceView`；
    - 实际只保留 `/x/web-interface/card`（`api.userCard`）一个新增接口。

## [1.0.2] - 2026-09-07

### Added（新增）

- **选集悬浮完整标题**：播放列表里长集名被省略号截断时，悬浮选集行会在其右侧显示完整集名（不遮挡播放画面；右侧空间不足时自动回落到左侧）。
  - 涉及文件：`public/app.js`、`public/styles.css`
  - 技术细节：
    - `renderEpisodeList` 的选集行增加 `data-title="完整集名"`；
    - 新增 `bindEpisodeTooltip()`（`mouseover`/`mouseout` 事件委托 + 面板 `scroll`、窗口 `resize` 时收起）；
    - 提示标签是挂在 `document.body` 的独立元素（portal 方式），避免被选集面板 `overflow-y: auto` 裁剪；
    - 定位逻辑 `showEpisodeTooltip()`：优先行右侧（`rect.right + 10`），放不下再放左侧，垂直居中并钳制在视口内；
    - 样式 `.bilinest-ep-tooltip`：深色圆角气泡、`pointer-events: none`、`max-width: min(340px, 60vw)`。

- **DASH 自适应码率播放**：B站视频从 durl（单一 mp4 地址）切换为 DASH 协议，dash.js 根据网络带宽自动切换码率。
  - 涉及文件：`server.mjs`、`public/player.js`、`public/index.html`、`public/vendor/dash.all.min.js`、`public/vendor/artplayer-plugin-dash-control.min.js`
  - 技术细节：
    - 服务端新增 `/api/dash.mpd`：用 WBI 签名请求 `/x/player/wbi/playurl`（fnval=4048），将 B 站非标准 DASH JSON 转换为标准 MPD；
    - MPD 仅保留 H.264（avc1）+ AAC（mp4a）编码，过滤 HEVC/AV1 避免 Chrome 硬解失败；
    - 视频/音频流通过 `/api/video` 本地代理转发（带正确 Referer），MPD BaseURL 为相对路径；
    - dash.js 通过 `httpHeaders` 透传用户 Cookie，确保高清晰度不被风控拦截；
    - 前端 `customType.dash`：ArtPlayer v5 以 `fn(videoEl, url, art)` 形式调用，切集时先 `art.dash.reset()` 释放旧实例。

- **清晰度下拉选择**：新增 `artplayer-plugin-dash-control` 插件，由 dash.js 码率列表自动生成清晰度下拉菜单。
  - 涉及文件：`public/player.js`、`public/vendor/artplayer-plugin-dash-control.min.js`

- **字幕改用 ArtPlayer 原生 VTT 组件**：移除自绘字幕层，B站 CC 字幕转为 WebVTT 格式（Blob URL），通过 `art.subtitle.switch()` 加载。
  - 涉及文件：`public/player.js`
  - 技术细节：
    - 新增 `subtitleBodyToVtt()` 将 `{from,to,content}[]` 转为 WebVTT 文本；
    - 用 `URL.createObjectURL` 生成 Blob URL，切集/重置时自动 `revokeObjectURL` 防止内存泄漏；
    - 字幕位置/字号设置仍可通过控制条微调，持久化到 localStorage。

### Fixed（修复）

- **CSP `worker-src` 缺失**：添加 `worker-src 'self' blob:`，解决 dash.js WebWorker 加载被 Content Security Policy 拦截。
  - 涉及文件：`public/index.html`

- **全屏弹幕加速**：全屏切换时弹幕速度异常变快。
  - 涉及文件：`public/player.js`
  - 技术细节：覆盖 `dp.resize`，在插件重置 transition 前按宽度比例修正 `$restTime`；新增 `lastDanmakuWidth` 状态追踪容器宽度。

- **弹幕重复/残留**：切集后弹幕堆积不消失。
  - 涉及文件：`public/player.js`
  - 技术细节：`p.load()` 改为无参调用（重置队列后重新加载），避免追加模式导致弹幕堆积。

- **选集面板执行顺序**：进入播放页时当前集未自动滚动到可见位置。
  - 涉及文件：`public/app.js`
  - 技术细节：面板先显示 → `sizeEpisodePanel()` → 再渲染列表 → 最后滚动到当前集，修复 `offsetTop` 为 0 的布局问题；`scrollEpisodeToActive` 增加 `Math.abs` 阈值判断（差值超过一行才滚动），避免切集时无意义跳转。

- **弹幕 protobuf 解码崩溃**：异常弹幕包导致整包解析失败。
  - 涉及文件：`server.mjs`
  - 技术细节：`decodeDmSeg` 增加单条 try/catch + wireType 校验，`vInt`/`vStr` 按 wireType 取值，异常包跳过不拖垮整包。

- **选集面板溢出**：剧集数较多时选集面板撑满屏幕。
  - 涉及文件：`public/styles.css`
  - 技术细节：`.episode-panel` 添加 `max-height: calc(100vh - var(--topbar-h) - 40px)`。

- **dash.js 实例泄漏**：切换视频时旧 dash.js 实例未释放。
  - 涉及文件：`public/player.js`
  - 技术细节：`reset()` / `loadBili()` 中先 `art.dash.reset()` 释放旧实例，再创建新实例。

- **视频加载错误诊断不足**：本地文件播放失败时提示信息过于笼统。
  - 涉及文件：`public/player.js`
  - 技术细节：`handleLoadError` 新增 `console.error` 输出 error.code + currentSrc；本地文件失败提示包含具体错误码文本（请求中止/网络异常/解码失败/地址不支持）。

### Changed（变更）

- **移除旧版 durl 播放重试/换源逻辑**：清晰度切换与重试由 dash.js 内部完成。
  - 涉及文件：`public/player.js`
  - 技术细节：移除 `MAX_URL_ATTEMPTS`、`MAX_FRESH_TRIES`、`MAX_QUALITY_TRIES`、`switchTo`、`reFetchPlayurl`、`fetchPlayurl`、`buildQualities`、`selectQuality`、`toProxiedUrl`。

- **移除自绘控件**：弹幕开关、字幕位置滑块、字号下拉改由插件/原生 API 处理。
  - 涉及文件：`public/player.js`
  - 技术细节：移除自绘弹幕开关控件（保留插件内置 `display` 控制）、自绘字幕位置滑块/字号下拉（改用原生 subtitle API）；`showBiliControls` 控件列表精简为 `['danmaku', 'subtitle']`。

- `launcher.vbs` 注释翻译为英文。

- 弹幕插件配置新增 `emitter: false`，隐藏"发弹幕"输入框（只读观看模式）。

---

## [v1.0.1] - 2026-08-28

### Added（新增）

- **弹幕完整度大幅提升**：弃用只返回“实时弹幕池”的旧 XML 接口，改用官方网页端分段弹幕接口（每 6 分钟一包、每包最多 6000 条），逐段拉取合并、按时间排序渲染；接口失败自动回退旧 XML。
  - 涉及文件：`server.mjs`、`public/player.js`、`public/api.js`、`README.md`
  - 技术细节：
    - 服务端新增 `/api/danmaku/segments`：优先请求 WBI 签名版 `x/v2/dm/wbi/web/seg.so`，失败回退无签名 `x/v2/dm/web/seg.so`；
    - 零依赖手写 protobuf 解码（`readVarint` / `readBytes` / `decodeDanmakuElem` / `decodeDmSeg`），兼容新旧两种字段结构（content 在 6 号或 7 号字段）；
    - `DmSegMobileReply` 的 1 号（elems）与 2 号（dmdm 补充弹幕）字段都解析合并；
    - B 站 CDN 对“无更多弹幕”返回 HTTP 304，视为空包正常结束（之前会误判为失败）；
    - 前端 `fetchDanmakuSegments`：从第 1 段顺序拉取，`elems.length < 6000` 即停止，上限 250 段（≈25 小时视频），段间 120ms 限速；第一段失败才回退 XML，后续段失败保留已拉数据；
    - 全局频率限制 `RATE_MAX` 由 40 提到 120 次/10s（本地保护，B 站仍有自身风控）。

- **服务端弹幕分段代理**：见上条（`/api/danmaku/segments` 即该项承载）。

- **端口占用自动顺延**：默认端口 4173 被其它程序占用时自动顺延到 4174、4175 …（最多 50 个），启动脚本自动打开实际端口。
  - 涉及文件：`server.mjs`、`launcher.vbs`、`start.sh`、`public/api.js`、`.gitignore`、`README.md`
  - 技术细节：
    - `server.mjs` 启动改为 `startServer(port)` 递归重试（`EADDRINUSE`/`EACCES` 时顺延，`PORT_TRIES = 50`）；
    - 成功监听后把实际端口写入 `bilinest.port`（纯数字文本），`/api/shutdown` 时删除；日志打印 `server started at http://…（4173 被占用，已自动顺延）`；
    - 监听成功回调用 `server.on('listening')` 只挂一次（`server.listen(port, cb)` 的 cb 在失败重试时会累积，导致日志重复）；
    - OAuth 回调地址 `oauth.redirectUri` 在端口确定后填充（未显式配置时跟随实际端口）；
    - `launcher.vbs` / `start.sh`：启动前删除旧端口文件，轮询等待后读取实际端口；健康检查校验响应体含 `bilinest`（防止 4173 被别的程序占用时误开别人的页面）；
    - 前端 `api.js init()` 从默认端口扫描 4173–4183 顺延区间，并校验 `info.app === 'bilinest'`；
    - 环境变量由 `BILIPURE_*` 改为 `BILINEST_*`（见改名条目）。

### Fixed（修复）

- 播放时弹幕不显示（需手动关闭再打开弹幕才出现）。
  - 涉及文件：`public/player.js`
  - 技术细节：ArtPlayer 的 `playing` getter 依赖 `currentTime > 0 && readyState > 2`，视频刚开始播放时误判为 false，导致弹幕动画循环从未启动；改用播放器自维护的 `state.playing`（由 `video:play/pause/ended` 事件置位），`renderLoop` / `startRender` 不再依赖 `art.playing`。

- 暂停后弹幕消失：改为暂停时冻结保留画面，便于暂停阅读；播放后继续滚动。
  - 涉及文件：`public/player.js`
  - 技术细节：`video:pause` 由 `stopRender()` 改为 `freezeRender()`（只取消 RAF、不清画布）；新增 `drawFrame()` 供动画循环与暂停静态帧共用；暂停中拖动进度（`video:seeked`）会重画当前时间点的静态弹幕。

- 暂停中拖动进度条弹幕错位：不再残留旧画面（见上条 `drawFrame` 复用）。

- B 站 CDN 对“该分段没有更多弹幕”返回 304 被误判为失败：现视为正常结束（见弹幕分段条目）。

- 逆向弹幕（mode 6）方向错误：改为从左向右正确渲染。
  - 涉及文件：`public/player.js`
  - 技术细节：`drawFrame` 增加 `d.mode === 6` 分支，`x = (t - d.start) * d.speed - d.width`。

- 端口顺延时启动日志重复输出（见端口顺延条目，`server.on('listening')` 只挂一次）。

- `launcher.vbs` 报 `800A0408 无效字符`。
  - 涉及文件：`launcher.vbs`
  - 技术细节：上一版误加 UTF-8 BOM，Windows 脚本宿主不认；已移除 BOM（该文件中文仅在注释中）。**注意：`create-shortcut.ps1` / `make-icon.ps1` 必须保留 UTF-8 BOM**（PowerShell 5.1 按 ANSI 读无 BOM 的 .ps1 会导致中文乱码）。

- 桌面快捷方式中文描述乱码（见上条 BOM 说明；快捷方式需重新运行 `create-shortcut.ps1` 生成）。

### Changed（变更）

- **项目改名 BiliPure → BiliNest**：程序内名称全面替换。
  - 涉及文件：`package.json`、`server.mjs`、`public/*.js`、`public/index.html`、`public/oauth_done.html`、`public/styles.css`、`launcher.vbs`、`start.sh`、`create-shortcut.ps1`、`make-icon.ps1`、`.env.example`、`README.md`、`LICENSE`、`.gitignore`
  - 技术细节（改名时同步替换的标识符）：
    - 包名 `bilipure` → `bilinest`；页面标题 / 品牌名 / 文案 → BiliNest；
    - 全局对象 `BiliPureStore/API/Local/Player` → `BiliNest*`；
    - 自定义事件 `bilipure-pause/ended/timeupdate/resumed` → `bilinest-*`；OAuth 弹窗 `bilinest-oauth`；
    - 请求头 `X-Bilipure-Sid` → `X-Bilinest-Sid`（服务端 CORS 白名单与读取、前端发送同步）；
    - 健康检查 `app: 'bilipure'` → `'bilinest'`（`api.js` 与 `launcher.vbs` 校验同步）；
    - 日志/端口文件 `bilipure.log` / `bilipure.port` → `bilinest.log` / `bilinest.port`；
    - 环境变量 `BILIPURE_*` → `BILINEST_*`；
    - CSS 类 `.bilipure-ctl` → `.bilinest-ctl`；ArtPlayer 容器 `id: 'bilipure'` → `'bilinest'`。
  - 保留未改：README 中的 GitHub 仓库链接与目录树根名（仓库层面由发布者处理）、本地文件夹名。

- **数据无损迁移**：改名不丢用户数据。
  - 涉及文件：`public/storage.js`、`public/localfiles.js`
  - 技术细节：
    - localStorage 新键 `bilinest.state.v1`，`load()` 检测旧键 `bilipure.state.v1` 后一次性迁移并删除旧键（登录态 / 收藏夹 / 观看记录 / 星级不丢）；
    - IndexedDB 新库 `bilinest-files`，`migrateLegacyDb()` 把旧库 `bilipure-files` 的本地视频文件句柄复制到新库后删除旧库；
    - `clearAll()` 同时清理新旧键。

- 桌面快捷方式由 `BiliPure.lnk` 更新为 `BiliNest.lnk`（重新运行 `create-shortcut.ps1`，旧快捷方式已删除）。

### Other（其他）

- `README.md`：弹幕实现说明、端口占用自动顺延说明、OAuth 回调注意事项、CHANGELOG 入口。
- `.gitignore`：加入 `bilinest.port`。
- 网络 / 代理排查（用户侧配置，非本项目代码变更）：诊断确认“开启代理后视频无法播放”的根因是 Clash 处于全局模式导致分流规则不生效；已为用户 Clash Verge Rev 当前订阅的规则文件（`rrR32aypmZRc.yaml`）添加 B 站系域名直连规则（bilibili.com / bilivideo.com / bilivideo.cn / hdslb.com / biliimg.com / biliapi.net / mountaintoys.cn → DIRECT），原文件已备份为 `.bak`。
