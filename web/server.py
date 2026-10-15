"""server.py — Steam 游戏库页面的后端

数据来源：数据目录（默认是脚本所在目录的上一级）—— update.py 每天抓一次落下的快照。

本模块**只读 JSON**，不发起任何 Steam 请求。原价、现价、史低都是 update.py
每天从 ITAD 取好写进 prices.json 的（国区人民币）；万一那份数据里没有某个游戏的史低，
页面点开时会现问一次 CheapShark（美区美元）兜底，问过缓存 30 天。

路由 /api/steam/*。挂进别的项目时，鉴权交给宿主的 before_request 统一处理；
单独跑（python3 server.py）时没有鉴权，所以默认只监听 127.0.0.1。
"""
import json
import os
import time
import urllib.parse
import urllib.request

from flask import Blueprint, jsonify, request

steam_bp = Blueprint("steam", __name__, url_prefix="/api/steam")

# 数据目录：默认取**脚本所在目录的上一级** —— server.py 在 web/ 里，而 update.py
# 默认把 latest.json / prices.json 这些落在它自己所在的目录（也就是仓库根目录），
# 两边这样取正好对上，不用配环境变量。想换地方就设 STEAM_HISTORY_DIR
# （update.py 也认这个变量），比如指到 ./data 让数据和代码分开。
STEAM_DIR = (os.environ.get("STEAM_HISTORY_DIR")
             or os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_LATEST = os.path.join(STEAM_DIR, "latest.json")
_PRICES = os.path.join(STEAM_DIR, "prices.json")
_DAILY = os.path.join(STEAM_DIR, "daily.json")
_CHANGES = os.path.join(STEAM_DIR, "changes.json")
_LOW = os.path.join(STEAM_DIR, "historylow.json")
_WISHLIST = os.path.join(STEAM_DIR, "wishlist.json")
_NEWS = os.path.join(STEAM_DIR, "news.json")

UA = "steam-box/1.0"
TIMEOUT = 20
_LOW_CACHE_DAYS = 30


def _read(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _hm(minutes):
    """分钟 → 「12 小时 34 分」/「48 分」"""
    m = int(minutes or 0)
    if m < 60:
        return "%d 分" % m
    return "%d 小时 %d 分" % (m // 60, m % 60) if m % 60 else "%d 小时" % (m // 60)


def _price_summary(prices, total):
    """价格汇总 —— 从 prices.json 现算。

    不用 latest.json 里那份：那是 update.py 跑的那一刻的快照，
    而商店页那段和 ITAD 那段是分开写的，照抄容易拿到过期的数
    （也可能因为半路出错变成负数）。
    """
    priced = [p for p in prices.values() if p.get("initial")]
    lowed = [p for p in prices.values() if p.get("low")]
    return {
        "priced": len(priced),
        "unpriced": max(0, total - len(priced)),
        "initial": sum(int(p["initial"]) for p in priced),
        "final": sum(int(p.get("final") or 0) for p in priced),
        "currency": (priced[0].get("currency") if priced else "") or "CNY",
        "lowSum": sum(int(p["low"]) for p in lowed),
        "lowCount": len(lowed),
    }


def build_payload():
    """把 latest + prices + daily + changes 拼成页面要的形状。数据缺失时 ok=False，不抛异常。"""
    latest = _read(_LATEST)
    if not isinstance(latest, dict) or not isinstance(latest.get("games"), list):
        return {"ok": False, "error": "还没有抓到 Steam 库"}

    prices = _read(_PRICES, {}) or {}
    daily = _read(_DAILY, []) or []
    changes = _read(_CHANGES, {"added": [], "removed": []}) or {"added": [], "removed": []}
    wish = _read(_WISHLIST, {}) or {}
    if not isinstance(wish, dict) or not isinstance(wish.get("items"), list):
        wish = {"at": "", "items": []}
    news = _read(_NEWS, {}) or {}
    if not isinstance(news, dict) or not isinstance(news.get("games"), dict):
        news = {"games": {}}

    games = []
    for g in latest["games"]:
        p = prices.get(str(g.get("appid")))
        games.append({
            "appid": g.get("appid"),
            "name": g.get("name") or "",
            "minutes": int(g.get("minutes") or 0),
            "minutes2w": int(g.get("minutes2w") or 0),
            "last": int(g.get("last") or 0),
            "icon": g.get("icon") or "",
            "deck": int(g.get("deck") or 0),
            "offline": int(g.get("offline") or 0),
            # 没查过价的就是 None —— 别拿「0 元」冒充「不知道」
            "price": {
                "initial": int(p.get("initial") or 0),
                "final": int(p.get("final") or 0),
                "discount": int(p.get("discount") or 0),
                "currency": p.get("currency") or "",
                "isFree": p.get("isFree"),
                # 商店页的中文名（GetOwnedGames 只给英文名，多半要按中文名找）
                "name": p.get("name") or "",
                "genres": p.get("genres") or [],
                "at": p.get("at") or "",
                # 史低那几样来自 ITAD（国区人民币），没查到的就是 0 / 空
                "low": int(p.get("low") or 0),
                "lowY1": int(p.get("lowY1") or 0),
                "lowM3": int(p.get("lowM3") or 0),
                "lowAt": p.get("lowAt") or "",
                "lowShop": p.get("lowShop") or "",
                "url": p.get("url") or "",
                "noDeal": bool(p.get("noDeal")),
                # 横版封面（184×69）。新游戏只有新 CDN 路径上有图，所以由商店接口给；
                # 空串表示这条还没抓到，前端自己退回旧路径。
                "cover": p.get("cover") or "",
            } if p else None,
        })
    games.sort(key=lambda x: x["last"], reverse=True)

    try:
        updated_ts = os.path.getmtime(_LATEST)
    except OSError:
        updated_ts = 0

    # 本周 / 本月都从 daily 里筛。daily 是差分攒出来的 ⇒ 只有从开始抓的那天起才有
    month = time.strftime("%Y-%m")
    week_cut = time.time() - 7 * 86400
    week_minutes = month_minutes = 0
    for d in daily:
        date = str(d.get("date") or "")
        try:
            ts = time.mktime(time.strptime(date, "%Y-%m-%d"))
        except ValueError:
            continue
        if ts >= week_cut:
            week_minutes += int(d.get("minutes") or 0)
        if date.startswith(month):
            month_minutes += int(d.get("minutes") or 0)

    top = max(games, key=lambda x: x["minutes"]) if games else None
    return {
        "ok": True,
        "fetchedAt": latest.get("fetchedAt") or "",
        "date": latest.get("date") or "",
        "ageHours": round((time.time() - updated_ts) / 3600.0, 1) if updated_ts else None,
        "player": latest.get("player") or {},
        "profile": latest.get("profile") or {},
        "price": _price_summary(prices, len(games)),
        "summary": {
            "games": len(games),
            "played": sum(1 for g in games if g["minutes"] > 0),
            "neverPlayed": sum(1 for g in games if g["minutes"] == 0),
            "totalMinutes": sum(g["minutes"] for g in games),
            "weekMinutes": week_minutes,
            "monthMinutes": month_minutes,
            "topTitle": top["name"] if top else "",
            "topMinutes": top["minutes"] if top else 0,
        },
        "games": games,
        "daily": daily,
        "changes": changes,
        # 愿望单单独一份（没买的东西不算进账号价值，所以没混进 prices.json）
        "wishlist": wish,
        # 官方更新公告：{appid: {name, items:[{title,date,url,body}]}}，只装最近玩过那批里有更新的
        "news": news["games"],
    }


# ========================================================
# 史低兜底：prices.json 里没有才走这儿
#   正路是 update.py 每天从 ITAD 取（国区人民币）；这里只兜 ITAD 没收录的。
#   ⚠️ CheapShark 是**美区、美元** —— 页面上必须写明口径，别让两个数看着像一回事。
# ========================================================
def _cheapshark(appid):
    def j(u):
        req = urllib.request.Request(u, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8", "replace"))

    hit = j("https://www.cheapshark.com/api/1.0/games?steamAppID=" + str(appid))
    if not isinstance(hit, list) or not hit:
        return None
    gid = hit[0].get("gameID")
    if not gid:
        return None
    time.sleep(0.5)
    d = j("https://www.cheapshark.com/api/1.0/games?id=" + urllib.parse.quote(str(gid)))
    ever = d.get("cheapestPriceEver") or {}
    if not ever.get("price"):
        return None
    return {
        "low": float(ever["price"]),
        "lowAt": int(ever.get("date") or 0),
        "now": float(hit[0].get("cheapest") or 0),
        "currency": "USD",
        "shop": "CheapShark（美区）",
    }


@steam_bp.route("/historylow")
def steam_historylow():
    raw = (request.args.get("appid") or "").strip()
    if not raw.isdigit():
        return jsonify({"ok": False, "error": "appid 不对"}), 400
    appid = int(raw)

    # 先看 update.py 从 ITAD 取好的那份 —— 国区人民币、本地读、毫秒级
    p = (_read(_PRICES, {}) or {}).get(str(appid)) or {}
    if p.get("low"):
        ts = 0
        try:
            ts = int(time.mktime(time.strptime(str(p.get("lowAt"))[:10], "%Y-%m-%d")))
        except Exception:
            pass
        return jsonify({
            "ok": True, "cached": True, "source": "itad",
            "low": p["low"] / 100.0,
            "lowAt": ts,
            "now": (p.get("final") or 0) / 100.0,
            "lowY1": (p.get("lowY1") or 0) / 100.0,
            "lowM3": (p.get("lowM3") or 0) / 100.0,
            "currency": "CNY",
            "shop": "Steam 国区（ITAD）",
        })

    cache = _read(_LOW, {}) or {}
    hit = cache.get(str(appid))
    if hit and time.time() - float(hit.get("cachedAt") or 0) < _LOW_CACHE_DAYS * 86400:
        return jsonify(dict(hit, ok=True, cached=True))

    try:
        got = _cheapshark(appid)
    except Exception as e:
        return jsonify({"ok": False, "error": "问不到史低：%s" % str(e)[:120]})
    if not got:
        return jsonify({"ok": False, "error": "这个游戏在 CheapShark 上没记录"})

    got["cachedAt"] = time.time()
    cache[str(appid)] = got
    try:
        tmp = _LOW + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=1)
        os.replace(tmp, _LOW)
    except Exception:
        pass  # 缓存写不进去不算错，下次再问一遍就是
    return jsonify(dict(got, ok=True, cached=False))


@steam_bp.route("/history")
def steam_history():
    return jsonify(build_payload())


# ========================================================
# 聊天 agent 工具：steam_play（只读）
#   - 供宿主的工具分发处复用，与页面同一条数据
# ========================================================
def _yuan(cents):
    """分 → 「¥48」/「¥48.50」"""
    c = int(cents or 0)
    return "¥%d" % (c // 100) if c % 100 == 0 else "¥%.2f" % (c / 100.0)


def _nice_date_ts(ts):
    """unix 时间戳 → 「2026-09-23」（本地时区）"""
    return time.strftime("%Y-%m-%d", time.localtime(int(ts))) if ts else ""


def _tool_args(args):
    """工具参数常常是当 **JSON 字符串**送下来的 —— 不先解一次，args 是 str，
    后面 .get() 直接抛异常，会把整条请求打成 500。"""
    if isinstance(args, str):
        try:
            args = json.loads(args) if (args or "").strip() else {}
        except Exception:
            args = {}
    return args if isinstance(args, dict) else {}


def exec_steam_play(args):
    """steam_play 工具执行入口（只读）。返回 (ok, 文本)。异常一律转成 False+文本，绝不往外抛。"""
    try:
        return _exec_steam_play(args)
    except Exception as e:
        return False, "steam_play error: " + str(e)[:200]


def _exec_steam_play(args):
    a = _tool_args(args)
    data = build_payload()
    if not data.get("ok"):
        return False, "steam_play: " + (data.get("error") or "读不到游玩记录")

    action = str(a.get("action") or "recent").strip()
    games = data["games"]
    daily = data["daily"]
    s = data["summary"]
    stamp = (data.get("fetchedAt") or "")[:16]
    age = data.get("ageHours")
    fresh = "（数据是 %.0f 小时前抓的，可能不是最新）" % age if (age is not None and age >= 36) else ""

    if action == "recent":
        if not daily:
            return True, "还没有按天的记录（这个只能从开始抓的那天攒起）。库里最近打开的是《%s》。" % (
                games[0]["name"] if games else "（空）")
        lines = ["Steam 最近玩过（按天，数据抓取于 %s）%s：" % (stamp, fresh)]
        for x in daily[:7]:
            names = "、".join("%s %s" % (i.get("name") or "", _hm(i.get("minutes"))) for i in (x.get("items") or []))
            lines.append("- %s：%s（共 %s）" % (x.get("date"), names or "没玩", _hm(x.get("minutes"))))
        played = [g for g in games if g["minutes"] > 0]
        if played:
            g = played[0]
            lines.append("最近一次打开的是《%s》，%s，累计 %s。" % (
                g["name"], _nice_date_ts(g["last"]), _hm(g["minutes"])))
        return True, "\n".join(lines)

    if action == "summary":
        pc = data.get("price") or {}
        lines = ["Steam 总览（数据抓取于 %s）%s：" % (stamp, fresh),
                 "库里 %d 个游戏，玩过 %d 个，累计 %s。" % (s["games"], s["played"], _hm(s["totalMinutes"]))]
        if s["topTitle"]:
            lines.append("玩得最多的是《%s》（%s）。" % (s["topTitle"], _hm(s["topMinutes"])))
        if pc.get("initial"):
            lines.append("账号价值 %s（按当前原价合计，不等于实际花了这么多）。" % _yuan(pc["initial"]))
        if s["neverPlayed"]:
            lines.append("有 %d 个买了从没打开过。" % s["neverPlayed"])
        if s["monthMinutes"] or s["weekMinutes"]:
            lines.append("本月 %s，最近七天 %s。" % (_hm(s["monthMinutes"]), _hm(s["weekMinutes"])))
        lines.append("（按天、本月、最近七天都是靠每天抓一次攒出来的，从开始抓的那天才有的，不是历史全量。）")
        return True, "\n".join(lines)

    if action == "game":
        key = str(a.get("title") or "").strip()
        if not key:
            return False, "steam_play: action=game 需要 title（游戏名）"
        low = key.lower()
        hits = [g for g in games if low in g["name"].lower()
                or low in ((g.get("price") or {}).get("name") or "").lower()]
        if not hits:
            return True, "Steam 库里没有名字含「%s」的游戏。" % key
        g = hits[0]
        cn = (g.get("price") or {}).get("name") or ""
        title = g["name"] + ("（%s）" % cn if cn and cn != g["name"] else "")
        lines = ["《%s》：累计 %s，最近打开 %s。" % (
            title, _hm(g["minutes"]), _nice_date_ts(g["last"]) or "从没打开过")]
        if g["minutes2w"]:
            lines.append("最近两周玩了 %s。" % _hm(g["minutes2w"]))
        if g["deck"]:
            lines.append("其中 Steam Deck 上 %s。" % _hm(g["deck"]))
        p = g.get("price") or {}
        if p.get("isFree"):
            lines.append("这游戏是免费的。")
        elif p.get("initial"):
            if g["minutes"] > 0:
                lines.append("原价 %s，折合每小时 %s。" % (
                    _yuan(p["initial"]), "¥%.2f" % (p["initial"] / 100.0 / (g["minutes"] / 60.0))))
            else:
                lines.append("原价 %s，但一次都没玩过。" % _yuan(p["initial"]))
        # 史低来自 ITAD（国区人民币）—— 现价和史低是「值不值得等」那件事，别漏
        if p.get("low"):
            s = "史低 %s" % _yuan(p["low"])
            if p.get("lowAt"):
                s += "（%s" % p["lowAt"] + ("·%s）" % p["lowShop"] if p.get("lowShop") else "）")
            lines.append(s + "。")
            if p.get("final") and p["final"] <= p["low"]:
                lines.append("现在就是史低价。")
            elif p.get("final"):
                lines.append("现在 %s，离史低还差 %s。" % (
                    _yuan(p["final"]), _yuan(p["final"] - p["low"])))
        played = [x for x in daily if any(i.get("appid") == g["appid"] for i in (x.get("items") or []))]
        if played:
            lines.append("有按天记录的这些天：" + "、".join(
                "%s %s" % (x["date"], _hm(next(i["minutes"] for i in x["items"] if i.get("appid") == g["appid"])))
                for x in played[:7]))
        return True, "\n".join(lines)

    if action == "wishlist":
        w = (data.get("wishlist") or {}).get("items") or []
        if not w:
            return True, "Steam 愿望单是空的（或者没公开）。"
        # 离史低最近的排前面；没史低 / 没定价的沉底
        def _near(x):
            low, fin = x.get("low"), x.get("final")
            return (fin / low) if (low and fin) else 9e9
        w2 = sorted(w, key=_near)
        lines = ["Steam 愿望单 %d 个（价格抓于 %s）%s：" % (
            len(w), (data.get("wishlist") or {}).get("at") or "?", fresh)]
        for g in w2[:12]:
            nm = g.get("name") or ("appid %s" % g.get("appid"))
            if not g.get("final") and not g.get("initial"):
                lines.append("- 《%s》还没定价（多半还没发售）" % nm)
                continue
            s = _yuan(g["final"] or g["initial"])
            if g.get("discount"):
                s += "（-%d%%，原价 %s）" % (g["discount"], _yuan(g["initial"]))
            if g.get("low"):
                if g.get("final") and g["final"] <= g["low"]:
                    s += " —— 正好是史低"
                else:
                    s += " —— 史低 %s%s，贵 %.0f%%" % (
                        _yuan(g["low"]),
                        ("（%s）" % g["lowAt"]) if g.get("lowAt") else "",
                        (g["final"] - g["low"]) / g["low"] * 100.0)
            lines.append("- 《%s》%s" % (nm, s))
        cut = sum(1 for g in w if (g.get("discount") or 0) > 0)
        atlow = sum(1 for g in w if g.get("low") and g.get("final") and g["final"] <= g["low"])
        lines.append("其中 %d 个在打折、%d 个正好是史低。" % (cut, atlow))
        return True, "\n".join(lines)

    if action == "price":
        key = str(a.get("title") or "").strip()
        if not key:
            return False, "steam_play: action=price 需要 title（游戏名）"
        low = key.lower()
        w = (data.get("wishlist") or {}).get("items") or []
        # 库里和愿望单里一起找 —— 「这个多少钱」多半问的是还没买的
        cand = [(g, g.get("price") or {}, "库里") for g in games]
        cand += [(g, g, "愿望单") for g in w]
        hits = [c for c in cand if low in ((c[0].get("name") or "").lower())
                or low in ((c[1].get("name") or "").lower())]
        if not hits:
            return True, "Steam 库里和愿望单里都没有名字含「%s」的。" % key
        g, p, where = hits[0]
        lines = ["《%s》（在%s）：" % (g.get("name") or p.get("name") or key, where)]
        if p.get("isFree"):
            lines.append("免费的。")
        elif not p.get("initial") and not p.get("final"):
            lines.append("商店还没定价（多半还没发售）。")
        elif p.get("discount"):
            lines.append("现在 %s，原价 %s（-%d%%）。" % (
                _yuan(p["final"]), _yuan(p["initial"]), p["discount"]))
        else:
            lines.append("现在 %s，没在打折。" % _yuan(p.get("final") or p.get("initial")))
        if p.get("low"):
            lines.append("史低 %s（%s%s）。" % (
                _yuan(p["low"]), p.get("lowAt") or "不知道哪天",
                ("·" + p["lowShop"]) if p.get("lowShop") else ""))
            if p.get("final") and p["final"] <= p["low"]:
                lines.append("现在就是史低价，别等了。")
            elif p.get("final"):
                lines.append("离史低还差 %s（贵 %.0f%%）。" % (
                    _yuan(p["final"] - p["low"]), (p["final"] - p["low"]) / p["low"] * 100.0))
        if p.get("genres"):
            lines.append("分类：" + "、".join(p["genres"]))
        return True, "\n".join(lines)

    if action == "never":
        never = [g for g in games if g["minutes"] == 0]
        if not never:
            return True, "Steam 库里没有买了没玩的。"
        priced = sorted([g for g in never if (g.get("price") or {}).get("initial")],
                        key=lambda x: -x["price"]["initial"])
        lines = ["Steam 库里买了从没打开过的有 %d 个。" % len(never)]
        for g in priced[:10]:
            lines.append("- 《%s》%s" % (g["name"], _yuan(g["price"]["initial"])))
        if priced:
            lines.append("这些有价格的原价加起来 %s（不代表实际花了这么多）。" % _yuan(
                sum(g["price"]["initial"] for g in priced)))
        return True, "\n".join(lines)

    if action == "news":
        key = str(a.get("title") or "").strip()
        news = data.get("news") or {}
        if not news:
            return True, "还没有抓到官方更新（每天抓一次，只抓最近玩过的那批游戏）。"
        if key:
            low = key.lower()
            hits = [v for k, v in news.items() if low in (v.get("name") or "").lower() or low == k]
            if not hits:
                return True, "《%s》最近没有官方更新（也可能它不在最近玩过的那批里）。" % key
            lines = []
            for v in hits[:3]:
                lines.append("《%s》最近的官方更新：" % v["name"])
                for it in v["items"]:
                    lines.append("- %s（%s）\n  %s" % (it["title"], _nice_date_ts(it["date"]), it["url"]))
            return True, "\n".join(lines)
        lines = ["最近有官方更新的游戏（共 %d 个）：" % len(news)]
        for v in list(news.values())[:12]:
            it = (v.get("items") or [{}])[0]
            lines.append("- 《%s》%s：%s" % (v.get("name"), _nice_date_ts(it.get("date")), it.get("title")))
        return True, "\n".join(lines)

    return False, "steam_play: action 只能是 recent/summary/game/never/wishlist/price/news"


if __name__ == "__main__":
    # 单独跑的最小胶水：python3 server.py → http://127.0.0.1:5555/library.html
    # web/ 整个当静态目录伺服（index.html / library.html / assets/ 直接就能打开），
    # 蓝图挂上之后 /api/steam/history 与页面同源，不用再配跨域或反向代理。
    from flask import Flask, send_from_directory

    WEB_DIR = os.path.dirname(os.path.abspath(__file__))
    app = Flask(__name__, static_folder=WEB_DIR, static_url_path="")
    app.register_blueprint(steam_bp)

    @app.route("/")
    def _root():
        return send_from_directory(WEB_DIR, "index.html")

    # 端口：默认 5555，被占了就 `PORT=5556 python server.py`。
    # 只监听 127.0.0.1 —— 单独跑时没有鉴权，别往公网开。
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT") or 5555))
