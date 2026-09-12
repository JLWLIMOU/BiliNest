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

- **主页标签页**：主页从纵向堆叠改为标签页切换模式（继续学习 / 添加的视频 / 学习收藏夹 / 学习 UP主），每次只显示一个栏位，标签状态持久化。
  - 涉及文件：`public/app.js`、`public/styles.css`、`public/storage.js`
  - 技术细节：
    - `renderDashboard()` 重写为标签栏 + 内容区两层结构；
    - `state.activeDashTab` 持久化到 localStorage，记住上次选中的标签；
    - 每个标签独占整个主页空间，默认显示更多卡片（继续学习 12 / 添加的视频 20 / 收藏夹 12 / UP主 12）；
    - 搜索框仅在「添加的视频」标签下显示。

### Changed（变更）

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
