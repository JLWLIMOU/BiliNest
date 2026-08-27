# BiliPure · 无干扰 B 站学习播放器

[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#)
[![Zero Deps](https://img.shields.io/badge/dependencies-zero-success)](#)

> 只看你指定的收藏夹 / 手动添加的视频 / 本地文件，**没有推荐、首页、评论、点赞、动态**。画质切换、弹幕、字幕全部在页面内完成，永不跳转 B 站官网。

---

## English

**BiliPure** is a minimal, distraction-free Bilibili study player. It shows only the content you choose — a specific favorite folder, manually added videos, or local files — with **no home feed, no recommendations, no comments, no like/coin/favorite buttons, no notifications**. Playback, danmaku and CC subtitles all happen inside the page; quality switching never leaves the app.

- **Local-first & private**: a tiny zero-dependency Node proxy on `127.0.0.1` forwards only whitelisted read-only Bilibili APIs. Your credentials stay in your own browser; requests never touch any third party.
- **Zero install of dependencies**: pure Node 18+ built-ins + static frontend, no `npm install` needed.
- **Cross-platform**: works on Windows, macOS and Linux.

### Quick start

```bash
# 1. (Windows) double-click launcher.vbs  ·  (macOS / Linux) run ./start.sh
#    or, on any OS:
npm start
# 2. open http://127.0.0.1:4173 in your browser
```

See the Chinese section below for login methods, usage and the full feature list.

---

## 功能一览

- **登录与授权**：设置里直接**扫码登录**（B 站 App 扫码确认即可，无需复制粘贴 Cookie）；手动 SESSDATA / Cookie 与 OAuth 作为备选。
- **收藏夹锁定**：从自己创建的收藏夹列表中选择一个作为唯一内容源（可随时更换）。
- **主页（仪表盘）**：分栏展示「继续学习 / 添加的视频 / 学习收藏夹」；收藏夹可在内容源中一键「加入学习」，收藏夹里的单个视频也可直接「+ 添加到学习列表」。
- **星级评分**：学习收藏夹和添加的视频都可打 1-5 星（5 星最重要、优先显示；未评分按添加顺序），并支持按「添加时间 / 发布时间 / 星级 / 播放量」排序。
- **观看记录与续播**：自动记录每个视频（含分 P / 合集选集）的观看进度，下次播放自动从上次位置继续；有记录时首页第一栏显示「继续学习」（大封面 + 进度条）。
- **列表（剧集）归类**：添加视频时自动识别「多 P / 合集」，标记为列表而非单视频；整季在「继续学习」中合并为**一张卡片**（指向最近看的集），点「添加的视频」也会自动继续最近看的集，手动点回某集则按该集自己的进度续播。
- **视频列表**：封面、标题、UP 主、时长；支持按“添加时间 / 发布时间”排序；分页加载。
- **搜索**：首页搜索框实时筛选「添加的视频」；内容源弹窗可同时搜索收藏夹与「我的视频」；收藏夹视图内可搜索当前收藏夹的视频。
- **栏位与二级页**：首页各栏位（继续学习 / 添加的视频 / 学习收藏夹）默认只显示前几个，超出后点「展开全部」进入二级浏览页，支持翻页、排序与搜索（不再横向滚动）。
- **纯净播放**：应用内置自研播放器——用应用内的登录态获取 B 站 MP4 直链，**画质切换完全在页面内完成，永不跳转 B 站官网**；弹幕显示（**无弹幕输入框，不能发送弹幕**）、CC 字幕、播放/暂停/进度/音量/全屏均支持。播放地址服务暂不可用时自动降级为官方嵌入播放器。
- **选集**：支持多 P 视频与 UP 主合集（视频系列）的选集切换。
- **单个视频**：粘贴视频链接 / BV 号 / av 号即可添加。
- **本地视频**：通过系统文件选择器添加本地视频文件（Chromium 内核浏览器可跨会话保留文件权限，其余浏览器本次会话可播放）。
- **极简界面**：Notion / Apple 风格，深色 / 浅色 / 跟随系统三档主题。
- **隐私友好**：凭据只保存在你自己的浏览器里，请求只发给本机代理，不经过任何第三方服务器。

---

## 快速开始

需要 **Node.js 18 或更高版本**（本仓库零第三方依赖，无需 `npm install`）。

> 没装 Node？到 [nodejs.org](https://nodejs.org) 下载 **LTS** 版，一路「下一步」安装完，在终端输入 `node -v` 能看到版本号（≥ 18）即成功。

### 启动（三选一）

1. **Windows 一键启动**：双击项目根目录的 `launcher.vbs`（自动启动本地服务并打开浏览器；无黑窗口）。
2. **macOS / Linux 一键启动**：在终端运行 `./start.sh`（首次需 `chmod +x start.sh`）。
3. **通用方式（任意系统）**：

   ```bash
   cd bilipure
   npm start
   ```

然后浏览器打开 **http://127.0.0.1:4173**。

### 桌面快捷方式（推荐日常使用，Windows）

```powershell
powershell -ExecutionPolicy Bypass -File create-shortcut.ps1
```

会在桌面生成 **BiliPure.lnk**，双击即可一键启动。停止服务：应用内「设置 → 停止本地服务」，或结束 `node` 进程。

### 直接用 `index.html` 打开（不推荐）

也可直接双击 `public/index.html` 预览界面。此时界面能展示，但收藏夹 / B 站接口会被浏览器跨域策略拦截；请按上面步骤启动本地代理后使用。

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
3. 回到 BiliPure，「设置」→ 粘贴 →「保存并验证」。

> Cookie 等同于账号凭证，**不要发给任何人**；建议仅个人设备勾选“保存到本地”。

### 方式三：OAuth（可选，需自行注册开放平台应用）

在 [哔哩哔哩开放平台](https://open.bilibili.com) 注册开发者并创建“网页应用”，获得 `client_id` / `client_secret`，配置环境变量后启动（Node 20.6+ 可用 `--env-file`）：

```bash
# 复制 .env.example 为 .env 并填写
node --env-file=.env server.mjs
```

需要配置 `BILIPURE_OAUTH_CLIENT_ID`、`BILIPURE_OAUTH_CLIENT_SECRET`、`BILIPURE_OAUTH_REDIRECT_URI=http://127.0.0.1:4173/api/oauth/callback`。重启后「设置」中出现「使用 B 站 OAuth 登录」。

---

## 使用说明

0. **首次启动引导**：第一次打开自动弹出「使用引导」（含 SESSDATA 获取步骤、内容源选择、常见问题）；之后可在「设置 → 查看使用引导」再看。
1. **主页**：默认进入仪表盘，从上到下为「继续学习 / 添加的视频 / 学习收藏夹」；点品牌名（BiliPure）返回主页。
2. **添加学习内容**：点右上角「内容源」→ 收藏夹列表点「加入学习」（可打星）；收藏夹内某视频点封面右上角「+」加入学习列表；也可粘贴单个视频链接或选择本地视频。
3. **观看**：点击视频卡片播放；多 P / 合集右侧有选集；进度自动记录，下次续播。
4. **排序**：「添加的视频」与收藏夹列表支持按「添加时间 / 发布时间 / 星级 / 播放量」排序。

---

## 技术架构

```
bilipure/
├── package.json          # 零依赖，Node 18+
├── server.mjs            # 本地代理 + 静态托管 + 可选 OAuth
├── .env.example          # 环境变量模板（含敏感项，勿提交真实值）
├── LICENSE               # MIT 许可证
├── start.sh              # macOS / Linux 一键启动脚本
├── public/
│   ├── index.html        # 页面骨架（含 CSP）
│   ├── styles.css        # 深/浅色主题与全部样式
│   ├── storage.js        # localStorage 状态管理
│   ├── api.js            # B 站 API 客户端（代理优先）
│   ├── localfiles.js     # 本地视频：File System Access API + IndexedDB
│   ├── player.js         # 自研播放器：MP4 直链 + 画质菜单 + 弹幕 + CC 字幕
│   ├── app.js            # 主逻辑：渲染、播放、设置、OAuth 回调
│   ├── oauth_done.html   # OAuth 完成页
│   └── vendor/           # ArtPlayer v5（MIT）、qrcode.js（MIT）
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

### 播放器说明（ArtPlayer 内核）

自研播放器通过本地代理请求官方 `x/player/wbi/playurl` 接口（带应用内登录态），拿到 progressive MP4 直链交给 **ArtPlayer v5**（MIT）播放：画质菜单来自 `accept_quality`，切换仅重新请求地址、不离开页面；弹幕用官方 `x/v1/dm/list.so` + Canvas 渲染（只显示、不能发送）；CC 字幕用 `x/player/v2`；播放地址失败自动降级官方嵌入播放器。B 站 CDN 防盗链由 `/api/video` 代理统一带正确 Referer 转发。

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

**Q：如何打包成桌面应用？**
本应用即“静态页面 + 本地服务”，可用任意壳包装，例如 Electron：

```bash
npm init -y && npm i -D electron
# main.js 中 BrowserWindow.loadURL('http://127.0.0.1:4173')，启动时拉起 node server.mjs
npx electron .
```

---

## 安全与合规声明

- 代码**不硬编码任何敏感信息**；Cookie / OAuth 密钥全部来自用户输入 / 环境变量；
- 凭据只存本机（localStorage / 内存 / 服务器内存），不发送任何第三方；
- 服务器仅转发白名单内只读接口并做频率限制；
- 请遵守 B 站用户协议与 API 规范，仅限个人学习。

## 免责声明

本项目不隶属于哔哩哔哩，也不提供任何破解、绕过付费或反爬能力。因使用本工具产生的任何账号风险由使用者自行承担。
