# B站 API 通信笔记

## 一、现有架构

BiliNest 通过本地 Node.js 代理（`server.mjs`）转发所有 B站 API 请求，解决 CORS 问题。

```
浏览器 → localhost:4173/api/bili/* → api.bilibili.com
```

### 已实现的代理端点

| 本地路径 | 上游路径 | 签名 |
|---------|---------|------|
| `/api/bili/x/web-interface/nav` | api.bilibili.com | WBI |
| `/api/bili/x/web-interface/view` | api.bilibili.com | WBI |
| `/api/bili/x/player/pagelist` | api.bilibili.com | 无 |
| `/api/bili/x/v3/fav/folder/created/list` | api.bilibili.com | WBI |
| `/api/bili/x/v3/fav/folder/created/list-all` | api.bilibili.com | WBI |
| `/api/bili/x/v3/fav/resource/list` | api.bilibili.com | WBI |
| `/api/bili/x/v3/fav/resource/ids` | api.bilibili.com | WBI |
| `/api/bili/x/player/wbi/playurl` | api.bilibili.com | WBI |
| `/api/bili/x/player/v2` | api.bilibili.com | 无 |
| `/api/bili/x/player/wbi/v2` | api.bilibili.com | WBI |
| `/api/bili/x/v1/dm/list.so` | api.bilibili.com | 无 |
| `/api/bili/x/v2/account/myinfo` | app.bilibili.com | 无 |

---

## 二、WBI 签名机制

### 原理
B站对部分 API 使用 WBI 签名验证请求合法性。签名流程：

1. 从 `/x/web-interface/nav` 获取 `wbi_img.img_url` 和 `wbi_img.sub_url`
2. 提取文件名（去掉路径和扩展名），拼接为 `img_key + sub_key`
3. 按 `MIXIN_KEY_ENC_TAB` 表置换，取前 32 字符 → `mixin_key`
4. 添加 `wts`（当前 Unix 时间戳，秒）
5. 按 key 字母排序参数
6. URL 编码拼接查询字符串 + `mixin_key`
7. MD5 哈希 → `w_rid`
8. 将 `w_rid` 和 `wts` 加入原始请求参数

### 已知问题

| 问题 | 说明 | 影响 |
|------|------|------|
| **412 风控** | 请求频率过高或签名错误时返回 HTTP 412 | 已有自动重试（WBI_RETRY_PATHS） |
| **签名密钥缓存** | 密钥缓存 1 小时，过期后自动刷新 | 正常 |
| **时间偏差** | 客户端与服务器时间差超过 60 秒时签名失效 | 低概率 |
| **参数编码** | 中文字符需 URL 编码，否则签名不匹配 | 已处理 |

---

## 三、设备指纹（buvid3/buvid4）

### 机制
首次请求时从 `/x/frontend/finger/spi` 获取 `buvid3` 和 `buvid4`，缓存 24 小时。后续请求自动附加到 Cookie 中。

### 已知问题

| 问题 | 说明 | 影响 |
|------|------|------|
| **首次请求可能失败** | buvid3 获取失败时部分 API 返回空数据 | 低概率 |
| **Cookie 冲突** | 客户端已有 buvid3 时不覆盖 | 正常行为 |

---

## 四、Cookie 与认证

### 认证方式
1. **SESSDATA Cookie**：通过 QR 码登录或手动输入获取
2. **OAuth access_token**：可选，通过开放平台申请

### 已知问题

| 问题 | 说明 | 影响 |
|------|------|------|
| **SESSDATA 过期** | 有效期约 6 个月，过期后需重新登录 | 正常 |
| **Cookie 格式** | 需要完整 Cookie 字符串（包含 SESSDATA、bili_jct 等） | 用户需完整复制 |
| **CSRF token** | `bili_jct` 用于 POST 请求防 CSRF | POST 功能需提取此值 |

---

## 五、速率限制

### 服务端限制
- B站对 API 请求有频率限制
- 超限时返回 HTTP 412 或 JSON code -412
- 已有 10 秒窗口内 120 次请求的本地限制

### 已知问题

| 问题 | 说明 | 影响 |
|------|------|------|
| **批量操作触发风控** | 快速浏览大量收藏夹视频时可能触发 | 已有 120ms 延迟 |
| **412 后需等待** | 触发风控后需等待数秒再重试 | 已有重试逻辑 |

---

## 六、视频代理

### 机制
B站 CDN 链接需要 `Referer: https://www.bilibili.com` 请求头，浏览器无法伪造。本地代理转发时添加正确的 Referer。

### 允许的域名
```
*.bilivideo.com
*.bilivideo.cn
*.mcdn.bilivideo.cn
*.edge.mountaintoys.cn
*.hdslb.com
```

### 已知问题

| 问题 | 说明 | 影响 |
|------|------|------|
| **CDN 域名变更** | B站偶尔更换 CDN 域名 | 需更新允许列表 |
| **Range 请求** | 视频拖动产生 Range 请求，代理需支持 206 Partial Content | 已处理 |
| **大文件传输** | 4K 视频单片段可达数十 MB | 内存占用可能较高 |

---

## 七、弹幕系统

### 协议
- **主要**：Protobuf 分段接口（`/x/v2/dm/wbi/web/seg.so`）
  - 每段覆盖 6 分钟，最多 6000 条弹幕
  - 返回 HTTP 304 表示该段无更多弹幕
- **备选**：XML 接口（`/x/v1/dm/list.so`）
  - 仅返回实时池弹幕（不完整）

### 已知问题

| 问题 | 说明 | 影响 |
|------|------|------|
| **Protobuf 解码** | 手写解码器，覆盖 `DanmakuElem` 字段 | 已实现 |
| **弹幕稀疏** | 部分视频 XML 弹幕极少 | API 限制，无解决方案 |
| **分段数量** | 最多 250 段（约 25 小时视频） | 足够 |
| **WBI 签名** | 分段接口需要 WBI 签名 | 已实现 |

---

## 八、新增 UP主 相关 API 需求

### 需要新增的代理端点

| 路径 | 方法 | 用途 | 需要 WBI | 需要 POST |
|------|------|------|---------|----------|
| `/x/web-interface/wbi/search/type` | GET | 搜索 UP主 | ✅ | ❌ |
| `/x/web-interface/card` | GET | UP主卡片信息 | ❌ | ❌ |
| `/x/space/upstat` | GET | 播放量/点赞统计 | ❌ | ❌ |
| `/x/relation/followings` | GET | 已关注列表（只读） | ❌ | ❌ |
| `/x/space/wbi/arc/search` | GET | 用户投稿视频（支持搜索和分类筛选） | ✅ | ❌ |
| `/x/space/navnum` | GET | 分区数量统计 | ❌ | ❌ |
| `/x/polymer/web-space/seasons_series_list` | GET | 合集+列表列表 | ❌ | ❌ |
| `/x/polymer/web-space/seasons_archives_list` | GET | 合集内视频 | ❌ | ❌ |
| `/x/series/archives` | GET | 列表内视频 | ❌ | ❌ |

### server.mjs 改动

1. **新增路由到 `API_ROUTES`**：添加上述 GET 端点
2. **WBI 重试路径**：将需要 WBI 的新端点加入 `WBI_RETRY_PATHS`
3. **不需要 POST 处理**：不执行关注/取关

### 前端 API 扩展（api.js）

需新增的 API 函数：
```js
api.searchUser(keyword, opts)            // 搜索 UP主
api.userCard(mid, opts)                 // UP主卡片信息
api.userUpstat(mid, opts)               // 播放量/点赞统计
api.myFollowing(mid, opts)              // 已关注列表（只读）
api.userVideos(mid, opts)               // 用户投稿视频（支持 keyword/tid 筛选）
api.spaceNavnum(mid, opts)              // 分区数量统计
api.seasonsSeriesList(mid, opts)        // 合集+列表列表
api.seasonArchives(mid, seasonId, opts) // 合集内视频
api.seriesArchives(mid, seriesId, opts) // 列表内视频
```

---

## 九、其他注意事项

### 跨域
- 浏览器直接请求 `api.bilibili.com` 会被 CORS 拦截
- 所有 API 请求必须经过本地代理
- 本地代理检测失败时显示后端离线横幅

### 版本兼容
- B站 API 部分接口有版本迭代（如 `/x/player/v2` → `/x/player/wbi/v2`）
- 旧接口可能随时下线
- 建议优先使用带 `wbi` 的新版接口

### 用户体验
- 登录状态检测：通过 `/x/web-interface/nav` 验证
- 未登录时部分 API（如收藏夹、关注列表）不可用
- 需提示用户登录以使用完整功能
