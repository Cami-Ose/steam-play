/* 我们的那半：把 Steam 页面上会变的数字换成真数据，再往后接自己的模块。
   骨架、配色、装扮全是 Steam 自己那套（assets/ 里那份），这里只填内容。

   布局照 Steam 的两栏来，不再一列平铺：
     左栏 652px —— 活跃热力图 / 本月 treemap / 游戏库（两列）
     右栏 268px —— 游玩统计（顶掉原来那个空的「当前在线」）/ 徽章墙
   指向 Steam 的链接一律拆掉：这是我们自己的页，不是 Steam 的入口。 */
(function () {
  var CDN = 'https://cdn.cloudflare.steamstatic.com';

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function hm(m) {
    m = +m || 0;
    if (m < 60) return m + ' 分';
    var h = Math.floor(m / 60), r = m % 60;
    return r ? h + ' 小时 ' + r + ' 分' : h + ' 小时';
  }
  function yuan(c) {
    c = +c || 0;
    return '¥' + (c % 100 ? (c / 100).toFixed(2) : (c / 100).toFixed(0));
  }
  function day(ts) {
    if (!ts) return '';
    var t = new Date(ts * 1000);
    return t.getFullYear() + '-' + ('0' + (t.getMonth() + 1)).slice(-2) + '-' + ('0' + t.getDate()).slice(-2);
  }
  function icon(g) {
    return g.icon ? CDN + '/steamcommunity/public/images/apps/' + g.appid + '/' + g.icon + '.jpg' : '';
  }
  /* 商店页那张横条封面（Steam 自己的「最新动态」用的就是它）。
     ⚠️ 新游戏只有**新 CDN 路径**上有图，旧路径对它们是 404，所以优先用商店接口给的那个；
     接口那条还没抓到（空串）才退回旧路径。两个都没有的话 onerror 会把图藏掉。 */
  function capsule(g) {
    var c = (g.price && g.price.cover) || '';
    return c || ('https://cdn.cloudflare.steamstatic.com/steam/apps/' +
      g.appid + '/capsule_184x69.jpg');
  }
  /* 「10 月 14 日」这种写法，跨年才带上年份 */
  function cnDay(ts) {
    if (!ts) return '—';
    var t = new Date(ts * 1000), now = new Date();
    var s = (t.getMonth() + 1) + ' 月 ' + t.getDate() + ' 日';
    return t.getFullYear() === now.getFullYear() ? s : t.getFullYear() + ' 年 ' + s;
  }
  /* Steam 的展柜区块：半透明底 + 渐变标题条 */
  function block(title, inner) {
    return '<div class="profile_customization">' +
      (title ? '<div class="profile_customization_header">' + esc(title) + '</div>' : '') +
      '<div class="profile_customization_block">' + inner + '</div></div>';
  }

  /* ---------- 指向 Steam 的链接一律拆掉（图和字留着，只是点不动了） ---------- */
  function stripSteamLinks() {
    $$('a[href]').forEach(function (a) {
      var href = a.getAttribute('href') || '';
      if (!/steamcommunity\.com|steampowered\.com/i.test(href)) return;
      var s = document.createElement('span');
      s.className = a.className;
      var tip = a.getAttribute('data-tooltip-html');
      if (tip) s.setAttribute('data-tooltip-html', tip);
      while (a.firstChild) s.appendChild(a.firstChild);
      a.parentNode.replaceChild(s, a);
    });
  }

  /* ---------- 不要的整块拿掉 ---------- */
  function drop(sel) {
    $$(sel).forEach(function (el) { el.parentNode.removeChild(el); });
  }

  /* ---------- 把 Steam 那几处数字换掉 ---------- */
  function fillHeader(d) {
    var p = d.player || {}, pr = d.profile || {};

    var nm = $('.actual_persona_name');
    if (nm && p.name) nm.textContent = p.name;

    if (p.avatar) {
      $$('.playerAvatar img').forEach(function (img) {
        if (img.closest('.profile_avatar_frame')) return;
        img.removeAttribute('srcset');
        img.src = p.avatar;
      });
      var src = $('.playerAvatar picture source[srcset*="avatars"]');
      if (src) src.srcset = p.avatar;
    }

    var lvl = $('.friendPlayerLevelNum');
    if (lvl && pr.level) lvl.textContent = pr.level;
    // 等级条的配色档位（lvl_10 / lvl_20 / …）跟着等级走。
    // 用 classList 而不是 className：这个块里混着 SVG，SVG 元素的 className 不是字符串。
    var bar = $('.friendPlayerLevel');
    if (bar && pr.level && bar.classList) {
      Array.prototype.slice.call(bar.classList).forEach(function (c) {
        if (/^lvl_\d+$/.test(c)) bar.classList.remove(c);
      });
      bar.classList.add('lvl_' + (Math.floor(pr.level / 10) * 10));
    }

    var s = d.summary, pc = d.price || {};
    var line = '库里 ' + s.games + ' 个游戏 · 玩了 ' + s.played + ' 个 · 累计 ' +
      Math.round(s.totalMinutes / 60) + ' 小时';
    if (pc.initial) line += ' · 原价合计 ' + yuan(pc.initial);
    $$('.profile_summary').forEach(function (el) {
      if (el.closest('.mobile')) return;
      el.textContent = line;
    });
  }

  /* ---------- 右栏：把那个空的「当前在线」换成统计面板 ---------- */
  function statsPanel(d) {
    var s = d.summary, pc = d.price || {};
    var total = s.totalMinutes / 60;
    function row(k, v, sub) {
      return '<div class="mz-srow"><span class="mz-sk">' + esc(k) + '</span>' +
        '<span class="mz-sv">' + esc(v) + '</span>' +
        (sub ? '<span class="mz-ss">' + esc(sub) + '</span>' : '') + '</div>';
    }
    return '<div class="profile_in_game_header">游玩统计</div>' +
      '<div class="mz-big">' + Math.round(total).toLocaleString() + '<span>小时</span></div>' +
      (total > 1 && pc.initial
        ? '<div class="mz-bigsub">平均每小时 ¥' + (pc.initial / 100 / total).toFixed(2) + '</div>' : '') +
      '<div class="mz-slist">' +
      row('游戏', s.games + ' 个', '玩过 ' + s.played + ' · 没碰过 ' + s.neverPlayed) +
      row('账号价值', yuan(pc.initial), pc.lowSum ? '全按史低 ' + yuan(pc.lowSum) : '') +
      row('本月', hm(s.monthMinutes), '最近七天 ' + hm(s.weekMinutes)) +
      '</div>';
  }

  /* ---------- 右栏：把那个空的「当前在线」换成统计面板 ---------- */
  function fillRight(d) {
    var box = $('.profile_in_game');
    if (!box) return;
    box.innerHTML = statsPanel(d);
    box.classList.remove('persona', 'online', 'in-game');
  }

  /* ---------- 左栏最上面：「最新动态」----------
     Steam 那块是抓页面那天的死数据，这里用每天抓回来的 last / minutes2w 现算。
     形状照抄 Steam 自己的 recent_games，所以样式不用我们管。 */
  function recentBlock(d) {
    var recent = d.games.filter(function (g) { return g.last > 0; })
      .sort(function (a, b) { return b.last - a.last; })
      .slice(0, 6);
    if (!recent.length) return '';
    // 「过去 2 周」是**全库**的和（Steam 自己也这么算），不是上面这 6 个的
    var twoWeek = d.games.reduce(function (s, g) { return s + (g.minutes2w || 0); }, 0);

    var rows = recent.map(function (g) {
      var stats = g.minutes2w
        ? '<span class="game_info_achievement_summary"><span class="whiteLink">过去两周</span>' +
          '<span class="ellipsis">' + (g.minutes2w / 60).toFixed(1) + ' 小时</span></span>'
        : '';
      return '<div class="recent_game"><div class="recent_game_content">' +
        '<div class="game_info">' +
        '<div class="game_info_cap"><span><img class="game_capsule" loading="lazy" src="' +
        capsule(g) + '" alt="" onerror="this.style.opacity=0"></span></div>' +
        '<div class="game_info_details">总时数 ' + (g.minutes / 60).toFixed(1) +
        ' 小时<br>最后运行日期：' + cnDay(g.last) + '</div>' +
        '<div class="game_name"><span class="whiteLink">' + esc(g.name) + '</span></div>' +
        '</div>' +
        '<div class="game_info_stats"><div class="game_info_achievements">' + stats + '</div></div>' +
        '</div></div>';
    }).join('');

    return '<div class="profile_customization">' +
      '<div class="profile_recentgame_header profile_customization_header">' +
      '<div>最新动态</div>' +
      '<div class="recentgame_quicklinks recentgame_recentplaytime"><div>' +
      (twoWeek / 60).toFixed(1) + ' 小时（过去 2 周）</div></div>' +
      '</div>' +
      '<div class="profile_customization_block"><div class="recent_games">' + rows + '</div></div>' +
      '</div>';
  }

  /* ---------- 左栏第一块：活跃热力图 ---------- */
  var HEAT = ['#12232e', '#1b4a52', '#26706f', '#3c9c8c', '#5fc4ba', '#8adbd3'];
  function heatColor(m) {
    if (!m) return HEAT[0];
    if (m < 30) return HEAT[1];
    if (m < 90) return HEAT[2];
    if (m < 180) return HEAT[3];
    if (m < 360) return HEAT[4];
    return HEAT[5];
  }
  function heatBlock(d) {
    var map = {};
    (d.daily || []).forEach(function (x) { map[x.date] = (map[x.date] || 0) + (+x.minutes || 0); });
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var start = new Date(today.getTime() - 364 * 86400000);
    start.setDate(start.getDate() - start.getDay());
    var cols = [], cur = new Date(start), active = 0, total = 0;
    while (cur <= today) {
      var col = '';
      for (var i = 0; i < 7; i++) {
        var key = cur.getFullYear() + '-' + ('0' + (cur.getMonth() + 1)).slice(-2) + '-' + ('0' + cur.getDate()).slice(-2);
        if (cur <= today) {
          var m = map[key] || 0;
          if (m > 0) { active++; total += m; }
          col += '<div class="mz-heat-cell" style="background:' + heatColor(m) + '" title="' + key + ' · ' +
            (m ? hm(m) : '没玩') + '"></div>';
        } else {
          col += '<div class="mz-heat-cell" style="background:transparent"></div>';
        }
        cur.setDate(cur.getDate() + 1);
      }
      cols.push('<div class="mz-heat-col">' + col + '</div>');
    }
    var legend = HEAT.map(function (c) { return '<div class="mz-heat-cell" style="background:' + c + '"></div>'; }).join('');
    return '<div class="mz-heat">' + cols.join('') + '</div>' +
      '<div class="mz-legend">少 ' + legend + ' 多 · 有记录 ' + active + ' 天，共 ' + hm(total) +
      '（这个只能靠每天抓一次攒，从开始抓的那天才有的）</div>';
  }

  /* ---------- 左栏第二块：treemap，面积 ∝ 本月时长 ---------- */
  function worst(row, area, side) {
    var max = 0, min = Infinity, i;
    for (i = 0; i < row.length; i++) { if (row[i].area > max) max = row[i].area; if (row[i].area < min) min = row[i].area; }
    var s2 = side * side, a2 = area * area;
    return Math.max(s2 * max / a2, a2 / (s2 * min));
  }
  function squarify(items, W, H) {
    var out = [], total = 0, i;
    for (i = 0; i < items.length; i++) total += items[i].value;
    if (!total || W <= 0 || H <= 0) return out;
    var scale = (W * H) / total;
    var rest = items.slice().sort(function (a, b) { return b.value - a.value; })
      .map(function (x) { var o = {}; for (var k in x) o[k] = x[k]; o.area = x.value * scale; return o; });
    var x = 0, y = 0, w = W, h = H;
    while (rest.length) {
      var side = Math.min(w, h);
      var row = [rest[0]], area = rest[0].area, best = worst(row, area, side), j = 1;
      while (j < rest.length) {
        var na = area + rest[j].area, nw = worst(row.concat([rest[j]]), na, side);
        if (nw > best) break;
        row.push(rest[j]); area = na; best = nw; j++;
      }
      var k, rw, rh, ox, oy;
      if (w >= h) {
        rw = area / h; oy = y;
        for (k = 0; k < row.length; k++) { var ih = row[k].area / rw; out.push({ it: row[k], x: x, y: oy, w: rw, h: ih }); oy += ih; }
        x += rw; w -= rw;
      } else {
        rh = area / w; ox = x;
        for (k = 0; k < row.length; k++) { var iw = row[k].area / rh; out.push({ it: row[k], x: ox, y: y, w: iw, h: rh }); ox += iw; }
        y += rh; h -= rh;
      }
      rest = rest.slice(row.length);
    }
    return out;
  }
  function treeBlock(d) {
    var month = (d.date || '').slice(0, 7), agg = {};
    (d.daily || []).forEach(function (x) {
      if ((x.date || '').slice(0, 7) !== month) return;
      (x.items || []).forEach(function (i) {
        var k = i.appid || i.name;
        if (!agg[k]) agg[k] = { name: i.name, value: 0 };
        agg[k].value += +i.minutes || 0;
      });
    });
    var items = Object.keys(agg).map(function (k) { return agg[k]; })
      .filter(function (x) { return x.value > 0; })
      .sort(function (a, b) { return b.value - a.value; });
    if (!items.length) {
      return '<div class="mz-empty">本月还没有记录 —— 这个只能靠每天抓一次攒，从开始抓的那天才有的。</div>';
    }
    var max = items[0].value;
    var html = '<div class="mz-tree" id="mz-tree"></div>' +
      '<div class="mz-legend">' + items.length + ' 个游戏 · 共 ' +
      hm(items.reduce(function (s, i) { return s + i.value; }, 0)) + '</div>';
    setTimeout(function () {
      var el = document.getElementById('mz-tree');
      if (!el) return;
      var W = el.clientWidth || 600, H = el.clientHeight || 220;
      el.innerHTML = squarify(items.slice(0, 20), W, H).map(function (b) {
        var t = Math.sqrt(b.it.value / max);
        var bg = 'rgba(102,192,244,' + (0.10 + t * 0.55).toFixed(2) + ')';
        return '<div class="mz-tree-box" style="left:' + b.x.toFixed(1) + 'px;top:' + b.y.toFixed(1) + 'px;width:' +
          b.w.toFixed(1) + 'px;height:' + b.h.toFixed(1) + 'px;background:' + bg + '" title="' +
          esc(b.it.name) + ' · ' + hm(b.it.value) + '">' +
          (b.w > 56 && b.h > 28 ? '<div>' + esc(b.it.name) + '</div><div class="mz-sub">' + hm(b.it.value) + '</div>' : '') +
          '</div>';
      }).join('');
    }, 30);
    return html;
  }

  /* ---------- 左栏第三块：游戏库，两列 ---------- */
  function gameRow(g) {
    var p = g.price || {};
    var price = p.isFree ? '免费'
      : (p.initial ? yuan(p.final) + (p.discount ? ' <span class="mz-cut">-' + p.discount + '%</span>' : '') : '');
    var sub = [];
    if (g.minutes > 0) {
      sub.push('最近 ' + day(g.last));
      if (p.initial) sub.push('每小时 ¥' + (p.initial / 100 / (g.minutes / 60)).toFixed(2));
    } else {
      sub.push('从没打开过');
      if (p.initial) sub.push('白买 ' + yuan(p.initial));
    }
    if (p.low) {
      sub.push('史低 ' + yuan(p.low) + (p.lowAt ? '（' + p.lowAt + '）' : ''));
    }
    return '<div class="mz-row" title="' + esc(g.name) + '">' +
      '<img src="' + esc(icon(g)) + '" loading="lazy" onerror="this.style.opacity=0">' +
      '<div class="mz-name">' + esc(g.name) + '<div class="mz-sub">' + esc(sub.join(' · ')) + '</div></div>' +
      '<div class="mz-num">' + (g.minutes > 0 ? (g.minutes / 60).toFixed(1) + 'h' : '—') + '</div>' +
      '<div class="mz-price">' + price + '</div></div>';
  }
  function col(title, games, empty) {
    var inner = games.length
      ? games.map(gameRow).join('')
      : '<div class="mz-empty">' + esc(empty) + '</div>';
    return '<div class="mz-col"><div class="mz-colh">' + esc(title) + '</div>' + inner + '</div>';
  }
  function libraryBlock(d) {
    var played = d.games.filter(function (g) { return g.minutes > 0; })
      .sort(function (a, b) { return b.minutes - a.minutes; });
    var never = d.games.filter(function (g) { return g.minutes === 0; })
      .sort(function (a, b) { return ((b.price && b.price.initial) || 0) - ((a.price && a.price.initial) || 0); });
    var wasted = never.reduce(function (s, g) { return s + ((g.price && g.price.initial) || 0); }, 0);

    /* 这一块只当预览：前 12 个 + 一个去库页面的口子。
       整个库、搜索、排序、分类、详情都在 library/ 那边 —— 左栏只有 652px，
       在这儿全铺开只能是一张密密麻麻的表，不如让出一整页去 */
    var top = played.slice(0, 12);
    var head = '<div class="mz-cols mz-one">' +
      col('玩得最多 · 前 ' + top.length + ' / ' + played.length + ' 个玩过', top, '') + '</div>';

    var wastedLine = wasted
      ? '<div class="mz-legend">买了没玩那 ' + never.length + ' 个按原价算是 ' + yuan(wasted) + '</div>' : '';

    /* 相对路径：这一页在 /box/steam/，库页面在 /box/steam/library/ —— 用 ../library/ 会跑到 /box/library/ 去 */
    var goto = '<div class="mz-goto"><a href="library/">看全部 ' + d.games.length +
      ' 个 · 搜索 / 排序 / 分类 →</a></div>';

    return head + wastedLine + goto;
  }

  /* ---------- 拼起来 ---------- */
  /* 页脚说明 —— 照 Steam 最底下那个 footer 的样子（整宽、深色、12px 小灰字）。
     数值抄的是 assets/footer.css 里那套：背景 #171a21、内容 894px 居中、
     字色 #8f8e93、分隔线 #24272c。Valve 的 logo 没搬（那是 Steam 的标）。 */
  function mountFooter(d) {
    var f = document.createElement('footer');
    f.className = 'mz-footer';
    f.innerHTML = '<div class="mz-footer-in"><hr>' +
      '<div>数据来自 Steam 官方 Web API，只读，每天抓一次' +
      (d.ageHours >= 36 ? '（上次是 ' + Math.round(d.ageHours) + ' 小时前）' : '') + '。</div>' +
      '<div>「本月」「按天」「活跃」靠两次抓取的时长差攒出来，Steam 不给按天明细。</div>' +
      '<div>账号价值 = 库里每个游戏当前原价之和，不等于你花的钱；' +
      '价格和史低来自 ITAD（国区人民币）。</div>' +
      '</div>';
    document.body.appendChild(f);
  }

  function mount(d) {
    var left = $('.profile_leftcol');
    if (!left) return;
    // 原来那块「最新动态」是抓页面那天的死数据 —— 原地换成现算的（位置不动，它上面是徽章收藏家）
    var stale = $('.profile_recentgame_header');
    if (stale) {
      var staleBox = stale.closest ? stale.closest('.profile_customization') : null;
      if (staleBox) staleBox.outerHTML = recentBlock(d);
    }

    var box = document.createElement('div');
    box.innerHTML =
      block('游玩活跃', heatBlock(d)) +
      block('本月都玩了什么', treeBlock(d)) +
      block('游戏库', libraryBlock(d));
    left.appendChild(box);
  }

  /* ---------- 页脚是 Steam 的 React 后渲的，删一次它还会长回来 ----------
     光靠 setTimeout 拆不干净（实测删完 2.5 秒它才生出来），所以盯着 DOM：
     长出来就端掉、顺手再拆一遍外链。CSS 那边也把 #footer 藏了，是最后一道兜底。 */
  function guardFooter() {
    if (!window.MutationObserver) return;
    var n = 0;
    var mo = new MutationObserver(function () {
      // ponytail: 两百次上限是防它俩互相喂（我们改 DOM 也会触发自己）——
      // 正常情况十几下就静了；真撞上无限重建说明 Steam 改了页脚，那时只靠 CSS 隐藏
      if (++n > 200) { mo.disconnect(); return; }
      var f = document.getElementById('footer');
      if (f && f.parentNode) f.parentNode.removeChild(f);
      stripSteamLinks();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    // ponytail: 只盯前 20 秒，页脚早该渲完了；再晚的漏网之鱼有 CSS 兜着
    setTimeout(function () { mo.disconnect(); }, 20000);
  }

  fetch('/api/steam/history', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d || !d.ok) { console.warn('steam 数据没拿到：', d && d.error); return; }
      // 先清场：顶栏、手机菜单、页脚、统计链接、好友，以及那个「+ 添加一个展柜」的空位。
      // ⚠️ .profile_customization_area 不能整块删 —— 它里面装着「徽章收藏家」和「最新动态」；
      //    要去掉的只是里面那块 customization_edit。
      drop('#global_header, .responsive_page_menu_ctn, #footer,' +
        '.profile_customization_area .customization_edit,' +
        '.commentthread_area,' +
        '.profile_item_links, .profile_friend_links');
      stripSteamLinks();
      fillHeader(d);
      fillRight(d);
      mount(d);
      mountFooter(d);
      guardFooter();
    })
    .catch(function (e) { console.warn('steam 数据读失败：', e); });
})();
