/* 把一份「另存为」下来的 Steam 社区页，清成能公开的空壳。

   去掉的全是**存页面那个人的**东西：凭据（会话令牌 / JWT / 登录态）、头像 /
   动态背景 / 相框 / 好友 / 展柜 / 徽章 / 昵称 / 真名 / 简介 / 留言板 /
   miniprofile id。留下的只有结构和我们的脚本 ——
   别人填自己的 key 跑一遍，就是他自己那页。

   用法：node clean.mjs <原始.html> [输出.html]
   原始页怎么来：浏览器打开自己的 Steam 个人资料页 → 右键「网页另存为」→ 完整网页。
   清完自查：node check-clean.mjs [输出.html]
*/
import fs from 'node:fs'
import path from 'node:path'

const SRC = process.argv[2]
const OUT = process.argv[3] || 'index.html'
if (!SRC) {
  console.error('用法：node clean.mjs <原始.html> [输出.html]')
  process.exit(1)
}

/* 从 start 处的开标签配平到它的闭标签，返回块尾（不含）。
   只用于 div/section 这类容器 —— img/br 这种自闭合的会把配平搞乱。 */
function 块尾(s, start) {
  const m = /^<([a-zA-Z][\w-]*)/.exec(s.slice(start))
  if (!m) return -1
  const re = new RegExp('<' + m[1] + '\\b|</' + m[1] + '>', 'gi')
  re.lastIndex = start
  let depth = 0, x
  while ((x = re.exec(s))) {
    if (x[0][1] === '/') { depth--; if (depth === 0) return x.index + x[0].length }
    else depth++
  }
  return -1
}

/* 按 class 找块（取第一个），返回 [start, end) 或 null */
function 找块(s, cls) {
  const re = new RegExp('<(div|section|a|span|picture)\\b[^>]*class="[^"]*\\b' + cls + '\\b', 'i')
  const m = re.exec(s)
  if (!m) return null
  const end = 块尾(s, m.index)
  return end < 0 ? null : [m.index, end]
}

/* 整块删掉，返回 [新串, 删了几个] */
function 删块(s, cls) {
  let n = 0
  for (;;) {
    const b = 找块(s, cls)
    if (!b) break
    s = s.slice(0, b[0]) + s.slice(b[1])
    n++
  }
  return [s, n]
}

/* 按 id 找块（顶栏那种没有 class 的） */
function 找块按id(s, id) {
  const m = new RegExp('<([a-zA-Z][\\w-]*)\\b[^>]*\\bid="' + id + '"', 'i').exec(s)
  if (!m) return null
  const end = 块尾(s, m.index)
  return end < 0 ? null : [m.index, end]
}

/* 只清空里面，容器留着（我们的脚本要往里填东西）。同一 class 有好几个就全清。
   从后往前清：前面的位置不会因为后面被删而错位。 */
function 清内容(s, cls) {
  const re = new RegExp('<(div|section|a|span|picture)\\b[^>]*class="[^"]*\\b' + cls + '\\b', 'gi')
  const 位置 = []
  let m
  while ((m = re.exec(s))) 位置.push(m.index)
  let n = 0
  for (let i = 位置.length - 1; i >= 0; i--) {
    const b = 块尾(s, 位置[i])
    if (b < 0) continue
    const inner = s.slice(位置[i], b)
    const open = inner.indexOf('>') + 1
    const close = inner.lastIndexOf('</')
    if (close <= open) continue
    s = s.slice(0, 位置[i] + open) + s.slice(位置[i] + close)
    n++
  }
  return [s, n]
}

/* 只把某个标签里的 src/srcset 抹掉，元素本身留着 */
function 抹图片(s, cls) {
  const b = 找块(s, cls)
  if (!b) return [s, 0]
  const 段 = s.slice(b[0], b[1])
  const 净 = 段.replace(/\s(src|srcset)="[^"]*"/g, '')
  return [s.slice(0, b[0]) + 净 + s.slice(b[1]), 1]
}

let h = fs.readFileSync(SRC, 'utf8')
const 原长 = h.length
const 报告 = []
function 记(说明, n) { 报告.push([说明, n]) }

// ---- 1. 她的动态背景（整段 video：poster + webm + mp4）----
;[h] = (() => { const [a, n] = 删块(h, 'profile_animated_background'); 记('动态背景', n); return [a] })()

// ---- 2. 相框（头像外面那圈）----
;[h] = (() => { const [a, n] = 删块(h, 'profile_avatar_frame'); 记('头像相框', n); return [a] })()

// ---- 3. 好友 ----
;[h] = (() => { const [a, n] = 删块(h, 'profile_topfriends'); 记('好友列表', n); return [a] })()
;[h] = (() => { const [a, n] = 删块(h, 'profile_friend_links'); 记('好友链接', n); return [a] })()

// ---- 4. 徽章：右栏那块统计 + 头部那个「常用徽章」----
;[h] = (() => { const [a, n] = 删块(h, 'profile_badges'); 记('徽章统计', n); return [a] })()
;[h] = (() => { const [a, n] = 删块(h, 'profile_header_badge'); 记('常用徽章', n); return [a] })()

// ---- 5. 留言板 ----
;[h] = (() => { const [a, n] = 删块(h, 'commentthread'); 记('留言板', n); return [a] })()
// 整块留言区（里面还有 InitializeCommentThread 那个脚本 + 它带的 discussion id）
;[h] = (() => { const [a, n] = 删块(h, 'commentthread_area'); 记('留言区', n); return [a] })()
;[h] = (() => { const [a, n] = 删块(h, 'profile_comment_area'); 记('留言板外层', n); return [a] })()

// ---- 6. 展柜：整片清空（我们的脚本会往里加自己的块）----
;[h] = (() => { const [a, n] = 清内容(h, 'profile_customization_area'); 记('展柜（清空）', n); return [a] })()

// ---- 6b. 「最新动态」：容器留着（我们的脚本要原地换掉它），里面的真数据清空 ——
//          那里面有存页那天的游戏名、appid、成就名和「过去两周 xx 小时」
;[h] = (() => { const [a, n] = 清内容(h, 'recent_games'); 记('最新动态里的游戏', n); return [a] })()
;[h] = (() => { const [a, n] = 清内容(h, 'recentgame_quicklinks'); 记('过去两周时长', n); return [a] })()

// ---- 7. 头像：picture 留着，只抹掉图的地址 ----
;[h] = (() => { const [a, n] = 抹图片(h, 'playerAvatarAutoSizeInner'); 记('头像地址', n); return [a] })()

// ---- 8. 昵称 / 简介 / 等级数字：留着元素，字清掉 ----
;[h] = (() => { const [a, n] = 清内容(h, 'actual_persona_name'); 记('昵称', n); return [a] })()
for (const c of ['profile_summary', 'friendPlayerLevelNum', 'profile_header_summary']) {
  ;[h] = (() => { const [a, n] = 清内容(h, c); 记(c, n); return [a] })()
}

// ---- 8b. 真名 / 所在地 —— Steam 个人资料页顶上那两行，比昵称还私密 ----
;[h] = (() => { const [a, n] = 删块(h, 'header_real_name'); 记('真名', n); return [a] })()
;[h] = (() => { const [a, n] = 删块(h, 'header_location'); 记('所在地', n); return [a] })()
;[h] = (() => { const [a, n] = 删块(h, 'namehistory_link'); 记('曾用名链接', n); return [a] })()

// ---- 9. 属性：miniprofile id（能反查到人）----
const ids = (h.match(/\sdata-miniprofile="[^"]*"/g) || []).length
h = h.replace(/\sdata-miniprofile="[^"]*"/g, '')
记('miniprofile id', ids)

// ---- 10. 存页那个人的主页地址（各种链接里都带着）----
const 主页 = h.match(/https:\/\/steamcommunity\.com\/id\/([A-Za-z0-9_-]+)/)
if (主页) {
  const 名 = 主页[1]
  const n = (h.match(new RegExp(名.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
  h = h.split(名).join('__STEAM_ID__')
  h = h.split(encodeURIComponent(名)).join('__STEAM_ID__')
  记('主页名 ' + 名, n)
}
// 存下来的文件夹名（Steam 社区 __ 某某_files）也带着名字
const 目录 = h.match(/([^"'/\\]*)files\//)
if (目录 && /Steam|社区/.test(目录[1])) {
  const n = (h.match(new RegExp(目录[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
  h = h.split(目录[1]).join('__ASSETS__')
  记('资源文件夹名', n)
}

// ---- 11. 顶栏：Steam 自己的导航条，她的 id 链接 / 绿信封 / 通知都在里面 ----
{
  const b = 找块按id(h, 'global_header')
  if (b) { h = h.slice(0, b[0]) + h.slice(b[1]); 记('顶栏', 1) }
}
;[h] = (() => { const [a, n] = 清内容(h, 'user_avatar'); 记('顶栏小头像', n); return [a] })()

// ---- 12. <head> 的 meta：标题写着她的名字、描述是她的简介、图是她的头像 ----
const 前 = h.length
h = h.replace(/<title>[^<]*<\/title>/, function () { return '<title>Steam</title>' })
h = h.replace(/(<meta[^>]*(?:og:title|twitter:title)[^>]*content=")[^"]*(")/g,
  function (_, a, b) { return a + 'Steam' + b })
h = h.replace(/[ \t]*<meta[^>]*(?:og:description|twitter:description|name="Description")[^>]*>[ \t]*\n?/gi,
  function () { return '' })
h = h.replace(/[ \t]*<meta[^>]*(?:og:image|twitter:image)[^>]*>[ \t]*\n?/gi, function () { return '' })
h = h.replace(/[ \t]*<link[^>]*rel="image_src"[^>]*>[ \t]*\n?/gi, function () { return '' })
h = h.replace(/[ \t]*<meta[^>]*twitter:site[^>]*>[ \t]*\n?/gi, function () { return '' })
记('head 的 meta（字符）', 前 - h.length)

// ---- 13. 页面里的 JS 变量也带着她的 id ----
const idn = (h.match(/g_steamID = "[^"]*"/g) || []).length
h = h.replace(/g_steamID = "[^"]*"/g, function () { return 'g_steamID = ""' })
记('g_steamID', idn)

// ---- 13b. ★ 凭据 —— 存下来的页面里带着**当时那个会话的令牌**，一个都不能留 ----
// 这几样是「另存为」时浏览器把页面里的 JS 变量一起存下来的，跟 Steam 的结构无关：
//   · g_wapit / webapi_token / loyalty_webapi_token —— 一个 JWT，解开就是
//     steamid + 存页那台机器的公网 IP，有效期几个月，拿去就能当本人调社区接口
//   · g_sessionID / 隐藏的 sessionid —— 会话 id，跟 cookie 配对能直接发请求
//   · data-userinfo / data-steam_notifications —— 登录态、账号 id、通知流（里面是
//     appid / 物品 id）。我们的脚本一个都不用，整条属性摘掉。
// 别人拿自己的页面跑这个脚本时同样会带上自己的 —— 所以在这儿统一抹掉，不针对某个人。
{
  const 前4 = h.length
  // JWT：三段 base64url，用 `.` 隔开。⚠️ 别拿 `eyJ` 当锚 —— 这份的头是
  // `{ "typ": "JWT"...`（花括号后面有空格），base64 出来是 `eyAidHlw…` 不是 `eyJ…`。
  // 按「三段、后两段够长」的形状认，Steam 换 payload 也照样中。
  const JWT = /ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{40,}/g
  记('JWT（处）', (h.match(JWT) || []).length)
  h = h.replace(JWT, function () { return '' })
  // 会话 id：Steam 这份是 **24** 位十六进制（不是 32）。按形状抹，不猜变量名。
  const SID = /(["'])[0-9a-f]{20,64}\1/g
  记('会话 id（处）', (h.match(SID) || []).length)
  h = h.replace(SID, function (_, q) { return q + q })
  // #application_config 上那几条装登录态的属性：整条摘掉
  // （值里是 &quot; 转义过的，不含裸引号，所以按 [^"]* 配到底就停）
  for (const a of ['data-userinfo', 'data-loyaltystore', 'data-loyalty_webapi_token',
                   'data-steam_notifications']) {
    const n = (h.match(new RegExp('\\s' + a + '="[^"]*"', 'g')) || []).length
    h = h.replace(new RegExp('\\s' + a + '="[^"]*"', 'g'), function () { return '' })
    记(a, n)
  }
  记('凭据相关（字符）', 前4 - h.length)
}

// ---- 14. 响应式菜单（窄屏那个抽屉：她的头像、名字、库存/通知链接都在里面）----
;[h] = (() => { const [a, n] = 删块(h, 'responsive_page_menu_ctn'); 记('响应式菜单', n); return [a] })()
;[h] = (() => { const [a, n] = 清内容(h, 'responsive_menu_user_bg'); 记('菜单里的背景图', n); return [a] })()
;[h] = (() => { const [a, n] = 清内容(h, 'playerProfile_area'); 记('菜单里的头像', n); return [a] })()

// ---- 15. 页脚那段 JSON（steamid / 昵称 / 简介都在这儿，HTML 里是转义的）----
{
  const 前2 = h.length
  const 清字段 = (s, key) => s
    .replace(new RegExp('&quot;' + key + '&quot;:&quot;[^&]*&quot;', 'g'), function () { return '&quot;' + key + '&quot;:&quot;&quot;' })
    .replace(new RegExp('"' + key + '":"[^"]*"', 'g'), function () { return '"' + key + '":""' })
  h = 清字段(h, 'steamid')
  h = 清字段(h, 'personaname')
  h = 清字段(h, 'summary')
  h = 清字段(h, 'account_name')
  记('页面里的 JSON 字段（字符）', 前2 - h.length)
}
// 32 位那一串（steamid 的十进制写法）在任何地方都不该留
{
  const n = (h.match(/7656119\d{10}/g) || []).length
  h = h.replace(/7656119\d{10}/g, function () { return '0' })
  记('裸的 steamid', n)
}

// ---- 16. 她存下来的那些图（头像 / 好友头像 / 徽章图 / 背景）——
//          全在那个资源文件夹里，一律抹掉引用。别人的页面跑这个脚本时同理。----
{
  const n = (h.match(/(?:src|srcset)="[^"]*__ASSETS__files\/[^"]*"/g) || []).length
  h = h.replace(/(?:src|srcset)="[^"]*__ASSETS__files\/[^"]*"/g, function () { return '' })
  记('资源文件夹里的图', n)
}
// 还有些头像直接引用 CDN 原地址（不走资源文件夹），一并抹掉。
// ⚠️ 只抹「图」的引用 —— Steam 自己的 JS 里那个 AVATAR_BASE_URL 常量要留着。
{
  const n = (h.match(/(?:src|srcset)="[^"]*avatars\.fastly\.steamstatic\.com[^"]*"/g) || []).length
  h = h.replace(/(?:src|srcset)="[^"]*avatars\.fastly\.steamstatic\.com[^"]*"/g, function () { return '' })
  记('CDN 上的头像', n)
}

// ---- 17. 占位符接回去：剩下的资源引用指向同目录的 assets/ ----
// 走到这里还引用着资源的，只剩 Steam 自己的那几个 css（她的图在第 16 步全抹了）
h = h.split('__ASSETS__files/').join('assets/')
h = h.split('__STEAM_ID__').join('youraccount')

// ---- 17b. 存页面时浏览器扩展塞进来的 DOM ----
// 「另存为」会把当时页面上扩展注入的东西一起存下来（悬浮球、面板、shadow host），
// 它们既不属于 Steam 也不属于这个项目 —— 一并清掉。
//
// 默认只清公开扩展 read-frog（它给注入的节点起了固定名字，认得出）。
// **你自己装的别的扩展**：加一条进 `扩展的id` / `扩展的class` 就行 ——
// 名字在存下来的页面里搜那个悬浮球的 id（多半是 `_xxx_ball` 这种）能找着。
// 不想改文件就设环境变量：CLEAN_EXT_IDS="_foo_ball,_foo_panel"
const 扩展的id = (process.env.CLEAN_EXT_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
const 扩展的class = ['read-frog-react-shadow-host', 'FullModalOverlay']
for (const id of 扩展的id) {
  const b = 找块按id(h, id)
  if (b) { h = h.slice(0, b[0]) + h.slice(b[1]); 记('扩展注入 #' + id, 1) }
}
for (const cls of 扩展的class) {
  ;[h] = (() => { const [a, n] = 删块(h, cls); 记('扩展注入 .' + cls, n); return [a] })()
}
// 扩展自己带的样式表和自定义元素（<read-frog> / <read-frog-selection>）——
// 它们是嵌在 <body> 里的，不是 <head> 里那张表，所以得单独摘。
{
  const 前3 = h.length
  h = h.replace(/<style[^>]*data-read-frog-[^>]*>[\s\S]*?<\/style>/g, function () { return '' })
  for (const tag of ['read-frog', 'read-frog-selection']) {
    const re = new RegExp('<' + tag + '\\b', 'g')
    let m, 删 = 0
    while ((m = re.exec(h))) {
      const 尾 = 块尾(h, m.index)
      if (尾 < 0) break
      h = h.slice(0, m.index) + h.slice(尾)
      re.lastIndex = m.index
      删++
    }
    if (删) 记('扩展元素 <' + tag + '>', 删)
  }
  记('扩展的样式表（字符）', 前3 - h.length)
}

// ---- 18. 挂上我们那半：样式 + 脚本 ----
// 清理只是把原页变空；这一节把「会动的那些块」接上去。
const 样式 = `<style>
/* 原页里那几块用不着的（菜单 / 通知 / 评论 / 编辑按钮），清过的页面里多半已经没了，
   留着是防漏网 —— 万一某个 class 在别的页面存下来时还在 */
#global_header, .responsive_page_menu_ctn, .responsive_page_menu,
.responsive_header_notification_badge_ctn, .profile_topfriends, .profile_friend_links,
.commentthread, #footer, .responsive_page_content_overlay, .profile_header_actions,
.profile_customization_editlink, .profile_customization_edit_icon,
.profile_header_summary.mobile, .namehistory_link, #NamePopup, .header_real_name,
.global_action_link, .responsive_page_menu_ctn.localmenu,
.profile_header_badgeinfo .persona_level_btn
{ display: none !important; }

/* 我们加的那几块 —— 外形照 Steam 自己的展柜块来，只补它没有的零件 */
.mz-big { font-size: 34px; font-weight: 200; color: #fff; line-height: 1.1; margin: 4px 0 0;
  font-variant-numeric: tabular-nums; }
.mz-big span { font-size: 14px; color: #8f98a0; margin-left: 5px; }
.mz-bigsub { font-size: 11px; color: #8f98a0; margin-bottom: 10px; }
.mz-slist { border-top: 1px solid rgba(255,255,255,.08); margin-top: 10px; padding-top: 4px; }
.mz-srow { display: flex; align-items: baseline; flex-wrap: wrap; padding: 5px 0; font-size: 13px; }
.mz-sk { color: #8f98a0; width: 62px; flex: none; font-size: 12px; }
.mz-sv { color: #66c0f4; font-variant-numeric: tabular-nums; }
.mz-ss { color: #8f98a0; font-size: 11px; width: 100%; padding-left: 62px; }

.mz-heat { display: flex; gap: 2px; }
.mz-heat-col { display: flex; flex-direction: column; gap: 2px; flex: 1 1 0; min-width: 0; }
.mz-heat-cell { width: 100%; aspect-ratio: 1; border-radius: 2px; background: #0e1621; }
.mz-legend { display: flex; align-items: center; gap: 3px; font-size: 11px; color: #8f98a0;
  margin-top: 8px; line-height: 1.6; }
.mz-legend .mz-heat-cell { width: 10px; height: 10px; flex: none; aspect-ratio: auto; }

.mz-tree { position: relative; width: 100%; height: 200px; }
.mz-tree-box { position: absolute; overflow: hidden; border: 1px solid #16202d; border-radius: 2px;
  padding: 4px 5px; font-size: 11px; color: #fff; display: flex; flex-direction: column;
  justify-content: flex-end; }

.mz-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }
.mz-cols.mz-one { grid-template-columns: 1fr; }
.mz-goto { padding: 10px 0 2px; }
.mz-goto a { color: #66c0f4; font-size: 13px; text-decoration: none; }
.mz-goto a:hover { color: #fff; text-decoration: underline; }
.mz-col { min-width: 0; }
.mz-colh { font-size: 12px; color: #8f98a0; padding: 2px 0 6px;
  border-bottom: 1px solid rgba(255,255,255,.08); margin-bottom: 2px; }
.mz-row { display: flex; align-items: center; gap: 8px; padding: 5px 0;
  border-bottom: 1px solid rgba(255,255,255,.05); font-size: 13px; }
.mz-row img { width: 26px; height: 26px; border-radius: 2px; flex: none; background: #0e1621; }
.mz-name { flex: 1; min-width: 0; color: #c6d4df; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.mz-num { flex: none; color: #66c0f4; font-variant-numeric: tabular-nums; font-size: 12px; }
.mz-price { flex: none; width: 64px; text-align: right; color: #c6d4df; font-size: 12px;
  font-variant-numeric: tabular-nums; }
.mz-cut { color: #a4d007; }
.mz-sub { font-size: 11px; color: #8f98a0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mz-empty { font-size: 12px; color: #8f98a0; padding: 14px 0; }
/* 页脚说明照 Steam 最底下那个 footer 排：整宽、深色、12px 小灰字 */
.mz-footer { background: #171a21; padding: 16px 16px 40px; margin-top: 20px; clear: both; }
.mz-footer-in { max-width: 894px; margin: 0 auto; padding-top: 16px; color: #8f8e93;
  font-family: "Motiva Sans", Arial, Helvetica, sans-serif; font-weight: normal;
  font-size: 12px; line-height: 24px; }
.mz-footer-in hr { border: none; border-bottom: 1px solid #24272c; margin: 20px 0; }

@media (max-width: 960px) {
  .profile_leftcol, .profile_rightcol { width: 100% !important; float: none !important; }
  .mz-cols { grid-template-columns: 1fr; }
}
</style>
</head>`

// ⚠️ 替换串一律用「函数形式」：String.replace 的替换串里 `$$` 会被吃成一个 `$`，
//    而我们的脚本里有 `$$('.xxx')` 这个辅助函数 —— 用字符串当替换串会把它改成 `$`，
//    于是全篇 `$()` 都变成返回数组，报出来的是些莫名其妙的错。
const 脚本 = fs.readFileSync(path.join(import.meta.dirname, 'page.js'), 'utf8')
h = h.replace('</head>', function () { return 样式 })
h = h.replace('</body>', function () { return '<script>\n' + 脚本 + '\n</script>\n</body>' })

fs.writeFileSync(OUT, h)
console.log('%s  %d -> %d 字符', path.basename(SRC), 原长, h.length)
for (const [k, v] of 报告) if (v) console.log('  去了 %s：%d 处', k, v)
console.log('写出 %s', OUT)
