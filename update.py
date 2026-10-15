"""update.py — 抓一次 Steam 库，落 latest.json + 每日快照 + 差分。

放在这个目录里，cron 每天跑一次。
凭证在 ~/.steam-api/（key + steamid，600），本文件只读、不打印。

为什么要每天抓：Steam 官方**不给按天明细**，只有累计时长。
「哪天玩了多久」只能靠两次抓取的 playtime_forever 差值算出来 —— 今天不抓，
这一段的时长就永远摊平进总数里了。同理「新入库了哪些游戏」靠 appid 集合差分。

抓失败**不覆盖**已有的 latest.json —— 宁可页面显示旧数据，也不要空壳。
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("STEAM_HISTORY_DIR") or HERE
LATEST = os.path.join(DATA, "latest.json")
SNAP_DIR = os.path.join(DATA, "snapshots")
DAILY = os.path.join(DATA, "daily.json")
CHANGES = os.path.join(DATA, "changes.json")
PRICES = os.path.join(DATA, "prices.json")
WISHLIST = os.path.join(DATA, "wishlist.json")
NEWS = os.path.join(DATA, "news.json")
CRED_DIR = os.path.expanduser("~/.steam-api")

API = "https://api.steampowered.com"
STORE = "https://store.steampowered.com/api/appdetails"
ITAD = "https://api.isthereanydeal.com"
ITAD_SHOP_STEAM = 61      # ITAD 里 Steam 店的编号
ITAD_BATCH = 200          # lookup / prices / historylow 一次最多收 200 个 id
ITAD_COUNTRY = "CN"
UA = "steam-history/1.0"
TIMEOUT = 30
# 抓取和「按天」都按北京时间算（写死是为了换机器不跑偏）
TZ = timezone(timedelta(hours=8))


def _cred(name, env):
    v = (os.environ.get(env) or "").strip()
    if v:
        return v
    with open(os.path.join(CRED_DIR, name), encoding="utf-8") as f:
        return f.read().strip()


def _get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def _read(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _write(path, obj):
    """原子写：先落 .tmp 再 replace，别让页面读到写了一半的文件。"""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def _norm(g):
    def n(k):
        try:
            return int(g.get(k) or 0)
        except (TypeError, ValueError):
            return 0

    return {
        "appid": n("appid"),
        "name": g.get("name") or "",
        "minutes": n("playtime_forever"),
        "minutes2w": n("playtime_2weeks"),
        "last": n("rtime_last_played"),
        "icon": g.get("img_icon_url") or "",
        "deck": n("playtime_deck_forever"),
        "win": n("playtime_windows_forever"),
        "mac": n("playtime_mac_forever"),
        "linux": n("playtime_linux_forever"),
        "offline": n("playtime_disconnected"),
        "stats": bool(g.get("has_community_visible_stats")),
    }


def _norm_player(p):
    def n(k):
        try:
            return int(p.get(k) or 0)
        except (TypeError, ValueError):
            return 0

    return {
        "name": p.get("personaname") or "",
        "avatar": p.get("avatarfull") or p.get("avatarmedium") or "",
        # 3 = 公开。1/2 时 GetOwnedGames 会返回空，页面该把这句话说出来
        "visibility": n("communityvisibilitystate"),
        "state": n("personastate"),
        "playing": p.get("gameextrainfo") or "",
        "playingAppId": n("gameid"),
        "lastLogoff": n("lastlogoff"),
    }


def _fetch(key, sid):
    owned = _get_json(API + "/IPlayerService/GetOwnedGames/v1/?" + urllib.parse.urlencode({
        "key": key, "steamid": sid, "include_appinfo": 1,
        "include_played_free_games": 1, "format": "json"}))
    games = (owned.get("response") or {}).get("games")
    if not isinstance(games, list):
        raise RuntimeError("GetOwnedGames 没给 games：%s" % json.dumps(owned, ensure_ascii=False)[:200])
    ps = _get_json(API + "/ISteamUser/GetPlayerSummaries/v2/?" + urllib.parse.urlencode({
        "key": key, "steamids": sid, "format": "json"}))
    players = (ps.get("response") or {}).get("players") or []
    return [_norm(g) for g in games], (_norm_player(players[0]) if players else {})


def _appdetails(appid):
    """商店页的当前价 + 类型 + 分类。查不到返回 None（下架 / 没有商店页）。

    价格单位是**分**，币种看 currency（带 cc=cn 时是 CNY）。
    免费游戏没有 price_overview ⇒ initial/final 都是 0，
    所以「免费」和「没查到」要靠 isFree 和 None 分开，别拿 0 当没价格。
    """
    try:
        d = _get_json(STORE + "?" + urllib.parse.urlencode({
            "appids": appid, "cc": "cn", "l": "schinese",
            "filters": "basic,price_overview,genres"}))
        data = (d.get(str(appid)) or {}).get("data") or {}
        if not data:
            return None
        po = data.get("price_overview") or {}
        # 封面。⚠️ 新游戏只在**新 CDN 路径**上有图（shared.akamai.steamstatic.com/
        # store_item_assets/steam/apps/<id>/<hash>/capsule_184x69.jpg），
        # 旧路径 cdn.cloudflare.steamstatic.com/steam/apps/<id>/capsule_184x69.jpg
        # 对它们是 404（实测：几个新上架的游戏四种尺寸全 404，免 hash 的新路径也 404）
        # —— 所以商店给什么就存什么，
        # 前端拿这个，没有才退回旧路径。capsule_imagev5 正好就是 184×69。
        cover = (data.get("capsule_imagev5") or data.get("capsule_image")
                 or data.get("header_image") or "")
        return {
            "name": data.get("name") or "",
            "type": data.get("type") or "",
            "isFree": bool(data.get("is_free")),
            "initial": int(po.get("initial") or 0),
            "final": int(po.get("final") or 0),
            "discount": int(po.get("discount_percent") or 0),
            "currency": po.get("currency") or "",
            "genres": [x.get("description") or "" for x in (data.get("genres") or [])],
            "cover": cover,
            "at": datetime.now(TZ).strftime("%Y-%m-%d"),
        }
    except Exception:
        return None


def _is_free(appid):
    """这游戏是不是免费。

    免费游戏（CS2 / Dota / Apex 这类）第一次打开就自动进库 —— 不查一下，
    「新增」就会被当成「新买的」。查不到返回 None：不知道就别乱判。
    """
    d = _appdetails(appid)
    return d["isFree"] if d else None


def _diff(old, new):
    o = {g["appid"]: g for g in old}
    n = {g["appid"]: g for g in new}
    added = [n[a] for a in n if a not in o]
    removed = [o[a] for a in o if a not in n]
    delta = []
    for a, g in n.items():
        if a in o and g["minutes"] > o[a]["minutes"]:
            delta.append({"appid": a, "name": g["name"], "minutes": g["minutes"] - o[a]["minutes"]})
    delta.sort(key=lambda x: -x["minutes"])
    return added, removed, delta


def _refresh_prices(games, limit=70):
    """轮转刷价格：挑最久没查过的 limit 个。

    整个库一天查完要几分钟，也没必要 —— 价格不是天天变。
    所以每天只刷一批（按 limit 轮），查过的记下日期，下次先挑最旧的。
    新入库的游戏没记录 ⇒ at 是空 ⇒ 自动排最前面，当天就查到。
    """
    prices = _read(PRICES, {}) or {}
    # 没封面的排最前面（False < True）—— 新游戏只有新 CDN 路径上有图，
    # 得从商店接口拿，所以别让它排在价格后面等三天
    order = sorted(games, key=lambda g: (
        bool(prices.get(str(g["appid"]), {}).get("cover")),
        prices.get(str(g["appid"]), {}).get("at") or "",
        g["appid"]))
    ok = 0
    for g in order[:limit]:
        d = _appdetails(g["appid"])
        if d is None:
            continue
        prices[str(g["appid"])] = d
        ok += 1
        time.sleep(1.2)  # 商店接口，慢一点别招人烦
    if ok:
        _write(PRICES, prices)
    return prices, ok


# ========================================================
# ITAD：原价 / 现价 / 史低（国区人民币）
#   - key 在 ~/.steam-api/itad（或 ITAD_API_KEY），没有就整段跳过
#   - 比 Steam 商店页那条路快两个数量级：整个库 4 次请求、几秒钟，
#     而且顺带给史低 —— Steam 自己不给这个
# ========================================================
def _cred_itad():
    try:
        return _cred("itad", "ITAD_API_KEY")
    except Exception:
        return ""


def _itad_post(key, path, body):
    """ITAD 的 POST。

    ⚠️ UA 必须带：默认的 Python-urllib 会被 Cloudflare 挡在门外
    （error code: 1010，长得像 403，很容易误判成 key 不对）。
    """
    req = urllib.request.Request(
        ITAD + path,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "ITAD-API-Key": key,
                 "User-Agent": UA},
        method="POST")
    with urllib.request.urlopen(req, timeout=TIMEOUT * 2) as r:
        return json.loads(r.read().decode("utf-8"))


def _fen(node):
    """ITAD 的价格节点 → 分。它自己给 amountInt（就是分），没有才拿 amount（元）换算。"""
    if not isinstance(node, dict):
        return None
    if node.get("amountInt") is not None:
        try:
            return int(node["amountInt"])
        except Exception:
            pass
    try:
        return int(round(float(node.get("amount")) * 100))
    except Exception:
        return None


def _refresh_itad(games, prices):
    """一次问完整个库的原价 / 现价 / 折扣 / 史低，写进 prices.json。

    没 key、没网、ITAD 抽风 —— 一律不拦主流程，原样返回。
    查到的游戏连 itadAt 一起记下来；没查到的（ITAD 库里没有这个 appid）
    下次照样会重试，因为只看 itad 字段在不在。
    """
    key = _cred_itad()
    if not key:
        return prices, 0
    try:
        appids = [g["appid"] for g in games]
        found = {}
        for i in range(0, len(appids), ITAD_BATCH):
            chunk = ["app/%d" % a for a in appids[i:i + ITAD_BATCH]]
            got = _itad_post(key, "/lookup/id/shop/%d/v1" % ITAD_SHOP_STEAM, chunk) or {}
            found.update({k: v for k, v in got.items() if v})
        if not found:
            return prices, 0

        # found 的 key 是 "app/413150" 这种，落盘只留数字那截
        by_id = {v: k.split("/")[-1] for k, v in found.items()}
        ids = list(by_id)
        price_q = "/games/prices/v3?" + urllib.parse.urlencode(
            {"country": ITAD_COUNTRY, "shops": ITAD_SHOP_STEAM})
        low_q = "/games/historylow/v1?" + urllib.parse.urlencode({"country": ITAD_COUNTRY})

        rows, lows = [], {}
        for i in range(0, len(ids), ITAD_BATCH):
            rows += _itad_post(key, price_q, ids[i:i + ITAD_BATCH]) or []
        for i in range(0, len(ids), ITAD_BATCH):
            for x in _itad_post(key, low_q, ids[i:i + ITAD_BATCH]) or []:
                lows[x.get("id")] = x.get("low") or {}

        today = datetime.now(TZ).strftime("%Y-%m-%d")
        ok = 0
        for row in rows:
            app = by_id.get(row.get("id"))
            if not app:
                continue
            e = prices.setdefault(app, {})
            e["itad"] = row["id"]
            e["itadAt"] = today

            hl = row.get("historyLow") or {}
            for src, dst in (("all", "low"), ("y1", "lowY1"), ("m3", "lowM3")):
                v = _fen(hl.get(src))
                if v is not None:
                    e[dst] = v
            lo = lows.get(row["id"]) or {}
            if lo.get("timestamp"):
                e["lowAt"] = str(lo["timestamp"])[:10]
            if (lo.get("shop") or {}).get("name"):
                e["lowShop"] = lo["shop"]["name"]

            deals = row.get("deals") or []
            if deals:
                d = deals[0]
                cur, reg = _fen(d.get("price")), _fen(d.get("regular"))
                if cur is not None or reg is not None:
                    e["final"] = cur or 0
                    e["initial"] = reg if reg else (cur or 0)
                    e["discount"] = int(d.get("cut") or 0)
                    e["currency"] = ((d.get("price") or {}).get("currency")
                                     or (d.get("regular") or {}).get("currency") or "CNY")
                if d.get("url"):
                    e["url"] = d["url"]
                sl = _fen(d.get("storeLow"))
                if sl is not None:
                    e["storeLow"] = sl
                e.pop("noDeal", None)
            else:
                # 没价格页（免费 / 下架）—— 标一下，别跟「没查过」混
                e["noDeal"] = True
            ok += 1
        _write(PRICES, prices)
        return prices, ok
    except Exception as e:
        print("ITAD 取价失败（不影响别的）：%s" % e)
        return prices, 0


def _fetch_profile(key, sid):
    """个人资料那几样：等级、主题、头像框、徽章、展柜。

    每样单独 try —— 有一个接口抽风，不该把整趟抓取带下水。
    """
    out = {}
    try:
        d = _get_json(API + "/IPlayerService/GetProfileCustomization/v1/?" + urllib.parse.urlencode(
            {"key": key, "steamid": sid, "include_showcases": 1}))
        r = d.get("response") or {}
        out["theme"] = r.get("profile_theme") or {}
        out["slotsAvailable"] = int(r.get("slots_available") or 0)
        out["showcases"] = [{
            "type": c.get("customization_type"),
            "style": c.get("customization_style"),
            "slots": [{"appid": s.get("appid"), "badgeid": s.get("badgeid")} for s in (c.get("slots") or [])],
        } for c in (r.get("customizations") or [])]
    except Exception as e:
        out["themeError"] = str(e)[:120]
    try:
        d = _get_json(API + "/IPlayerService/GetAvatarFrame/v1/?" + urllib.parse.urlencode(
            {"key": key, "steamid": sid}))
        f = (d.get("response") or {}).get("avatar_frame") or {}
        out["frame"] = {"name": f.get("name") or "", "title": f.get("item_title") or "",
                        "desc": f.get("item_description") or "", "small": f.get("image_small") or "",
                        "large": f.get("image_large") or "", "appid": int(f.get("appid") or 0)}
    except Exception as e:
        out["frameError"] = str(e)[:120]
    try:
        d = _get_json(API + "/IPlayerService/GetSteamLevel/v1/?" + urllib.parse.urlencode(
            {"key": key, "steamid": sid}))
        out["level"] = int((d.get("response") or {}).get("player_level") or 0)
    except Exception as e:
        out["levelError"] = str(e)[:120]
    try:
        d = _get_json(API + "/IPlayerService/GetBadges/v1/?" + urllib.parse.urlencode(
            {"key": key, "steamid": sid}))
        out["badges"] = [{
            "badgeid": int(b.get("badgeid") or 0), "appid": int(b.get("appid") or 0),
            "level": int(b.get("level") or 0), "xp": int(b.get("xp") or 0),
            "scarcity": int(b.get("scarcity") or 0), "border": b.get("border_color") or "",
            "at": int(b.get("completion_time") or 0),
        } for b in ((d.get("response") or {}).get("badges") or [])]
    except Exception as e:
        out["badgesError"] = str(e)[:120]
    return out


def _fetch_wishlist(key, sid):
    """愿望单：只有 appid 和加入日期，名字得另外问商店页。空 / 没公开就返回 []。"""
    d = _get_json(API + "/IWishlistService/GetWishlist/v1/?" + urllib.parse.urlencode(
        {"key": key, "steamid": sid}))
    return [{"appid": int(x.get("appid") or 0), "added": int(x.get("date_added") or 0)}
            for x in ((d.get("response") or {}).get("items") or []) if x.get("appid")]


def _refresh_wishlist(items, limit=80):
    """愿望单里的游戏：商店页给中文名 / 封面 / 原价，ITAD 给现价和史低。

    ⚠️ 单独存 wishlist.json，**不写进 prices.json** —— 那个文件被「账号价值」求和，
    把还没买的算进去，价值就虚高了。
    """
    if not items:
        return {"at": datetime.now(TZ).strftime("%Y-%m-%d"), "items": []}

    out = []
    for it in items[:limit]:
        e = {"appid": it["appid"], "added": it.get("added") or 0}
        d = _appdetails(it["appid"])
        if d:
            e.update({"name": d.get("name") or "", "cover": d.get("cover") or "",
                      "initial": d.get("initial") or 0, "final": d.get("final") or 0,
                      "discount": d.get("discount") or 0, "isFree": d.get("isFree"),
                      "genres": d.get("genres") or []})
        out.append(e)
        time.sleep(1.2)  # 商店接口，慢一点别招人烦

    key = _cred_itad()
    if key:
        try:
            appids = [e["appid"] for e in out]
            found = {}
            for i in range(0, len(appids), ITAD_BATCH):
                chunk = ["app/%d" % a for a in appids[i:i + ITAD_BATCH]]
                got = _itad_post(key, "/lookup/id/shop/%d/v1" % ITAD_SHOP_STEAM, chunk) or {}
                found.update({k: v for k, v in got.items() if v})
            by_id = {v: int(k.split("/")[-1]) for k, v in found.items()}
            ids = list(by_id)
            if ids:
                price_q = "/games/prices/v3?" + urllib.parse.urlencode(
                    {"country": ITAD_COUNTRY, "shops": ITAD_SHOP_STEAM})
                low_q = "/games/historylow/v1?" + urllib.parse.urlencode({"country": ITAD_COUNTRY})
                rows, lows = [], {}
                for i in range(0, len(ids), ITAD_BATCH):
                    rows += _itad_post(key, price_q, ids[i:i + ITAD_BATCH]) or []
                for i in range(0, len(ids), ITAD_BATCH):
                    for x in _itad_post(key, low_q, ids[i:i + ITAD_BATCH]) or []:
                        lows[x.get("id")] = x.get("low") or {}
                by_app = {e["appid"]: e for e in out}
                for row in rows:
                    e = by_app.get(by_id.get(row.get("id")))
                    if not e:
                        continue
                    v = _fen((row.get("historyLow") or {}).get("all"))
                    if v is not None:
                        e["low"] = v
                    v = _fen((row.get("historyLow") or {}).get("m3"))
                    if v is not None:
                        e["lowM3"] = v
                    lo = lows.get(row["id"]) or {}
                    if lo.get("timestamp"):
                        e["lowAt"] = str(lo["timestamp"])[:10]
                    if (lo.get("shop") or {}).get("name"):
                        e["lowShop"] = lo["shop"]["name"]
                    deals = row.get("deals") or []
                    if deals:
                        d = deals[0]
                        cur, reg = _fen(d.get("price")), _fen(d.get("regular"))
                        if cur is not None:
                            e["final"] = cur
                        if reg:
                            e["initial"] = reg
                        e["discount"] = int(d.get("cut") or 0)
                        if d.get("url"):
                            e["url"] = d["url"]
        except Exception as ex:
            print("愿望单取价失败（不影响别的）：%s" % ex)

    data = {"at": datetime.now(TZ).strftime("%Y-%m-%d"), "items": out}
    _write(WISHLIST, data)
    return data


# ========================================================
# 官方更新公告
# ========================================================
# Steam 把「厂商自己发的更新」和「外站转载的新闻」混在同一个 feed 里，靠 feedname 分：
# 等于 steam_community_announcements 的才是官方公告，其余（PC Gamer、RPS 这些）是媒体稿。
官方公告 = "steam_community_announcements"


def _fetch_news(games, limit=40, per=3):
    """抓最近玩过的那几十个游戏的官方更新。

    每个游戏要发一次请求，库里两百多个全问一遍太慢 —— 按最后游玩时间取前 limit 个。
    没有官方更新的游戏不占位置（媒体稿一律丢掉，不然一半是外站标题）。
    """
    最近 = sorted([g for g in games if g.get("last")], key=lambda g: g["last"], reverse=True)[:limit]
    out = {}
    for g in 最近:
        try:
            d = _get_json(API + "/ISteamNews/GetNewsForApp/v2/?" + urllib.parse.urlencode({
                "appid": g["appid"], "count": 20, "maxlength": 500, "format": "json"}))
        except Exception:
            continue      # 单个游戏问不到就跳过，不拦整趟
        items = [n for n in ((d.get("appnews") or {}).get("newsitems") or [])
                 if n.get("feedname") == 官方公告]
        if not items:
            continue
        out[str(g["appid"])] = {
            "name": g["name"],
            "items": [{
                "title": (n.get("title") or "").strip(),
                "date": n.get("date"),
                "url": "https://store.steampowered.com/news/app/%s/view/%s" % (g["appid"], n.get("gid")),
                "body": (n.get("contents") or "").strip()[:300],
            } for n in items[:per]],
        }
    return out


def main():
    try:
        key = _cred("key", "STEAM_API_KEY")
        sid = _cred("steamid", "STEAM_ID")
    except Exception as e:
        print("读不到凭证（~/.steam-api/key 与 steamid）：%s" % e)
        return 1
    if not key or not sid:
        print("凭证是空的：~/.steam-api/key 与 steamid，或 STEAM_API_KEY / STEAM_ID")
        return 1

    try:
        games, player = _fetch(key, sid)
    except Exception as e:
        print("抓取失败：%s" % e)
        return 1
    if not games:
        print("抓回来 0 个游戏（「游戏详情」不是公开？），没写盘")
        return 1

    os.makedirs(SNAP_DIR, exist_ok=True)
    now = datetime.now(TZ)
    today = now.strftime("%Y-%m-%d")
    yday = (now - timedelta(days=1)).strftime("%Y-%m-%d")

    old = _read(LATEST)
    old_games = (old or {}).get("games")
    # 头一次抓没有可比的对象 —— 只落基线，绝不把累计那几千小时全算成「昨天玩了」
    first = not isinstance(old_games, list) or not old_games

    added, removed, delta = ([], [], []) if first else _diff(old_games, games)

    _write(os.path.join(SNAP_DIR, today + ".json"),
           {"date": today, "fetchedAt": now.isoformat(), "player": player, "games": games})

    # 装扮和价格拿不到也不拦主流程 —— 各自失败各自空着
    profile = _fetch_profile(key, sid)
    # 先 Steam 商店页（慢，轮转：中文名 / 类型 / 分类），再 ITAD 全刷（快：价格 + 史低）
    prices, price_ok = _refresh_prices(games)
    prices, itad_ok = _refresh_itad(games, prices)

    # 愿望单：还没买的那些，配现价 + 史低（失败不拦主流程）
    try:
        _refresh_wishlist(_fetch_wishlist(key, sid))
    except Exception as e:
        print("愿望单抓取失败（不影响别的）：%s" % e)

    # 官方更新：只问最近玩过的那几十个（失败不拦主流程）
    try:
        news = _fetch_news(games)
        _write(NEWS, {"fetchedAt": now.isoformat(), "games": news})
        print("更新公告：%d 个游戏有" % len(news))
    except Exception as e:
        print("更新公告抓取失败（不影响别的）：%s" % e)
    valued = [p for p in prices.values() if p.get("initial")]
    lowed = [p for p in prices.values() if p.get("low")]
    price_summary = {
        "priced": len(valued),
        "unpriced": len(games) - len(valued),
        "initial": sum(p["initial"] for p in valued),
        "final": sum(p["final"] for p in valued),
        "currency": (valued[0].get("currency") if valued else "") or "CNY",
        "lowSum": sum(p["low"] for p in lowed),
        "lowCount": len(lowed),
    }

    if not first:
        # 增量归到「抓取时刻的昨天」：cron 在清晨跑，这一段游玩主要发生在昨天
        daily = _read(DAILY, []) or []
        daily = [d for d in daily if d.get("date") != yday]
        daily.append({"date": yday, "minutes": sum(d["minutes"] for d in delta), "items": delta})
        daily.sort(key=lambda d: d["date"], reverse=True)
        _write(DAILY, daily)

        changes = _read(CHANGES, {"added": [], "removed": []}) or {"added": [], "removed": []}
        seen = {e.get("appid") for e in changes.setdefault("added", [])}
        for g in added:
            if g["appid"] not in seen:
                changes["added"].append({"appid": g["appid"], "name": g["name"],
                                         "date": today, "free": _is_free(g["appid"])})
        for g in removed:
            changes.setdefault("removed", []).append(
                {"appid": g["appid"], "name": g["name"], "date": today})
        _write(CHANGES, changes)

    _write(LATEST, {
        "fetchedAt": now.isoformat(),
        "date": today,
        "first": first,
        "player": player,
        "summary": {
            "games": len(games),
            "played": sum(1 for g in games if g["minutes"] > 0),
            "totalMinutes": sum(g["minutes"] for g in games),
        },
        "delta": {"date": yday, "minutes": sum(d["minutes"] for d in delta), "items": delta},
        "added": [{"appid": g["appid"], "name": g["name"]} for g in added],
        "removed": [{"appid": g["appid"], "name": g["name"]} for g in removed],
        "profile": profile,
        "priceSummary": price_summary,
        "games": games,
    })

    tail = "（首次，只落基线，不算增量）" if first else "，新增 %d / 移除 %d / 昨日 %d 分" % (
        len(added), len(removed), sum(d["minutes"] for d in delta))
    print("ok: %d 个游戏%s，商店页刷了 %d 个（有价 %d / 未计价 %d），ITAD 刷了 %d 个"
          "（史低覆盖 %d 个，全按史低要 ¥%.0f）-> %s（快照 %s.json）" % (
              len(games), tail, price_ok, price_summary["priced"], price_summary["unpriced"],
              itad_ok, price_summary["lowCount"], price_summary["lowSum"] / 100, LATEST, today))
    return 0


if __name__ == "__main__":
    sys.exit(main())
