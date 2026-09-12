# BiliNest · 无干扰 B 站学习播放器

> B 站小窝：窝在里面安安静静看课，外面的推荐、广告、争吵都跟你无关。

[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#)
[![Zero Deps](https://img.shields.io/badge/dependencies-zero-success)](#)

> 📝 更新历史见 [CHANGELOG.md](./CHANGELOG.md)。

> 只看你指定的收藏夹 / 手动添加的视频 / 本地文件，**没有推荐、首页、评论、点赞、动态**。画质切换、弹幕、字幕全部在页面内完成，永不跳转 B 站官网。

> ⚠️ **非官方声明**：BiliNest 是第三方个人开源项目，**与哔哩哔哩（Bilibili）没有任何隶属、合作或授权关系**，也不使用其商标与品牌标识。仅供**个人学习自用**：请遵守 B 站用户协议，勿用于商业用途，勿再分发通过本工具获取的任何内容。

## 它解决什么痛点？

你大概遇到过这些情况：

- **想学习却总被带偏**：打开 B 站本来要听课，结果被首页推荐、动态、热门一路刷下去，半小时过去啥也没看。
- **收藏夹等于吃灰**：存了一堆“以后学”的视频，混在推荐流里找不到，也更不记得看到第几 P。
- **官方播放页太吵**：满屏评论、相关推荐、三连按钮，根本没法专注，想关还关不干净。
- **进度总丢**：多 P / 合集看到哪集、哪一分，下次打开全忘了，从头再来。
- **第三方工具不放心**：要么要把 Cookie 交给别人，要么只是换皮播放器——画质一高就跳回官网。

BiliNest 的思路很简单：**只把你指定的内容留下来，其它的全删掉**。没有推荐、没有评论、没有动态；登录态只存在你自己的浏览器里，播放地址走本机代理获取，画质切换在页面内完成，永不跳官网。

---

## English

**BiliNest** is a minimal, distraction-free Bilibili study player. It shows only the content you choose — a specific favorite folder, manually added videos, or local files — with **no home feed, no recommendations, no comments, no like/coin/favorite buttons, no notifications**. Playback, danmaku and CC subtitles all happen inside the page; quality switching never leaves the app.

- **Local-first & private**: a tiny zero-dependency Node proxy on `127.0.0.1` forwards only whitelisted read-only Bilibili APIs. Your credentials stay in your own browser; requests never touch any third party.
- **Zero install of dependencies**: pure Node 18+ built-ins + static frontend, no `npm install` needed.
- **Cross-platform**: works on Windows, macOS and Linux.
- **Unofficial**: a third-party hobby project — not affiliated with, endorsed by, or sponsored by Bilibili. For personal study use only; please respect Bilibili's terms of service.

### Why BiliNest?

Bilibili is great for studying, but its home feed, comments and recommendations are engineered to keep you scrolling. BiliNest strips all of that away: you pick exactly what to watch (a folder, a few videos, or local files), and the app remembers your progress across multi-part series — so you actually finish what you start.

### Quick start

```bash
# 1. (Windows) double-click launcher.vbs  ·  (macOS / Linux) run ./start.sh
#    or, on any OS:
npm start
# 2. open http://127.0.0.1:4173 in your browser
```

Windows users can also grab `BiliNest-x.y.z-Setup.exe` from Releases — it checks for Node.js and creates the shortcuts for you.

See the Chinese section below for login methods, usage and the full feature list.

---

## 功能一览

- **登录与授权**：设置里直接**扫码登录**（B 站 App 扫码确认即可，无需复制粘贴 Cookie）；手动 SESSDATA / Cookie 与 OAuth 作为备选。
- **收藏夹锁定**：从自己创建的收藏夹列表中选择一个作为唯一内容源（可随时更换）。
- **主页（仪表盘）**：标签页形式展示「继续学习 / 视频库 / 收藏夹库 / 学习 UP主」四个系统标签；收藏夹可在内容源中一键「加入学习」，收藏夹里的单个视频也可直接「+ 添加到学习列表」。
- **星级评分**：收藏夹库和视频库都可打 1-5 星（5 星最重要、优先显示；未评分按添加顺序），并支持按「添加时间 / 发布时间 / 星级 / 播放量」排序。
- **观看记录与续播**：自动记录每个视频（含分 P / 合集选集）的观看进度，下次播放自动从上次位置继续；有记录时首页第一栏显示「继续学习」（大封面 + 进度条）。
- **列表（剧集）归类**：添加视频时自动识别「多 P / 合集」，标记为列表而非单视频；整季在「继续学习」中合并为**一张卡片**（指向最近看的集），点「视频库」也会自动继续最近看的集，手动点回某集则按该集自己的进度续播。
- **视频列表**：封面、标题、UP 主、时长；支持按“添加时间 / 发布时间”排序；分页加载。
- **搜索**：首页搜索框实时筛选「视频库」；内容源弹窗可同时搜索收藏夹与「我的视频」；收藏夹视图内可搜索当前收藏夹的视频。
- **栏位与二级页**：各标签默认只显示前几个，超出后点「展开全部」进入二级浏览页，支持翻页、排序与搜索（不再横向滚动）。
- **纯净播放**：应用内置自研播放器——用应用内的登录态获取 B 站 DASH 自适应码率流，**画质切换由 dash.js 自动完成，永不跳转 B 站官网**；弹幕显示（**无弹幕输入框，不能发送弹幕**）、CC 字幕、播放/暂停/进度/音量/全屏均支持。播放地址服务暂不可用时自动降级为官方嵌入播放器。
- **选集**：支持多 P 视频与 UP 主合集（视频系列）的选集切换。
- **单个视频**：粘贴视频链接 / BV 号 / av 号即可添加。
- **本地视频**：通过系统文件选择器添加本地视频文件（Chromium 内核浏览器可跨会话保留文件权限，其余浏览器本次会话可播放）。
- **自定义标签页**：标签栏末尾的「＋」直接新建标签页（建完可内联改名；双击标签改名；按住标签拖动排序；标签过多时横向滚动，系统标签固定在左侧）。空标签页里的「＋ 添加内容」可从 **源收藏夹 / 视频库 / 收藏夹库 / 学习 UP主** 四处挑选（库侧条目带封面 / 头像），卡片右下角 ✕ 移除时可选是否连库内一并删除。标签页只存引用，**删标签页不会删内容**。
- **学习 UP主**：在「学习 UP主」标签输入 UID 即可收藏 UP主（头像 / 昵称 / 简介 / 粉丝数 / 星级），点卡片跳转其 B 站主页。
- **数据不丢**：状态存在浏览器本地，同时自动备份到 `%APPDATA%\BiliNest\state-backup.json`；换浏览器、换端口或清过浏览器数据后打开会自动取回，两边都有数据时以较新的一份为准。
- **极简界面**：Notion / Apple 风格，深色 / 浅色 / 跟随系统三档主题。
- **隐私友好**：凭据只保存在你自己的浏览器里，请求只发给本机代理，不经过任何第三方服务器。

---

## 快速开始（三步）

本程序是**纯本地**运行的，不需要部署到任何服务器；装好 Node 后启动即可。

### 第一步：安装 Node.js（只需一次）
1. 打开 https://nodejs.org ，点击绿色的 **LTS** 按钮下载安装包；
2. 双击安装包，一路点「下一步 / Next」直到完成（不用改任何选项）；
3. 验证：按 `Win+R` 输入 `cmd` 回车，执行 `node -v`，能看到 `v18.x` 或更高即成功。
   > macOS / Linux 用户：在终端执行同样命令；Mac 也可 `brew install node`。

### 第二步：获取本程序
- 方式 A（推荐）：到本仓库右侧 **Releases** 页面，下载 `Source code (zip)` 并解压；
- 方式 B：已装 git 则执行 `git clone https://github.com/JLWLIMOU/BiliNest.git`。
- 方式 C（Windows，最省事）：直接下载 Releases 里的 `BiliNest-x.y.z-Setup.exe` 安装包，详见下方「安装包」。

### 第三步：启动
- **Windows**：进入文件夹，**双击 `launcher.vbs`**（自动起服务并打开浏览器，无黑窗口）；
- **macOS / Linux**：终端进入文件夹，先 `chmod +x start.sh`，再 `./start.sh`；
- **通用**：在文件夹内打开终端，执行 `npm start`。

启动后浏览器会自动打开 **http://127.0.0.1:4173**；若没自动打开，手动访问该地址即可。

> **端口占用自动顺延**：若 4173 已被其它程序（另一个 Node 进程、Vite 预览、代理软件等）占用，
> 服务不会启动失败，而是自动顺延到 4174、4175 …（最多 50 个）并写入 `bilinest.port`；
> `launcher.vbs` / `start.sh` 会读取该文件自动打开**实际端口**。
> 用 `npm start` 手动启动时，日志会打印实际地址，例如
> `server started at http://127.0.0.1:4174（4173 被占用，已自动顺延）`。

### 打不开 / 快速排查
- 页面提示「未检测到本地代理服务」：说明服务未启动，请先双击 `launcher.vbs` / `./start.sh` / `npm start`，再刷新页面；
- 收藏夹为空：需在右上角「设置」里**扫码登录** B 站账号后，才能读取收藏夹；
- 更多见下方「常见问题（FAQ）」。

### 桌面快捷方式（推荐日常使用，Windows）

```powershell
powershell -ExecutionPolicy Bypass -File create-shortcut.ps1
```

会在桌面生成 **BiliNest.lnk**，双击即可一键启动。停止服务：应用内「设置 → 停止本地服务」，或结束 `node` 进程。

### 安装包（Windows，可选）

到 **Releases** 页面下载 `BiliNest-x.y.z-Setup.exe`，双击一路「下一步」即可。安装包会：

- 默认装到 `%LOCALAPPDATA%\Programs\BiliNest`（**不需要管理员权限**，安装位置可以在向导里改）；
- 自动创建桌面与开始菜单快捷方式，并在「应用和功能」里登记卸载项；
- **检测 Node.js**（不自带——不让安装包为运行时白白多出 87MB）：找到 18 或更高版本就直接装；没找到（或版本过低）会出现「运行环境检查」页，三选一：用 winget 自动安装 / 打开 nodejs.org 自己装 / 先跳过；
- 卸载时会先停掉正在跑的本地服务，再问一句是否连用户数据一起删（**默认保留**，重新安装后还能接着用）。

想自己从源码打包：

```powershell
winget install JRSoftware.InnoSetup        # 只需装一次，约 5MB
powershell -ExecutionPolicy Bypass -File installer\build.ps1
```

产物在 `dist\BiliNest-<版本>-Setup.exe`。`build.ps1` 会顺手校验 `installer\bilinest.iss` 的版本号与 `package.json` 是否一致，避免打出对不上号的包。

### 直接用 `index.html` 打开（不推荐）

也可直接双击 `public/index.html` 预览界面。此时界面能展示，但收藏夹 / B 站接口会被浏览器跨域策略拦截；请按上面步骤启动本地代理后使用。

---

## 更新方法

> **重要：你的个人数据（登录态、收藏夹、观看记录、星级）全部保存在浏览器中（localStorage / IndexedDB），不在项目文件夹内。更新代码文件不会丢失这些数据——但请按下面的方式操作，不要直接删除整个文件夹再重新下载。**

### 方式一：Git 拉取（推荐）

```bash
cd bilinest
git pull origin main
```

重启服务即可（双击 `launcher.vbs` / `./start.sh` / `npm start`）。无需 `npm install`，所有依赖已 vendor 化。

### 方式二：下载 Release ZIP

1. 到 [Releases](https://github.com/JLWLIMOU/BiliNest/releases) 下载最新 `Source code (zip)`；
2. **不要删除旧文件夹**，将 ZIP 解压到一个临时目录；
3. 把解压出来的文件**覆盖复制**到旧项目文件夹（替换同名文件，保留你自己的 `.env` 等个人配置）；
4. 重启服务。

### 注意事项

- **不要整个文件夹删除后重新下载**：虽然用户数据在浏览器中不会丢，但你可能自定义过 `.env`（OAuth 配置）等文件，删除就没了。
- **`.env` 不会被覆盖**：该文件在 `.gitignore` 中，不会被 git pull 或 ZIP 解压影响。
- **`bilinest.port` 是临时文件**：记录当前实际端口号，重启后会自动更新，无需关心。
- **桌面快捷方式不受影响**：更新后无需重新创建。

---

## 登录方式

### 方式一：扫码登录（推荐）

1. 点击右上角「设置」→「扫码登录（推荐）」；
2. 用**哔哩哔哩 App** 扫描页面上的二维码；
3. 在手机上点击「确认登录」，应用内提示成功后即可直接使用。

说明：二维码有效期内每 2.5 秒自动轮询；过期点「刷新二维码」；默认在本机保存登录状态（可取消勾选改为仅本次会话）。

### 方式二：SESSDATA / Cookie（手动）

1. 在浏览器登录 [bilibili.com](https://www.bilibili.com)；
2. 按 `F12` → `Application` → `Cookies` → `https://www.bilibili.com`，复制 `SESSDATA`（或整段 Cookie）；
3. 回到 BiliNest，「设置」→ 粘贴 →「保存并验证」。

> Cookie 等同于账号凭证，**不要发给任何人**；建议仅个人设备勾选“保存到本地”。

### 方式三：OAuth（可选，需自行注册开放平台应用）

在 [哔哩哔哩开放平台](https://open.bilibili.com) 注册开发者并创建“网页应用”，获得 `client_id` / `client_secret`，配置环境变量后启动（Node 20.6+ 可用 `--env-file`）：

```bash
# 复制 .env.example 为 .env 并填写
node --env-file=.env server.mjs
```

需要配置 `BILINEST_OAUTH_CLIENT_ID`、`BILINEST_OAUTH_CLIENT_SECRET`、`BILINEST_OAUTH_REDIRECT_URI=http://127.0.0.1:4173/api/oauth/callback`。重启后「设置」中出现「使用 B 站 OAuth 登录」。
注意：若 4173 被占用而端口顺延，**未显式配置**回调地址时会自动跟随实际端口；若显式配置了固定回调地址，则需与顺延后的端口保持一致，否则 OAuth 回调会失败。

---

## 使用说明

0. **首次启动引导**：第一次打开自动弹出「使用引导」（含 SESSDATA 获取步骤、内容源选择、常见问题）；之后可在「设置 → 查看使用引导」再看。
1. **主页**：默认进入仪表盘，标签页为「继续学习 / 视频库 / 收藏夹库 / 学习 UP主」；标签栏末尾的「＋」可新建自定义标签页（双击改名、拖动排序）；点品牌名（BiliNest）返回主页。
2. **添加学习内容**：点右上角「内容源」→ 收藏夹列表点「加入学习」（可打星）；收藏夹内某视频点封面右上角「+」加入学习列表；也可粘贴单个视频链接或选择本地视频。
3. **观看**：点击视频卡片播放；多 P / 合集右侧有选集；进度自动记录，下次续播。
4. **排序**：「视频库」与收藏夹列表支持按「添加时间 / 发布时间 / 星级 / 播放量」排序。

---

## 技术架构

```
bilinest/
├── package.json          # 零依赖，Node 18+
├── server.mjs            # 本地代理 + 静态托管 + 可选 OAuth
├── .env.example          # 环境变量模板（含敏感项，勿提交真实值）
├── LICENSE               # MIT 许可证
├── start.sh              # macOS / Linux 一键启动脚本
├── launcher.vbs          # Windows 一键启动（起服务 + 打开浏览器；缺 Node 时给安装指引）
├── create-shortcut.ps1   # Windows 桌面快捷方式
├── installer/            # Windows 安装包脚本（Inno Setup，产物在 dist/）
├── public/
│   ├── index.html        # 页面骨架（含 CSP）
│   ├── styles.css        # 深/浅色主题与全部样式
│   ├── storage.js        # localStorage 状态管理
│   ├── api.js            # B 站 API 客户端（代理优先）
│   ├── localfiles.js     # 本地视频：File System Access API + IndexedDB
│   ├── player.js         # 自研播放器：DASH + dash.js + 弹幕 + CC 字幕
│   ├── app.js            # 主逻辑：渲染、播放、设置、OAuth 回调
│   ├── setup-help.html   # 没装 Node.js 时的安装指引页
│   ├── oauth_done.html   # OAuth 完成页
│   └── vendor/           # ArtPlayer v5（MIT）、dash.js（BSD）、dash-control（MIT）、qrcode.js（MIT）
└── README.md
```

### 为什么需要本地代理？

浏览器直接请求 `api.bilibili.com` 会被 CORS 拦截。`server.mjs` 只在本机监听：

- 转发白名单内的少量只读接口，不会变成任意 URL 的开放代理；
- 内置频率限制（每 10 秒最多 40 次），避免对 B 站造成压力；
- 遇到风控（HTTP 412）时自动用 WBI 签名重试一次；
- OAuth 会话仅存服务器内存，重启即失效，不落盘。

### 用到的 B 站接口（全部只读）

| 接口 | 用途 |
| --- | --- |
| `x/v2/account/myinfo` | 校验登录、获取 mid / 用户名 |
| `x/v3/fav/folder/created/list(-all)` | 我创建的收藏夹列表 |
| `x/v3/fav/resource/list` | 收藏夹内容 |
| `x/web-interface/view` | 视频详情（分 P / 合集） |
| `x/web-interface/nav` | WBI 密钥来源（仅服务器内部） |

### 播放器说明（ArtPlayer + dash.js）

自研播放器通过本地代理请求官方 `x/player/wbi/playurl` 接口（带应用内登录态），获取 **DASH 自适应码率流**（fnval=4048）交给 **dash.js** 播放：dash.js 根据网络带宽自动切换码率，**ArtPlayer**（MIT）负责 UI 控件与弹幕渲染；清晰度菜单由 `artplayer-plugin-dash-control` 插件从 MPD 码率列表自动生成，切换仅重新加载 MPD、不离开页面；弹幕用官方网页端的分段 protobuf 接口 `x/v2/dm/wbi/web/seg.so`（每 6 分钟一包、每包最多 6000 条，完整度远高于旧 XML 的“实时弹幕池”），本地服务解码为 JSON 后交给 Canvas 渲染（只显示、不能发送），接口失败时自动回退旧 `x/v1/dm/list.so`；CC 字幕转为 WebVTT 格式通过 ArtPlayer 原生字幕模块加载；播放地址失败自动降级官方嵌入播放器。B 站 CDN 防盗链由 `/api/video` 代理统一带正确 Referer 转发。

---

## 常见问题（FAQ）

**Q：Mac / Linux 能用吗？**
能。本应用后端是纯 Node 内置模块、前端是标准网页，零原生依赖，三平台通用。macOS / Linux 请用 `./start.sh`（或 `npm start`）启动，再开浏览器访问 `http://127.0.0.1:4173`。仅 Windows 专属的 `launcher.vbs` / `create-shortcut.ps1` 在 Mac/Linux 不适用，但那是便利脚本，不影响核心功能。

**Q：提示“未检测到本地代理服务”？**
先运行 `npm start`（或双击 `launcher.vbs` / `./start.sh`），再访问 `http://127.0.0.1:4173`；或点页面「重试」。

**Q：收藏夹加载失败 / -403？**
检查 Cookie 是否过期（设置里重新保存并验证）；私密收藏夹必须用有权限的账号登录。

**Q：提示“请求被风控拦截（412）”或频繁失败？**
B 站对异常频率会风控。放慢节奏；服务端已限频，勿短时间反复刷新。

**Q：扫码登录一直失败？**
多为网络波动或该 IP 被风控（412）。稍后重试、点「刷新二维码」，或改用方式二手动粘贴 SESSDATA。

**Q：提示“已切换官方播放器”？**
自研播放器拿不到地址（多为网络/风控 412）会自动降级，稍后重试。

**Q：本地视频刷新后需重新授权？**
Chromium 内核浏览器自动恢复文件权限；被拒则删除重加。其它浏览器仅本次会话可播放。

**Q：数据存在哪里？换了浏览器或清了缓存会不会丢？**
平时存在浏览器本地（localStorage），同时会自动备份到 `%APPDATA%\BiliNest\state-backup.json`（macOS / Linux 为 `~/.config/BiliNest/state-backup.json`，可用环境变量 `BILINEST_DATA_DIR` 改位置）。换浏览器、换端口或清过浏览器数据后，打开时**自动取回**；两边都有数据时**以较新的一份为准**，不会用旧快照把新数据盖掉。设置 →「数据」里可手动「从备份恢复」，也可以一键清除全部本地数据。

⚠️ 这个备份文件里是**明文**的登录凭据（SESSDATA），请不要分享、同步到网盘或上传；共用电脑上建议用完在「设置 → 数据」里清除。

**Q：这样做会违反 B 站用户协议吗？**
如实说明：这类第三方客户端通常**不符合**平台的用户协议与 API 使用规范。本项目的立场是——只在本机、用你自己的账号、播放你自己有权观看的内容；不做下载、不做批量抓取、不绕过付费与会员权益、不把任何数据发给第三方。请自行判断是否使用，风险与后果由使用者承担。

**Q：提示没装 Node.js / 双击快捷方式后页面打不开？**
说明系统里找不到可用的 Node.js 18+。双击快捷方式时会自动打开一份图文安装指引（也可以直接看 `public/setup-help.html`）：按 `Win` 输入 `cmd` 后执行 `winget install OpenJS.NodeJS.LTS`，或者到 [nodejs.org](https://nodejs.org/zh-cn/download) 下载 LTS 版本安装，装好后重新双击快捷方式即可。安装时请保持勾选 **Add to PATH**。

**Q：如何打包成桌面应用？**
本应用即“静态页面 + 本地服务”，可用任意壳包装，例如 Electron：

```bash
npm init -y && npm i -D electron
# main.js 中 BrowserWindow.loadURL('http://127.0.0.1:4173')，启动时拉起 node server.mjs
npx electron .
```

---

## 开源依赖与许可（Third-party licenses）

本项目在 `public/vendor/` 中内置了以下开源组件，其许可证文本随文件一同分发（MIT 全文见 `vendor/ARTPLAYER_LICENSE`，BSD-3-Clause 全文见 `vendor/DASH_LICENSE`）：

| 组件 | 版本 | 作者 | 许可证 | 用途 |
| --- | --- | --- | --- | --- |
| [ArtPlayer](https://github.com/zhw2590582/ArtPlayer) | v5.4.0 | Harvey Zhao | MIT（见 `vendor/ARTPLAYER_LICENSE`） | 页内视频播放器内核 |
| [artplayer-plugin-danmuku](https://github.com/zhw2590582/ArtPlayer) | v5.3.0 | Harvey Zhao | MIT（版权声明见文件头，全文见 `vendor/ARTPLAYER_LICENSE`） | 弹幕渲染 |
| [dash.js](https://github.com/Dash-Industry-Forum/dash.js) | v4.5.2 | Dash Industry Forum | BSD-3-Clause（见 `vendor/DASH_LICENSE`） | DASH 自适应码率流播放引擎 |
| [artplayer-plugin-dash-control](https://github.com/zhw2590582/ArtPlayer) | v1.1.0 | Harvey Zhao | MIT（版权声明见文件头，全文见 `vendor/ARTPLAYER_LICENSE`） | ArtPlayer 清晰度下拉控件（配合 dash.js） |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | — | Kazuhiko Arase | MIT（见 `public/vendor/qrcode.js` 文件头） | 登录二维码渲染 |

本项目本身以 MIT 许可证发布（见仓库根目录 `LICENSE`）。

Windows 安装包用 Inno Setup 6 编译，其中文语言文件来自 Inno Setup 官方源码仓库的未收录翻译（`installer/languages/ChineseSimplified.isl`）。

## 安全与合规声明

- 代码**不硬编码任何敏感信息**；Cookie / OAuth 密钥全部来自用户输入 / 环境变量；
- 凭据只存本机（浏览器 localStorage / 内存 / `%APPDATA%\BiliNest`），不发送任何第三方；
- ⚠️ 备份文件 `%APPDATA%\BiliNest\state-backup.json` 与浏览器 localStorage 中**明文保存**登录凭据（SESSDATA）。请勿分享、同步或上传该目录；共用电脑上用完建议在「设置 → 数据」里清除；
- 本地服务只监听 `127.0.0.1`，不对局域网或公网开放；
- 服务器仅转发白名单内只读接口并做频率限制；
- 请遵守 B 站用户协议与 API 规范，仅限个人学习。

## 免责声明

本项目为个人开源项目，**与哔哩哔哩没有任何隶属、合作或授权关系**，也不使用其商标与品牌标识。

关于技术实现如实说明：本工具复用 B 站**网页端同款的只读接口**（其中包含网页端公开使用的 WBI 签名参数），并在本机转发视频流时按 CDN 要求携带 Referer —— 这些是让"在本机播放自己账号有权观看的内容"能够工作所必需的。本工具**不**破解付费 / 会员内容，**不**绕过账号权限，**不**提供下载、批量抓取、去水印或地区限制绕过能力，也不向任何第三方发送你的数据。

第三方客户端通常**不符合**平台的用户协议与 API 使用规范；请自行判断是否使用。因使用本工具产生的任何账号风险（包括但不限于风控、限流、封禁）由使用者自行承担。

## 关于本项目

> 本项目以 **vibe coding**（AI 辅助编程）方式完成：主体代码由 AI 协作生成，作者负责需求、评审与发布。仅供个人学习交流使用。
