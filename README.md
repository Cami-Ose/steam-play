# steam-play

把 Steam 库的游玩记录做成网页：一个个人资料页，一个游戏库页（封面墙 / 搜索 / 排序 / 分类 / 愿望单）。

数据来自 Steam 官方 Web API 和 [IsThereAnyDeal](https://isthereanydeal.com/)，抓取结果落成本地 JSON，页面只读这些 JSON。

## 功能

- **个人资料页**：一年活跃热力图、本月时长 treemap、游玩统计、游戏库预览、最新动态
- **游戏库页**：整个库的封面墙，按游玩时长 / 最近玩过 / 原价 / 每小时成本排序，按分类筛选，点开显示总时长、史低、每小时成本、最近更新
- **愿望单**：想买的游戏、当前折扣、与史低的差距
- **最近更新**：最近玩过的游戏中，厂商发布了更新公告的会在封面上标记，点开显示标题、日期和链接

## 安装

### 1. 凭证

| 需要什么 | 获取地址 | 存放位置 |
|---|---|---|
| Steam API key | <https://steamcommunity.com/dev/apikey> | `~/.steam-api/key` |
| SteamID64 | <https://steamid.io/> | `~/.steam-api/steamid` |
| ITAD API key（可选） | <https://isthereanydeal.com/apps/> | `~/.steam-api/itad` |

也支持环境变量 `STEAM_API_KEY` / `STEAM_ID` / `ITAD_API_KEY`，优先级高于文件。没有 ITAD key 时价格和史低部分留空，其余功能正常。

Steam 隐私设置中的「游戏详情」需要设为公开，抓取才有数据。

### 2. 抓取一次

```bash
python update.py
```

输出文件：

| 文件 | 内容 |
|---|---|
| `latest.json` | 当前库 |
| `snapshots/<日期>.json` | 每天一份快照 |
| `daily.json` | 按天时长 |
| `changes.json` | 新增 / 移除的游戏 |
| `prices.json` | 价格和史低 |
| `wishlist.json` | 愿望单 |
| `news.json` | 最近玩过的游戏的官方更新公告 |

输出目录默认为仓库根目录（`update.py` 所在目录），用 `STEAM_HISTORY_DIR` 可指向别处（`server.py` 认同一个变量）。`historylow.json` 由 `server.py` 按需写入：`prices.json` 里没有某个游戏的史低时，点开该游戏会现问一次 CheapShark（美区美元）并缓存 30 天。

挂 cron 每天跑一次，凌晨执行：

```
20 5 * * * cd /path/to/steam-play && python update.py >> update.log 2>&1
```

**为什么需要每天抓取**：Steam 官方接口只提供累计时长，没有按天明细。「哪天玩了多久」由两次抓取的 `playtime_forever` 差值算出，缺少中间某天时，这段时长会并入总数。「新入库了哪些游戏」同理，由 appid 集合差分得出。

### 3. 生成页面

个人资料页的底是一份 Steam 社区页的「另存为」结果。（`web/library.html` 不依赖存档页，可直接使用。）

1. 打开 `https://steamcommunity.com/id/<你的ID>/`，右键「网页另存为」，格式选「网页，完整」
2. 得到一个 `.html` 和一个 `_files` 文件夹
3. 把 `_files` 里的 15 个样式表拷进 `web/assets/`（仓库已带同名文件，也可直接使用）
4. 运行清理器：

```bash
cd web
node clean.mjs /path/to/你的页面.html index.html
```

`clean.mjs` 读取存档页，输出 `index.html`：清除其中的个人信息与登录凭据，把样式表引用指向 `assets/`，并注入 `page.js` 与一段样式。清完自查：

```bash
node check-clean.mjs index.html
```

**存档页携带登录凭据。** 「另存为」会把生成页面时的登录态一并存下：

- `g_wapit` / `webapi_token` / `data-loyalty_webapi_token`：一个 JWT，含 steamid 和存页机器的公网 IP，有效期数月
- `g_sessionID`，以及表单里隐藏的 `sessionid`
- `data-userinfo`（登录态、账号名）和 `data-steam_notifications`（通知流）

`clean.mjs` 按**形状**匹配这些内容，不依赖具体账号名，换账号同样有效。`check-clean.mjs` 逐项检查，**存在未清除的泄漏时返回 1**，可作为发布前的检查项。

`clean.mjs` 默认清除 `read-frog` 扩展注入的 DOM。其他扩展（悬浮球、划词面板等）的节点用 `CLEAN_EXT_IDS` 指定：

```bash
CLEAN_EXT_IDS="_foo_ball,_foo_panel" node clean.mjs /path/to/你的页面.html index.html
```

### 4. 启动服务

```bash
cd web
python server.py
```

默认监听 `127.0.0.1:5555`，此时访问 `http://127.0.0.1:5555/library.html`。端口被占用时用 `PORT` 指定：

```bash
PORT=8080 python server.py
```

单独运行时没有鉴权，公网部署需要在前面加一层。页面和接口同源，无需配置跨域或反向代理。

## 目录

```
update.py            抓取脚本，输出 JSON 与每日快照
web/server.py        Flask 蓝图，只读 JSON 并提供给页面
web/clean.mjs        清理存档页（个人信息与凭据），注入 page.js
web/check-clean.mjs  清理结果检查（存在泄漏时退出码为 1）
web/page.js          个人资料页逻辑：热力图 / treemap / 统计 / 游戏库 / 页脚
web/index.html       个人资料页（由 clean.mjs 生成）
web/library.html     游戏库页
web/assets/          页面样式表
LICENSE              许可证（仅覆盖本项目代码）
NOTICE               第三方组件与商标声明
```

## 注意事项

- **新游戏的封面图只在新 CDN 路径上。** 老游戏在 `cdn.cloudflare.steamstatic.com/steam/apps/<appid>/capsule_184x69.jpg`；新游戏在该路径上四种尺寸均返回 404，仅在 `shared.akamai.steamstatic.com/store_item_assets/...` 上有图。`update.py` 因此从商店接口一并保存 `capsule_imagev5`，页面优先使用它，旧路径作为兜底。
- **商店接口一次只接受一个 appid。** `appdetails?appids=1,2,3` 返回 400，只能逐个请求；该接口没有 CORS 头，浏览器直接调用会遇到跨域问题。
- **ITAD 会拦截默认 User-Agent。** `Python-urllib/3.12` 被 Cloudflare 拦截并返回 403（`error code: 1010`，表象类似 key 无效）。带上自定义 User-Agent 即正常。
- **ITAD 的 lookup 需要字符串。** body 为 `["app/413150", ...]` 形式的 JSON 数组而非数字；一次最多 200 个。
- **官方接口只提供当前状态。** 购买记录和单日时长都没有，因此「买了没玩」「哪天玩了多久」均为自行推算，数据从首次抓取之日起才有。
- **新闻接口把两类内容混在同一个 feed 里。** `ISteamNews/GetNewsForApp` 返回的既有厂商发布的更新公告，也有 PC Gamer 等外站转载的稿件，需按 `feedname` 区分：值为 `steam_community_announcements` 的才是官方公告，不过滤会有约一半是外站标题。该接口按 `appid` 逐个请求，整个库请求一遍耗时较长，因此只取最近玩过的数十个。
- **`clean.mjs` 按标签配平删除区块**，适用于 `div` / `section` 这类容器。Steam 改版更换结构后，以 `check-clean.mjs` 的结果为准。

## 许可

本项目的代码（`update.py`、`web/server.py`、`web/clean.mjs`、`web/check-clean.mjs`、`web/page.js`、`web/library.html`）按 [MIT](LICENSE) 授权。

以下内容不在该许可证覆盖范围内：

- `web/assets/` 的 15 个样式表归 Valve Corporation
- `web/index.html` 的页面骨架源自 Steam 社区页，归 Valve Corporation
- Motiva Sans 字体不随仓库分发（`motiva_sans.css` 仅远程引用 Steam CDN），按字体自身许可，未购买授权者不可使用

商业用途或公开发布前请阅读 [NOTICE](NOTICE)，其中逐项说明了各第三方部分的归属与替代方案（例如改用自己存档页中的样式表）。
