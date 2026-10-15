/* 清完的页面里还有没有**存页面那个人的**东西。

   用法：node check-clean.mjs index.html

   判据一律按**形状**认，不写具体是谁 —— 这个脚本要公开，把某人的账号名
   写进来就等于把要防的东西印在说明书上；而且换个账号它就失效了。

   两种东西分开报：
     ① 泄漏类（JLK）—— 凭据、steamid、账号名、通知流。有一条没清干净就不能公开。
     ② 残留类（残）—— 结构上还留着的个人信息块（好友、徽章、留言板…）。
        Steam 改版时这里会先红，提醒去看一眼。
   退出码：干净 0，有泄漏 1。
*/
import fs from 'node:fs'

const 目标 = process.argv[2] || 'index.html'
const h = fs.readFileSync(目标, 'utf8')

/* 我们注入的那两段（style / page.js）里本来就会提到一些类名 ——
   查之前先摘掉，只盯 Steam 原页那半，别把自己的代码当成残留。 */
const 静态 = h
  .replace(/<style>\n\/\* 原页里那几块用不着的[\s\S]*?<\/style>\n<\/head>/, '</head>')
  .replace(/<script>\n\/\* 我们的那半[\s\S]*?<\/script>\n<\/body>/, '</body>')

let 泄漏 = 0
let 残留 = 0

function 查(名, 数, { 容忍 = 0, 类 = '残' } = {}) {
  const 脏 = 数 > 容忍
  if (脏) { if (类 === '泄漏') 泄漏++; else 残留++ }
  console.log('  ' + (脏 ? '✗' : '✓') + ' ' + 名.padEnd(34) + 数)
  return 数
}
const 数 = (s, re) => (s.match(re) || []).length

console.log('检查 %s（%d 字符）\n', 目标, h.length)

console.log('① 凭据 / 身份 —— 有一条就不该公开')
// JWT：三段 base64url。⚠️ 不拿 `eyJ` 当锚：这份的头是 `{ "typ": ...`，
// base64 出来是 `eyAidHlw…`。按形状认。
查('JWT', 数(静态, /ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{40,}/g), { 类: '泄漏' })
// 会话 id：Steam 这份是 24 位十六进制。空串（清过的样子）不算。
查('会话 id（引号里的十六进制）', 数(静态, /(["'])[0-9a-f]{20,64}\1/g), { 类: '泄漏' })
查('g_wapit 有值', 数(静态, /g_wapit\s*=\s*["'][^"']+["']/g), { 类: '泄漏' })
// 值可能是转义过的（data-loyaltystore 里是 `&quot;webapi_token&quot;:&quot;ey…`），
// 所以名字和 JWT 之间允许隔一段任意字符，别按裸引号去配。
查('webapi_token 有值', 数(静态, /webapi_token[\s\S]{0,60}?ey[A-Za-z0-9_-]{8,}\./g), { 类: '泄漏' })
查('隐藏的 sessionid 有值', 数(静态, /name="sessionid"\s+value="[^"]+"/g), { 类: '泄漏' })
// steamid64：7656119 + 10 位。空串 g_steamID 不算。
查('steamid64', 数(静态, /7656119\d{10}/g), { 类: '泄漏' })
查('data-userinfo（登录态）', 数(静态, /data-userinfo=/g), { 类: '泄漏' })
查('data-steam_notifications', 数(静态, /data-steam_notifications=/g), { 类: '泄漏' })
查('data-loyaltystore', 数(静态, /data-loyaltystore=/g), { 类: '泄漏' })
查('账号名（account_name）', 数(静态, /account_name/g), { 类: '泄漏' })
// 主页地址只允许占位符 youraccount
{
  const 名 = [...静态.matchAll(/steamcommunity\.com\/id\/([^"'/?#]+)/g)].map(m => m[1])
  const 非占位 = 名.filter(x => x !== 'youraccount')
  const 脏 = 非占位.length > 0
  if (脏) 泄漏++
  console.log('  ' + (脏 ? '✗' : '✓') + ' ' + '主页名（只许 youraccount）'.padEnd(34) + 非占位.length)
  if (脏) console.log('       见到：' + [...new Set(非占位)].slice(0, 5).join(' / '))
}
// 存页面那个资源文件夹（Steam 社区 __ 某某_files）—— 名字里带账号名
查('资源文件夹名（_files/）', 数(静态, /_files\//g), { 类: '泄漏' })
查('浏览器扩展注入（<read-frog…>）', 数(静态, /<read-frog[\s>]/g), { 类: '泄漏' })

console.log('\n② 信息块 —— 结构上不该再有的')
for (const [名, re] of [
  ['动态背景', /profile_animated_background/g],
  ['头像相框', /profile_avatar_frame/g],
  ['好友列表', /profile_topfriends/g],
  ['好友链接', /profile_friend_links/g],
  ['徽章统计', /profile_badges/g],
  // ⚠️ 别查 `profile_header_badge`：它同时命中 `profile_header_badgeinfo`（头像旁那个
  //    等级框，本来就留着、字已清空）。真正装徽章数据的是这两个。
  ['常用徽章图', /badge_icon/g],
  ['常用徽章（favorite_badge）', /favorite_badge/g],
  ['展柜格子', /showcase_slot/g],
  ['留言板', /commentthread_area/g],
  ['留言区外层', /profile_comment_area/g],
  ['真名', /header_real_name/g],
  ['所在地', /header_location/g],
  ['曾用名链接', /namehistory_link/g],
  ['顶栏', /id="global_header"/g],
  ['响应式菜单', /responsive_page_menu_ctn/g],
  ['好友（data-miniprofile）', /data-miniprofile/g],
  ['最新动态里的游戏（recent_game）', /class="recent_game"/g],
]) 查(名, 数(静态, re))

console.log('\n③ 留着是对的（Steam 自己的东西，别人的页面也有）')
for (const k of ['shared.fastly', 'avatars.fastly', 'Motiva Sans'])
  console.log('  · ' + k.padEnd(34) + 数(h, new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')))

console.log('\n' + (泄漏
  ? `✗ 有 ${泄漏} 项泄漏没清干净 —— 不能公开`
  : 残留
    ? `⚠ 没有泄漏；还有 ${残留} 项信息块残留（多半是 Steam 改版了，看一眼）`
    : '✓ 干净：凭据和身份信息一个不剩'))
process.exit(泄漏 ? 1 : 0)
