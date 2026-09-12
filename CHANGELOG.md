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

## [Unreleased]

### Fixed（修复）

- **卡片上的「添加于」显示成"5 万多年"**：`fmtDate()` 一直按「秒」解释时间戳，但时间戳其实有两种来源——B 站接口给的 `fav_time` 是**秒**，本地添加视频存的 `addedAt` 是 `Date.now()`（**毫秒**）。于是自己添加/收藏的视频，卡片上会显示成「添加于 58667年6月29日」。
  - 涉及文件：`public/app.js`
  - 技术细节：`fmtDate()` 里补一句毫秒换算（`if (n > 1e12) n = Math.round(n / 1000)`）；**不改动已存数据**，也不影响排序（排序比较的是原始值，同单位之间大小关系一致）。

### Changed（变更）

- **README 顶部加主页截图**：`docs/img/dashboard.png`（1600×880），并给仓库主页填上了 Homepage（指向 Releases 页）。截图为**演示数据**——标题是合成的、封面是程序生成的抽象图，不含任何人的真实学习列表。
  - 涉及文件：`README.md`、`docs/img/dashboard.png`
  - 技术细节：截图由无头 Edge 在临时实例（4176 端口 + 临时数据目录 + 全新浏览器配置）上以 2× 缩放拍摄后降采样得到；顺带用这张图验证了上面的日期修复。

## [1.2.1] - 2026-09-12

### Changed（变更）

- **合规表述如实化 + 补齐第三方许可**：把 README、首次启动引导、设置 →「关于」里与实现不符的措辞改成如实描述。纯文案与文档改动，不动任何功能逻辑。
  - 涉及文件：`README.md`、`public/app.js`、`public/vendor/DASH_LICENSE`、`installer/bilinest.iss`、`package.json`
  - 技术细节：
    - 原文写"也不提供任何破解、绕过付费或**反爬**能力"，但代码里实现了 WBI 签名（`wbiSignQuery`）与 CDN 所需的 Referer 转发——声明与事实不符，反而可能被用来证明主观故意。现改为如实说明：复用 B 站网页端同款**只读**接口与网页端公开使用的签名参数，这是"在本机播放自己账号有权观看的内容"所必需；同时明确列出**不做**的事（不破解付费/会员、不绕过账号权限、不下载、不批量抓取、不去水印、不绕地区限制）；
    - README 顶部新增**非官方声明**（中英文各一），明确与哔哩哔哩无隶属、合作或授权关系，也不使用其商标与品牌标识；
    - 新增 FAQ「这样做会违反 B 站用户协议吗？」，如实回答第三方客户端通常不符合平台协议，并写明项目边界与责任归属；
    - 第三方许可：新增 `public/vendor/DASH_LICENSE`（dash.js 的 BSD-3-Clause 全文，取自上游 `LICENSE.md`，措辞未改动）；README 许可表补上此前**漏列**的 `artplayer-plugin-danmuku`，并把 dash.js 的指向从"文件头"（实测该文件头部并没有许可证横幅）改为 `vendor/DASH_LICENSE`；README 同时注明安装包用的 Inno Setup 中文语言文件来源；
    - 凭据提示：README 与设置 →「数据」都注明 `state-backup.json` 里是**明文** SESSDATA，不要分享 / 同步 / 上传；「关于」写明本地服务只监听 `127.0.0.1`。

## [1.2.0] - 2026-09-12

### Added（新增）

- **Windows 安装包**：新增 `installer\`，用 Inno Setup 6 编译出 `dist\BiliNest-<版本>-Setup.exe`（约 2.3MB）。向导为简体中文，默认装到 `%LOCALAPPDATA%\Programs\BiliNest`（**不需要管理员权限**，安装位置可改），自动创建桌面与开始菜单快捷方式、在「应用和功能」登记卸载项；卸载时先停掉正在跑的本地服务，再询问是否连用户数据一起删（默认保留）。
  - 涉及文件：`installer\bilinest.iss`、`installer\build.ps1`、`installer\languages\ChineseSimplified.isl`、`.gitignore`、`README.md`
  - 技术细节：
    - Node.js **不自带**（不为一个运行时白胖 87MB）：按「PATH → `%ProgramW6432%\nodejs` → `%ProgramFiles%\nodejs` → `%ProgramFiles(x86)%\nodejs` → `%LOCALAPPDATA%\Programs\nodejs`」逐个探测；缺失或低于 18 时出现「运行环境检查」页，三选一：winget 自动安装 / 打开 nodejs.org / 先跳过。探测结果会写进安装日志（`/LOG=` 可查），Ready 页也会显示最终状态；
    - **踩坑留档（第一版误报"没装 Node"的根因）**：探测最初写成 `Exec('{cmd}', '/C "node" -v > "out.txt"')`——cmd 在 `/C` 之后同时遇到引号包裹的路径和 `>` 重定向时会把最外层引号剥掉，于是 `C:\Program Files\nodejs\node.exe` 这类带空格的路径全部执行失败。改成先写出一个临时 `.bat` 再执行，彻底绕开引号规则；
    - 另外两个 Inno 的坑：`[Code]` 里以 `[` 开头的续行会被当成新段标签（`Format(..., [` 必须写在同一行）；Pascal Script 不允许前向引用，函数必须先定义后使用；
    - 编译需要 Inno Setup 6（`winget install JRSoftware.InnoSetup`，约 5MB）；简体中文语言包 Inno 不自带，取自官方源码仓库 `Files/Languages/Unofficial/ChineseSimplified.isl`，放在 `installer\languages\`；
    - `build.ps1` 会校验 `bilinest.iss` 的 `AppVersion` 与 `package.json` 的 `version` 一致，避免发出对不上号的包；
    - 实测：安装后 26 个文件、桌面/开始菜单快捷方式与卸载项齐全，装出来的文件与仓库**逐字节一致**（SHA256 比对）；`/VERYSILENT` 安装与卸载都能跑通，卸载后目录、快捷方式、注册表项全部清空、用户数据按默认保留。

- **没装 Node.js 时给出明确指引**：`launcher.vbs` 启动服务前先确认 Node 可用，找不到就打开 `public\setup-help.html`（中文说明页：winget 命令、官网下载链接、PATH 注意事项），而不是像以前那样静默失败、让用户对着一片打不开的页面发愣。
  - 涉及文件：`launcher.vbs`、`public\setup-help.html`
  - 技术细节：`ResolveNode()` 先试 PATH 上的 `node`，再依次试 `%ProgramFiles%\nodejs`、`%ProgramFiles(x86)%\nodejs`、`%LOCALAPPDATA%\Programs\nodejs`，命中后返回可执行命令（带空格的路径会加引号）；中文文案放在 HTML 里，`launcher.vbs` 保持**纯 ASCII + 无 BOM**（WSH 只认 UTF-16 的 BOM，UTF-8 BOM 会报 800A0408）。

- **状态备份 / 自动恢复**：客户端状态会防抖上传到本地服务，存成 `%APPDATA%\BiliNest\state-backup.json`；本地没有真实数据时（清过浏览器数据、换了浏览器、换过端口）自动恢复并刷新一次。定位是"清一次浏览器数据就全没了"的防丢兜底。
  - 涉及文件：`server.mjs`、`public/storage.js`、`public/app.js`
  - 技术细节：
    - `POST /api/state/backup` 写入（先写 `.tmp` 再改名，原子替换）、`GET` 读回、`POST {"clear":true}` 删除；请求体限长 8MB；只接受 `state.v === 1` 的对象，其余返回 400；
    - **只允许同源访问**：校验 Host 必须是 `127.0.0.1` / `localhost`，且请求若带 `Origin` 必须与 Host 一致，否则 403。备份里含 SESSDATA，不能像其它只读接口那样开放跨域，否则用户访问的任意网页都能把 Cookie 读走；
    - 客户端 `save()` 之后防抖 1.5s 上传一次（连续改动只传一次）；`store.restoreIfNeeded()` 在"本地无状态 + 服务端有备份"时写入 localStorage 并让应用 `location.reload()` 一次；应用启动时另有一次 `backupNow()`，保证在原环境打开一次就把备份建好；
    - 新增 `hasRealData()` 守卫：登录态 / 视频库 / 收藏夹库 / 学习 UP主 / 自定义标签页 / 观看记录 任一非空才算"有数据"，**空状态不上传、也不当作可恢复的备份**（否则空壳状态会把好备份写脏）；
    - 「清除全部本地数据」会同时删除服务端备份（否则刷新就被恢复回来）；设置 →「数据」另有「从备份恢复」按钮可手动触发；
    - 服务端数据目录：Windows `%APPDATA%\BiliNest\`，其他平台 `~/.config/BiliNest/`，可用环境变量 `BILINEST_DATA_DIR` 覆盖。**刻意不放安装目录**：装到 Program Files 时普通用户没有写权限，卸载也会被一并删掉；
    - 除只读接口外，这是本服务唯一的写接口（`POST_PATHS` 白名单，其余非 GET/HEAD 仍返回 405）；
    - **不在备份范围内**：本地视频的文件句柄存在 IndexedDB 里，无法序列化成 JSON，换环境后需要重新添加本地文件。

- **备份升级为"跨环境的权威副本"：两边都有数据时以较新的一份为准**。以前只有"本地为空"才会恢复，于是换浏览器时容易各存一份、并且长时间没用过的那份可能反过来把较新的备份覆盖掉；现在会按时间戳自动收敛到较新的那份。
  - 涉及文件：`public/storage.js`、`server.mjs`、`public/app.js`
  - 技术细节：
    - 状态里新增 `updatedAt`（毫秒），由 `save()` 在每次真实改动时写入；旧数据没有该字段时按 `0` 处理；
    - 启动时 `restoreIfNeeded()` 的判定改为：本地没有真实数据 → 直接取备份；本地也有数据 → 只在**备份的 `updatedAt` 更大**时覆盖本地，否则以本地为准并照常上传。**刻意不用服务端的 `savedAt` 比较**——它总比改动晚一点点，会让每次启动都误判成"备份更新"而反复恢复刷新；
    - 上传侧加了一道保险：`POST /api/state/backup` 在两边都带时间戳、且传入的更旧时，保留现有备份并返回 `{ kept: 'newer' }`，防止旧快照覆盖新数据；任一侧时间戳缺失（旧版本数据）一律放行，保持宽容；
    - 「从备份恢复」按钮仍是**强制**覆盖（不比较时间戳），用于数据被改坏时手动回滚。

### Changed（变更）

- **设置弹窗改为「左侧栏位 + 右侧内容」**：原来一长条纵向堆叠的设置项拆成四个分类（登录与授权 / 外观 / 数据 / 关于），左栏切换、右栏只显示当前分类，并记住上次打开的是哪一栏。
  - 涉及文件：`public/app.js`、`public/styles.css`、`public/storage.js`
  - 技术细节：
    - 所有原有控件 id 保持不变（`btnQrLogin` / `btnSaveCookie` / `btnClearAuth` / `themeSelect` / `btnClearData` / `btnShutdown` / `btnGuide` 等），`bindSettingsEvents()` 除新增左栏绑定外无需改动，隐藏面板里的控件也照常可绑定；
    - `.modal-body.settings-body` 用 flex 分成左右两栏，右栏独立滚动；`openModal()` 新增可选 `cls` 参数，设置弹窗宽 780px（`.modal-settings`）；
    - 当前栏位存进 localStorage 的 `settingsTab`（默认 `login`，非法值回落 `login`）。

### Other（其他）

- **路线决定：放弃"独立窗口（`--app`）/ 桌面外壳"，回到双击快捷方式用默认浏览器打开标签页**。`launcher.vbs` 回退为只做「起服务 → 打开 `http://127.0.0.1:<实际端口>`」，随之移除 `/api/prefs`（窗口模式偏好）、设置里的「启动方式」选项与 Edge / Chrome 探测；WebView2 外壳（`shell/`）也不再作为可选入口。
  - 涉及文件：`launcher.vbs`、`create-shortcut.ps1`、`server.mjs`、`public/api.js`、`public/app.js`、`.gitignore`
  - 理由：这条路线换来的只有"窗口没有地址栏 / 尺寸可控"，代价却是每次都要多起一套浏览器进程树，而这两件事都不值（见下条实测）。

- **核查记录：启动 BiliNest 会带起多少浏览器进程**（留档，避免以后重复调研）。
  - 实测（2560x1440 / 125% / 本机 Edge，私有内存）：**同一个空白页**在一个全新浏览器配置目录下就是 **15 个进程**；换成 BiliNest 页面仍是 15 个（约 540MB）；加上 `--disable-component-extensions-with-background-pages --disable-extensions` 后降到 10 个（约 382MB）。
  - 构成：浏览器主进程 / GPU / Network Service / Storage Service / Extractor / CollectionsDataManager / Crashpad / 备用呈现器（约 9 个）+ Edge **自带的**约 6 个扩展宿主（Copilot / 收藏集 / 购物助手那一批，任何配置目录都会加载，与用户装没装扩展无关）。BiliNest 自己的增量只有一个页面渲染进程（约 35–75MB）和一个隐藏的 `node` 进程（约 40–60MB）。
  - 下限就是如此：Chromium 系宿主一个窗口就是 8–10 个进程、几百 MB；想明显更省只能换非浏览器宿主，而 WebView2 外壳试过，又因数据目录隔离与冷启动慢被否掉。
  - 顺带查清的两条浏览器机制（以后少走弯路）：① `--window-size` / `--window-position` **只在浏览器新起进程、且该配置目录没有记录过窗口位置时生效**——Edge 即使关掉所有窗口也会留后台进程，此时参数被直接丢弃，窗口沿用记忆值；② `--window-size` 收的是 CSS 像素，WMI 报的是物理像素，中间差一个显示缩放比（本机 125%），不换算会算出越界尺寸被系统丢弃。
  - 反例留档：往 Edge 的 `browser.app_window_placement` 里手写尺寸确实能改变窗口，但坐标系与缩放换算难以稳定复现（同一台机器先后出现过 ×1.25 与 ×1.8 两种结果），所以没有采用"改浏览器记录"这条路线。

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
