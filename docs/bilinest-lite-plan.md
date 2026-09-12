# BiliNest Lite — 开发计划

> ## ⚠️ 本文件已废弃（Superseded）
>
> 本文描述的是**早期单页应用方案**（单个 index.html + dash.js、Go 从 server.mjs 手工翻译、状态存 JSON 文件、无插件系统）。
> 该方案已被 **插件式架构（前端 ES Module 大插件）** 取代，权威文档为：
> - `bilinest-lite/DESIGN.md` —— 第十二节（数据模型权威定义）、第十五节（插件架构、15.30 插件执行模型）
> - `bilinest-lite/ROADMAP.md` —— 分阶段开发计划（进度实时更新）
>
> 保留本文件仅作历史参考，**任何开发决策不得引用本文**。

## 概述

BiliNest Lite 是 BiliNest 的精简版，使用 Go + WebView2 构建单窗口桌面应用。
所有功能保留，UI 极简（终端感暗色主题），打包为单 exe + 前端文件。

## 技术栈

| 层 | 选择 | 说明 |
|----|------|------|
| 窗口框架 | **Wails v2** | Go + WebView2 原生窗口 |
| 前端 | 单个 `index.html` + `style.css` + `app.js` | 纯手写，无框架 |
| CSS | 纯手写（~300行） | 终端感暗色主题，等宽字体 |
| 视频 | HTML5 `<video>` + dash.js | DASH 自适应码率 |
| 弹幕 | Canvas 引擎（~150行） | 叠加在 video 上 |
| 字幕 | WebVTT `<track>` | 原生浏览器支持 |
| 后端 | Go（从 server.mjs 翻译） | 零外部依赖 |
| 通信 | Wails `Bind()` | JS ↔ Go 双向调用 |
| 状态 | JSON 文件（磁盘） | 替代 localStorage |

## 架构

```
┌─ BiliNest-Lite.exe (Go + Wails) ─────────────┐
│                                                │
│  ┌──────────────────────────────────────────┐ │
│  │  WebView2 原生窗口                        │ │
│  │                                          │ │
│  │  <video> + dash.js (DASH 自适应)         │ │
│  │  <canvas> 弹幕叠加层                     │ │
│  │  控制栏：播放/暂停 | 进度条 | 画质        │ │
│  │                                          │ │
│  │  页面路由（JS 切换 div）：               │ │
│  │  - loginView / homeView / searchView     │ │
│  │  - folderView / playerView / settingsView│ │
│  └──────────────────────────────────────────┘ │
│                                                │
│  Go 后端（w.Bind 绑定到 JS）：                 │
│  - Bilibili API 代理                           │
│  - WBI 签名 / OAuth / 设备指纹                │
│  - 弹幕 protobuf 解码                         │
│  - 视频代理（Referer Header）                  │
└────────────────────────────────────────────────┘
```

## 功能清单

| 功能 | 状态 | 说明 |
|------|------|------|
| QR 码登录 | ✅ | |
| SESSDATA 登录 | ✅ | |
| OAuth 登录 | ❌ | Lite 版去掉 |
| 视频搜索 | ✅ | |
| 收藏夹浏览 | ✅ | |
| 选集面板 | ✅ | |
| DASH 播放 | ✅ | dash.js |
| 画质切换 | ✅ | dash.js 质量选择 |
| 弹幕 | ✅ | Canvas 引擎 |
| 字幕 | ✅ | WebVTT |
| 本地文件播放 | ✅ | `<input type="file">` |
| 播放进度记忆 | ✅ | JSON 文件 |
| 历史记录 | ✅ | |
| UP主 功能 | ✅ | 从主版本移植 |
| 主题切换 | ❌ | 固定暗色 |
| 引导教程 | ❌ | |
| 分享功能 | ❌ | |

## 项目结构

```
bilinest-lite/
├── main.go                  # 入口 + WebView2 启动
├── app.go                   # Go 后端（路由 + API 代理）
├── wbi.go                   # WBI 签名
├── auth.go                  # OAuth + QR 登录
├── danmaku.go               # 弹幕 protobuf 解码
├── video_proxy.go           # 视频流代理（Referer）
├── state.go                 # 本地状态管理（JSON）
├── go.mod
├── go.sum
├── wails.json               # Wails 配置
├── frontend/
│   ├── index.html           # 单页面
│   ├── style.css            # 纯手写 CSS（~300行）
│   ├── app.js               # 前端逻辑（~800行）
│   ├── danmaku.js           # 弹幕引擎（~150行）
│   └── vendor/
│       └── dash.all.min.js  # dash.js
└── build/
    └── appicon.png          # 应用图标
```

## 开发步骤

| 步骤 | 内容 | 预估时间 |
|------|------|---------|
| 1 | Wails 项目初始化 + WebView2 窗口 | 30min |
| 2 | Go HTTP 服务器 + 静态文件 | 1h |
| 3 | Bilibili API 代理（翻译 server.mjs） | 3h |
| 4 | WBI 签名 | 1h |
| 5 | 前端 HTML + CSS（极简 UI） | 2h |
| 6 | 登录功能（QR + SESSDATA） | 2h |
| 7 | 搜索 + 收藏夹 | 2h |
| 8 | 播放器（video + dash.js） | 2h |
| 9 | 弹幕 Canvas 引擎 | 2h |
| 10 | 字幕加载 | 1h |
| 11 | 选集面板 | 1h |
| 12 | 状态管理（历史、进度） | 1h |
| 13 | UP主 功能（从主版本移植） | 2h |
| 14 | 打包测试 | 1h |
| **总计** | | **~23h** |

## 打包输出

```
BiliNest-Lite/
├── BiliNest-Lite.exe    (~5-10 MB)
├── frontend/
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   ├── danmaku.js
│   └── vendor/
│       └── dash.all.min.js
└── build/
    └── appicon.png
```

## UI 风格

### 视觉：终端感暗色主题

```
背景色：#0d1117（深灰黑）
表面色：#161b22（略浅）
边框色：#30363d（灰色线条）
文字色：#e6edf3（浅白）
强调色：#58a6ff（蓝色）
危险色：#f85149（红色）
字体：Consolas / Courier New（等宽字体）
```

### 核心组件

| 组件 | 样式 |
|------|------|
| 顶部栏 | 固定顶部，搜索框 + 按钮 |
| 搜索框 | 暗色输入框，蓝色边框聚焦 |
| 按钮 | 纯色背景，悬停变亮 |
| 视频卡片 | 暗色卡片，封面 + 标题 + UP主 |
| UP主 卡片 | 圆形头像 + 名称 + 简介 + 星级 |
| 播放器控制栏 | 底部固定，进度条 + 按钮 |
| 进度条 | 自定义 range input |
| 弹幕层 | Canvas 绝对定位在 video 上 |
| Toast | 右下角弹出，自动消失 |
| 模态框 | 居中弹窗，暗色背景遮罩 |

## 参考

- B站 API 通信笔记：`docs/bilibili-api-notes.md`
- UP主 功能规划：`docs/feature-add-up.md`
- 当前版本代码：`server.mjs` + `public/`
