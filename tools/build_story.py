#!/usr/bin/env python3
"""剧本编译器 + 校验器。

用法：python3 tools/build_story.py [--redlines <file>] [--review <out.html>]
                                   [--story-dir <dir>] [--out <story.json>]
读取 story/*.txt（按文件名排序）和 story/props.txt、story/VERSION，写出 data/story.json。
--story-dir / --out 只给测试用（把别处的剧本编译到临时文件），默认值就是上面的路径。
只用 Python3 标准库。发现错误时以非零状态退出；警告只打印。

可达性：除了“从起点走不走得到”，还会检查每条 death 规则的数值沿剧情图能不能真的降到（升到）阈值；
到不了的规则给 WARN，没有别的入口的结局写进 story.json 的 unreachable（图鉴和总数不算它）。
"""
import argparse
import html
import json
import re
import sys
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

MODES = ("wide", "full", "text")
SCREENS = ("cinematic", "select", "news")
END_KINDS = ("death", "prologue", "if", "hidden")
END_KIND_NAMES = {"death": "作死", "prologue": "序章", "if": "IF·平行番外", "hidden": "隐藏"}
LINE_FIELDS = ("name", "team", "motto", "portrait", "meters", "init", "start", "death", "locked")
CARD_FIELDS = ("img", "mode", "who", "tag", "say", "sfx", "meet", "key", "fx", "if",
               "else", "next", "screen", "end", "title")
SAY_MAX = 60

FIELD_RE = re.compile(r"^(P【[^】]+】|[A-Za-z_]+)\s*[:：]\s*(.*)$")
TARGET_RE = re.compile(r"\s*->\s*(\S+)\s*$")
DEATH_RE = re.compile(r"^(.+?)(<=|>=|==|<|>)(-?\d+)\s+(\S+)$")


class Report:
    def __init__(self):
        self.errors = []
        self.warnings = []

    def err(self, where, msg):
        self.errors.append("%s: %s" % (where, msg))

    def warn(self, where, msg):
        self.warnings.append("%s: %s" % (where, msg))


# ---------------------------------------------------------------- 解析 ----

def parse_effect_tokens(text, where, rep):
    out = []
    for tok in text.split():
        m = re.match(r"^([+-])【(.+)】$", tok)
        if m:
            out.append({"t": "p", "o": m.group(1), "n": m.group(2)})
            continue
        m = re.match(r"^([+-])\{\{(.+)\}\}$", tok)
        if m:
            out.append({"t": "g", "o": m.group(1), "n": m.group(2)})
            continue
        m = re.match(r"^([+-])\{(.+)\}$", tok)
        if m:
            out.append({"t": "f", "o": m.group(1), "n": m.group(2)})
            continue
        m = re.match(r"^(.+?)([+\-=])(\d+)$", tok)
        if m:
            out.append({"t": "m", "n": m.group(1), "o": m.group(2), "v": int(m.group(3))})
            continue
        rep.err(where, "无法解析的效果 token：%r" % tok)
    return out


def parse_cond_tokens(text, where, rep):
    out = []
    for tok in text.split():
        m = re.match(r"^(!?)【(.+)】$", tok)
        if m:
            out.append({"t": "p", "n": m.group(2), "neg": bool(m.group(1))})
            continue
        m = re.match(r"^(!?)\{\{(.+)\}\}$", tok)
        if m:
            out.append({"t": "g", "n": m.group(2), "neg": bool(m.group(1))})
            continue
        m = re.match(r"^(!?)\{(.+)\}$", tok)
        if m:
            out.append({"t": "f", "n": m.group(2), "neg": bool(m.group(1))})
            continue
        m = re.match(r"^(.+?)(>=|<=|==|>|<)(-?\d+)$", tok)
        if m:
            out.append({"t": "m", "n": m.group(1), "o": m.group(2), "v": int(m.group(3))})
            continue
        rep.err(where, "无法解析的条件 token：%r" % tok)
    return out


def parse_option(val, where, rep):
    """'标签 | 效果… | -> 目标' 或 '标签 -> 目标'。目标缺省为 None。"""
    to = None
    m = TARGET_RE.search(val)
    if m:
        to = m.group(1)
        val = val[:m.start()]
    parts = [p.strip() for p in val.split("|")]
    while parts and parts[-1] == "":
        parts.pop()
    if not parts or not parts[0]:
        rep.err(where, "选项缺少标签")
        return {"t": "?", "fx": [], "to": to}
    if len(parts) > 2:
        rep.err(where, "选项最多 标签|效果|-> 目标 三段")
    fx = parse_effect_tokens(parts[1], where, rep) if len(parts) > 1 else []
    return {"t": parts[0], "fx": fx, "to": to}


def strip_inline_comment(v):
    return re.sub(r"\s+#.*$", "", v).strip()


def parse_file(path, rep, story):
    """把一个剧本文件解析进 story = {lines, cards, file_cards}。"""
    fname = path.name
    cur_line = None
    cur_card = None
    last_field = None
    file_cards = []
    lines_here = []
    text = path.read_text(encoding="utf-8")
    for no, raw in enumerate(text.splitlines(), 1):
        where = "%s:%d" % (fname, no)
        s = raw.rstrip()
        st = s.strip()
        if not st or st.startswith("#"):
            continue
        if raw.startswith("  ") and cur_card is not None and last_field == "say":
            cur_card["_say"].append(st)
            continue
        if st.startswith("@line"):
            lid = st[5:].strip()
            if not lid:
                rep.err(where, "@line 缺少 id")
                continue
            if lid in story["lines"]:
                rep.err(where, "线 id 重复：%s" % lid)
            cur_line = {"id": lid, "name": lid, "team": "", "motto": "", "portrait": "",
                        "meters": [], "init": [], "start": None, "deaths": [], "locked": False,
                        "_file": fname, "_no": no}
            story["lines"][lid] = cur_line
            lines_here.append(lid)
            cur_card = None
            last_field = None
            continue
        if st.startswith("=="):
            cid = st[2:].strip()
            if cur_line is None:
                rep.err(where, "卡片出现在任何 @line 之前")
                continue
            if not cid:
                rep.err(where, "== 缺少卡片 id")
                continue
            if cid in story["cards"]:
                rep.err(where, "卡片 id 重复：%s" % cid)
            cur_card = {"id": cid, "ln": cur_line["id"], "mode": "wide", "_say": [],
                        "L": None, "R": None, "P": [], "fx": [], "_file": fname, "_no": no,
                        "_has": set()}
            story["cards"][cid] = cur_card
            file_cards.append(cur_card)
            last_field = None
            continue
        m = FIELD_RE.match(s)
        if not m:
            rep.err(where, "无法识别的行：%r" % st[:40])
            continue
        field, val = m.group(1), m.group(2).strip()
        last_field = field
        if cur_card is None:
            if cur_line is None:
                rep.err(where, "字段出现在 @line 之前")
                continue
            if field not in LINE_FIELDS:
                rep.err(where, "线头里有未知字段：%s" % field)
                continue
            val = strip_inline_comment(val)
            if field == "meters":
                cur_line["meters"] = val.split()
            elif field == "init":
                try:
                    cur_line["init"] = [int(x) for x in val.split()]
                except ValueError:
                    rep.err(where, "init 必须是整数")
            elif field == "death":
                dm = DEATH_RE.match(val)
                if not dm:
                    rep.err(where, "death 格式应为 '数值名<=0 结局id'")
                else:
                    cur_line["deaths"].append({"meter": dm.group(1), "op": dm.group(2),
                                               "val": int(dm.group(3)), "end": dm.group(4),
                                               "_no": no})
            elif field == "locked":
                cur_line["locked"] = val.lower() == "true"
            else:
                cur_line[field] = val
            continue
        # 卡片字段
        c = cur_card
        c["_has"].add(field)
        if field.startswith("P【"):
            prop = field[2:-1]
            opt = parse_option(val, where, rep)
            opt["p"] = prop
            c["P"].append(opt)
        elif field in ("L", "R"):
            if c[field] is not None:
                rep.err(where, "重复的 %s 选项" % field)
            c[field] = parse_option(val, where, rep)
        elif field == "say":
            c["_say"] = [val]
        elif field == "fx":
            c["fx"] = c["fx"] + parse_effect_tokens(val, where, rep)
        elif field == "if":
            c["if"] = parse_cond_tokens(val, where, rep)
        elif field in CARD_FIELDS:
            if field == "mode" and val not in MODES:
                rep.err(where, "mode 必须是 %s" % "|".join(MODES))
            if field == "screen" and val not in SCREENS:
                rep.err(where, "screen 必须是 %s" % "|".join(SCREENS))
            if field == "end" and val not in END_KINDS:
                rep.err(where, "end 必须是 %s" % "|".join(END_KINDS))
            c[field] = val
        else:
            rep.err(where, "未知卡片字段：%s" % field)
    # 默认 next：文件里的下一张卡
    for i, c in enumerate(file_cards):
        c["_filenext"] = file_cards[i + 1]["id"] if i + 1 < len(file_cards) else None
    story["file_order"].extend(file_cards)


def parse_props(path, rep):
    props = {}
    if not path.exists():
        return props
    for no, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        st = raw.strip()
        if not st or st.startswith("#"):
            continue
        m = re.match(r"^【(.+?)】\s*[:：]\s*(.*)$", st)
        if not m:
            rep.err("props.txt:%d" % no, "格式应为 【道具名】: 说明")
            continue
        props[m.group(1)] = m.group(2)
    return props


# ---------------------------------------------------------------- 编译 ----

def finalize(story, rep):
    cards = story["cards"]
    lines = story["lines"]
    for c in cards.values():
        where = "%s:%d(%s)" % (c["_file"], c["_no"], c["id"])
        line = lines[c["ln"]]
        c["say"] = "\n".join(c.pop("_say"))
        has = c.pop("_has")
        fnext = c.pop("_filenext")
        if c.get("end"):
            c["end"] = {"kind": c["end"], "title": c.get("title", "")}
            if not c["end"]["title"]:
                rep.err(where, "结局卡缺少 title")
            c.pop("title", None)
        else:
            c.pop("title", None)
            c.pop("end", None)
        # 默认出路
        is_end = "end" in c
        if not is_end:
            if c.get("screen") == "select":
                pass
            elif c["L"] or c["R"] or c["P"] or c.get("next"):
                for o in (c["L"], c["R"]):
                    if o and not o["to"]:
                        o["to"] = fnext
                for o in c["P"]:
                    if not o["to"]:
                        o["to"] = fnext
                if (c["L"] or c["R"]) and not (c["L"] and c["R"]):
                    rep.warn(where, "只有一侧选项（L/R 应成对）")
                if (c["L"] or c["R"] or c["P"]) and c.get("next"):
                    rep.warn(where, "同时写了选项和 next，next 被忽略")
            else:
                c["next"] = fnext
            if "else" not in c and c.get("if"):
                c["else"] = fnext
        # 进一步校验目标 ln
        if c.get("screen") == "cinematic":
            frames = []
            for ln in c["say"].split("\n"):
                if not ln.strip():
                    continue
                if "|" in ln:
                    img, cap = ln.split("|", 1)
                else:
                    img, cap = ln, ""
                frames.append({"img": img.strip(), "cap": cap.strip()})
            if not frames:
                rep.err(where, "cinematic 卡的 say 里至少要有一行 img|字幕")
            c["frames"] = frames
            c["say"] = ""
        # 数值名
        meters = set(line["meters"])
        def chk_fx(fxs, ctx):
            for e in fxs:
                if e["t"] == "m" and e["n"] not in meters:
                    rep.err(where, "%s 里的数值名 %r 不在线 %s 的 meters 里" % (ctx, e["n"], line["id"]))
        chk_fx(c["fx"], "fx")
        for side in ("L", "R"):
            if c[side]:
                chk_fx(c[side]["fx"], side)
        for o in c["P"]:
            chk_fx(o["fx"], "P【%s】" % o["p"])
        for cond in c.get("if", []):
            if cond["t"] == "m" and cond["n"] not in meters:
                rep.err(where, "条件里的数值名 %r 不在线 %s 的 meters 里" % (cond["n"], line["id"]))
        # 清理空字段
        if not c["L"]:
            c.pop("L")
        if not c["R"]:
            c.pop("R")
        if not c["P"]:
            c.pop("P")
        if not c["fx"]:
            c.pop("fx")
        for k in ("img", "who", "tag", "say", "sfx", "meet", "key"):
            if k in c and c[k] == "":
                c.pop(k)
        for k in list(c):
            if k.startswith("_"):
                c.pop(k)


def validate(story, props, rep, redlines):
    cards, lines = story["cards"], story["lines"]

    def target_ok(where, tid, what):
        if tid is None:
            rep.err(where, "%s 没有目标" % what)
        elif tid not in cards:
            rep.err(where, "%s 的目标卡不存在：%s" % (what, tid))

    for c in cards.values():
        where = "card %s" % c["id"]
        if "end" in c:
            continue
        if c.get("screen") == "select":
            continue
        for side in ("L", "R"):
            if side in c:
                target_ok(where, c[side]["to"], side)
        for o in c.get("P", []):
            target_ok(where, o["to"], "P【%s】" % o["p"])
        if "L" not in c and "R" not in c:
            if c.get("next"):
                target_ok(where, c.get("next"), "next")
            else:
                rep.err(where, "非结局卡没有出路")
        if c.get("if") and c.get("else") is not None and c["else"] not in cards:
            rep.err(where, "else 目标卡不存在：%s" % c["else"])
    for lid, ln in lines.items():
        where = "line %s" % lid
        if lid != "common" and len(ln["meters"]) != 4:
            rep.err(where, "meters 必须恰好 4 个（现在 %d 个）" % len(ln["meters"]))
        if lid == "common" and ln["meters"]:
            rep.warn(where, "common 线不使用 meters")
        if ln["meters"] and len(ln["init"]) != len(ln["meters"]):
            rep.err(where, "init 个数与 meters 不一致")
        if not ln["start"] or ln["start"] not in cards:
            rep.err(where, "start 不存在：%s" % ln["start"])
        for d in ln["deaths"]:
            if d["meter"] not in ln["meters"]:
                rep.err(where, "death 里的数值名 %r 不在 meters 里" % d["meter"])
            if d["end"] not in cards or "end" not in cards.get(d["end"], {}):
                rep.err(where, "death 规则引用的结局不存在：%s" % d["end"])
        if lid != "common" and not ln["name"]:
            rep.err(where, "缺少 name")

    # 道具
    for c in cards.values():
        fxs = list(c.get("fx", []))
        for side in ("L", "R"):
            if side in c:
                fxs += c[side]["fx"]
        for o in c.get("P", []):
            fxs += o["fx"]
            if o["p"] not in props:
                rep.warn("card %s" % c["id"], "道具 【%s】 没有说明（props.txt）" % o["p"])
        for e in fxs:
            if e["t"] == "p" and e["n"] not in props:
                rep.warn("card %s" % c["id"], "道具 【%s】 没有说明（props.txt）" % e["n"])

    # 素材
    def has_img(key):
        return (ROOT / "assets" / "img" / (key + ".webp")).exists()

    def has_sfx(key):
        return (ROOT / "assets" / "sfx" / (key + ".mp3")).exists()

    for c in cards.values():
        where = "card %s" % c["id"]
        if c.get("img") and not has_img(c["img"]):
            rep.warn(where, "缺少图片 assets/img/%s.webp" % c["img"])
        if c.get("sfx") and not has_sfx(c["sfx"]):
            rep.warn(where, "缺少音频 assets/sfx/%s.mp3" % c["sfx"])
        for f in c.get("frames", []):
            if not has_img(f["img"]):
                rep.warn(where, "缺少图片 assets/img/%s.webp" % f["img"])
        if len(c.get("say", "").replace("\n", "")) > SAY_MAX:
            rep.warn(where, "say 超过 %d 字" % SAY_MAX)
    for lid, ln in lines.items():
        if ln["portrait"] and not has_img(ln["portrait"]):
            rep.warn("line %s" % lid, "缺少立绘 assets/img/%s.webp" % ln["portrait"])

    # 红线词
    if redlines:
        for c in cards.values():
            texts = [c.get("say", ""), c.get("tag", ""), c.get("who", ""),
                     c.get("end", {}).get("title", "") if "end" in c else ""]
            for side in ("L", "R"):
                if side in c:
                    texts.append(c[side]["t"])
            for o in c.get("P", []):
                texts.append(o["t"])
            for f in c.get("frames", []):
                texts.append(f["cap"])
            blob = "\n".join(texts)
            for w in redlines:
                if w in blob:
                    rep.warn("card %s" % c["id"], "命中红线词 %r" % w)
        for lid, ln in lines.items():
            blob = ln["name"] + ln["team"] + ln["motto"]
            for w in redlines:
                if w in blob:
                    rep.warn("line %s" % lid, "命中红线词 %r" % w)


# ---------------------------------------------------------------- 图 ----

def _clamp(v):
    return 0 if v < 0 else 100 if v > 100 else v


def _cmp(a, op, b):
    return {"<=": a <= b, ">=": a >= b, "<": a < b, ">": a > b, "==": a == b}.get(op, False)


def _apply_meter(fxs, name, v):
    for e in fxs:
        if e["t"] == "m" and e["n"] == name:
            v = _clamp(e["v"] if e["o"] == "=" else v + e["v"] if e["o"] == "+" else v - e["v"])
    return v


def death_reach(cards, line):
    """每条 death 规则在这条线上能不能真的被触发：{结局id: (能否, 沿途最危险的数值)}。

    把单个数值沿剧情图（L/R/道具选项/next/else）走一遍，状态 = (卡, 数值)，带 0..100 的截断。
    忽略 if、道具、旗标条件，所以是“过近似”：算出到不了就一定到不了（玩家永远看不到这个结局）；
    算出能到，不保证已经有一条具体路线。结果缓存在 line['_dr']（不写进 story.json）。
    """
    cache = line.get("_dr")
    if cache is not None:
        return cache
    out = {}
    for d in line["deaths"]:
        meters = line["meters"]
        if d["meter"] not in meters:
            out[d["end"]] = (False, None)
            continue
        i = meters.index(d["meter"])
        v0 = _clamp(line["init"][i]) if i < len(line["init"]) else 50
        down = d["op"] in ("<=", "<")
        extreme = [v0]
        hit = [False]
        seen = set()
        stack = []

        def note(v):
            extreme[0] = min(extreme[0], v) if down else max(extreme[0], v)

        def enter(cid, v, depth=0):
            c = cards.get(cid)
            if c is None or depth > 30:
                return
            if c.get("if") and c.get("else"):
                enter(c["else"], v, depth + 1)      # 条件不满足：直接去 else，不套用本卡 fx
            v2 = _apply_meter(c.get("fx", []), d["meter"], v)
            note(v2)
            if "end" in c:
                return                              # 结局卡进入时不再查死亡（与引擎一致）
            if _cmp(v2, d["op"], d["val"]):
                hit[0] = True
                return
            if (cid, v2) not in seen:
                seen.add((cid, v2))
                stack.append((cid, v2))

        enter(line["start"], v0)
        while stack and not hit[0]:
            cid, v = stack.pop()
            c = cards[cid]
            if "L" in c or "R" in c:
                opts = [c[s] for s in ("L", "R") if s in c] + list(c.get("P", []))
            elif c.get("next"):
                opts = [{"fx": [], "to": c["next"]}]
            else:
                opts = []
            for o in opts:
                v2 = _apply_meter(o["fx"], d["meter"], v)
                note(v2)
                if _cmp(v2, d["op"], d["val"]):     # 引擎在选项效果之后、进下一张卡之前先查死亡
                    hit[0] = True
                    break
                if o["to"]:
                    enter(o["to"], v2)
        out[d["end"]] = (hit[0], extreme[0])
    line["_dr"] = out
    return out


def death_edges(card, line, cards):
    """某张卡若会把死亡相关数值推向阈值方向，且这条死亡规则真的能被触发（death_reach），
    就认为它可通向对应死亡结局。数值最低只能降到 40 的线上，“家底<=0”不会产生任何入边。"""
    out = []
    if "end" in card:
        return out
    effects = list(card.get("fx", []))
    for side in ("L", "R"):
        if side in card:
            effects += card[side]["fx"]
    for o in card.get("P", []):
        effects += o["fx"]
    reach = death_reach(cards, line)
    for d in line["deaths"]:
        if not reach.get(d["end"], (False, None))[0]:
            continue
        for e in effects:
            if e["t"] != "m" or e["n"] != d["meter"]:
                continue
            down = d["op"] in ("<=", "<")
            if e["o"] == "=" or (e["o"] == "-" and down) or (e["o"] == "+" and not down):
                out.append(d["end"])
                break
    return out


def succ(card, story, with_death=True, with_select=True):
    cards = story["cards"]
    out = []
    if card.get("else"):
        out.append(card["else"])
    for side in ("L", "R"):
        if side in card and card[side]["to"]:
            out.append(card[side]["to"])
    for o in card.get("P", []):
        if o["to"]:
            out.append(o["to"])
    if card.get("next"):
        out.append(card["next"])
    if with_death:
        out += death_edges(card, story["lines"][card["ln"]], cards)
    if with_select and card.get("screen") == "select":
        for lid in story["order"]:
            out.append(story["lines"][lid]["start"])
    seen = set()
    res = []
    for t in out:
        if t in cards and t not in seen:
            seen.add(t)
            res.append(t)
    return res


def reach_from(story, roots, **kw):
    cards = story["cards"]
    seen = set()
    dq = deque(r for r in roots if r in cards)
    seen.update(dq)
    while dq:
        cid = dq.popleft()
        for t in succ(cards[cid], story, **kw):
            if t not in seen:
                seen.add(t)
                dq.append(t)
    return seen


def line_stats(story, lid):
    cards = story["cards"]
    ln = story["lines"][lid]
    start = ln["start"]
    if start not in cards:
        return None
    adj = {}

    def edges(cid):
        if cid not in adj:
            adj[cid] = succ(cards[cid], story, with_select=False)
        return adj[cid]

    reach = reach_from(story, [start], with_select=False)
    ends = [cid for cid in reach if "end" in cards[cid]]
    # 最短：BFS
    dist = {start: 1}
    dq = deque([start])
    while dq:
        cid = dq.popleft()
        for t in edges(cid):
            if t not in dist:
                dist[t] = dist[cid] + 1
                dq.append(t)
    # 去掉回边得到 DAG
    state = {}
    dag = {}
    sys.setrecursionlimit(10000)
    cyc = [0]

    def dfs(u):
        state[u] = 1
        dag[u] = []
        for t in edges(u):
            if state.get(t) == 1:
                cyc[0] += 1
                continue
            dag[u].append(t)
            if t not in state:
                dfs(t)
        state[u] = 2
    dfs(start)

    result = {}
    for target in ends:
        memo = {}

        def f(u):
            if u in memo:
                return memo[u]
            if u == target:
                r = (1, 1, 1)
            elif "end" in cards[u]:
                r = (0, 0, 0)
            else:
                cnt = tot = mx = 0
                for t in dag.get(u, []):
                    c2, s2, m2 = f(t)
                    if c2:
                        cnt += c2
                        tot += s2 + c2
                        mx = max(mx, m2 + 1)
                r = (cnt, tot, mx)
            memo[u] = r
            return r
        cnt, tot, mx = f(start)
        result[target] = {"min": dist.get(target), "max": mx if cnt else dist.get(target),
                          "avg": (tot / cnt) if cnt else float(dist.get(target, 0)),
                          "paths": cnt}
    return {"reach": reach, "ends": ends, "per_end": result, "cycles": cyc[0]}


def print_stats(story):
    cards = story["cards"]
    out = []
    for lid in ["common"] + story["order"]:
        if lid not in story["lines"]:
            continue
        ln = story["lines"][lid]
        st = line_stats(story, lid)
        total_cards = sum(1 for c in cards.values() if c["ln"] == lid)
        if st is None:
            out.append("[%s] (起点缺失)" % lid)
            continue
        by_kind = {}
        for e in st["ends"]:
            by_kind.setdefault(cards[e]["end"]["kind"], []).append(e)
        kinds = "  ".join("%s=%d" % (k, len(by_kind[k])) for k in END_KINDS if k in by_kind)
        in_line = sum(1 for cid in st["reach"] if cards[cid]["ln"] == lid)
        lock = " [locked]" if ln["locked"] else ""
        out.append("[%s] %s%s  cards %d/%d reachable  ends: %d  (%s)%s" % (
            lid, ln["name"], lock, in_line, total_cards, len(st["ends"]), kinds or "-",
            "  cycles dropped: %d" % st["cycles"] if st["cycles"] else ""))
        for e in sorted(st["ends"], key=lambda x: st["per_end"][x]["min"] or 0):
            p = st["per_end"][e]
            out.append("    %-18s %-9s shortest=%s longest=%s avg=%.1f (paths=%s)" % (
                e, cards[e]["end"]["kind"], p["min"], p["max"], p["avg"], p["paths"]))
    return out


# ---------------------------------------------------------------- 审阅稿 ----

def fx_text(fxs):
    parts = []
    for e in fxs:
        if e["t"] == "m":
            parts.append("%s%s%d" % (e["n"], e["o"], e["v"]))
        elif e["t"] == "p":
            parts.append("%s【%s】" % (e["o"], e["n"]))
        elif e["t"] == "f":
            parts.append("%s{%s}" % (e["o"], e["n"]))
        elif e["t"] == "g":
            parts.append("%s{{%s}}" % (e["o"], e["n"]))
    return " ".join(parts)


def cond_text(conds):
    parts = []
    for e in conds:
        if e["t"] == "m":
            parts.append("%s%s%d" % (e["n"], e["o"], e["v"]))
        else:
            neg = "!" if e.get("neg") else ""
            br = {"p": "【%s】", "f": "{%s}", "g": "{{%s}}"}[e["t"]] % e["n"]
            parts.append(neg + br)
    return " ".join(parts)


REVIEW_CSS = """
body{font:16px/1.6 -apple-system,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif;
max-width:720px;margin:0 auto;padding:12px;background:#15131a;color:#eee}
a{color:#ff7ab8}h1{font-size:20px}h2{font-size:18px;border-bottom:1px solid #444;padding-bottom:4px;margin-top:28px}
pre{background:#222;padding:8px;border-radius:6px;overflow:auto;font-size:12px;white-space:pre-wrap}
.card{background:#211e29;border-radius:10px;padding:10px 12px;margin:10px 0;border-left:4px solid #666}
.card.end{border-left-color:#f5c542}.card.death{border-left-color:#e5484d}
.card.if{border-left-color:#4a90e2}.card.hidden{border-left-color:#9b59b6}
.id{font:12px monospace;color:#9aa}.tag{color:#ff4fa3;font-weight:bold}
.who{color:#f5c542}.say{white-space:pre-wrap}.opt{margin:4px 0 0 12px;font-size:14px}
.meta{font-size:12px;color:#aaa}.badge{font-size:12px;padding:1px 6px;border-radius:8px;background:#444;margin-left:6px}
"""


def build_review(story, stats_lines, warnings, out_path):
    cards = story["cards"]
    esc = html.escape

    def anchor(cid):
        return "c-" + re.sub(r"[^A-Za-z0-9_-]", "_", cid)

    def link(cid):
        if cid in cards:
            return '<a href="#%s">%s</a>' % (anchor(cid), esc(cid))
        return esc(str(cid))

    h = ["<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>",
         "<meta name='viewport' content='width=device-width,initial-scale=1'>",
         "<title>剧本审阅稿</title><style>%s</style></head><body>" % REVIEW_CSS,
         "<h1>《撸城：谁是世一上》剧本审阅稿</h1>",
         "<div class='meta'>version %s · built %s · 共 %d 张卡</div>" % (
             esc(story["version"]), esc(story["built"]), len(cards)),
         "<h2>统计</h2><pre>%s</pre>" % esc("\n".join(stats_lines))]
    if warnings:
        h.append("<h2>警告 (%d)</h2><pre>%s</pre>" % (len(warnings), esc("\n".join(warnings))))
    h.append("<p>目录：" + " ".join(
        "<a href='#line-%s'>%s</a>" % (esc(l), esc(story["lines"][l]["name"]))
        for l in ["common"] + story["order"] if l in story["lines"]) + "</p>")
    for lid in ["common"] + story["order"]:
        if lid not in story["lines"]:
            continue
        ln = story["lines"][lid]
        h.append("<h2 id='line-%s'>%s <span class='id'>%s</span>%s</h2>" % (
            esc(lid), esc(ln["name"]), esc(lid), "<span class='badge'>未解锁</span>" if ln["locked"] else ""))
        if lid != "common":
            h.append("<div class='meta'>阵营：%s · 标语：%s<br>数值：%s · 初始：%s<br>死亡规则：%s</div>" % (
                esc(ln["team"]), esc(ln["motto"]), esc(" ".join(ln["meters"])),
                esc(" ".join(str(x) for x in ln["init"])),
                esc("；".join("%s%s%d → %s" % (d["meter"], d["op"], d["val"], d["end"])
                              for d in ln["deaths"]) or "无")))
        for c in cards.values():
            if c["ln"] != lid:
                continue
            cls = "card"
            if "end" in c:
                cls += " end " + c["end"]["kind"]
            h.append("<div class='%s' id='%s'>" % (cls, anchor(c["id"])))
            head = "<span class='id'>%s</span>" % esc(c["id"])
            if "end" in c:
                head += "<span class='badge'>结局·%s</span>" % esc(END_KIND_NAMES[c["end"]["kind"]])
            if c.get("screen"):
                head += "<span class='badge'>屏·%s</span>" % esc(c["screen"])
            if c.get("meet"):
                head += "<span class='badge'>相遇：%s</span>" % esc(c["meet"])
            if c.get("key"):
                head += "<span class='badge'>关键：%s</span>" % esc(c["key"])
            h.append("<div>%s</div>" % head)
            if c.get("if"):
                h.append("<div class='meta'>条件：%s → 否则 %s</div>" % (esc(cond_text(c["if"])), link(c.get("else"))))
            if "end" in c:
                h.append("<div><b>%s</b></div>" % esc(c["end"]["title"]))
            if c.get("tag"):
                h.append("<div class='tag'>%s</div>" % esc(c["tag"]))
            if c.get("who"):
                h.append("<div class='who'>%s</div>" % esc(c["who"]))
            if c.get("say"):
                h.append("<div class='say'>%s</div>" % esc(c["say"]))
            for f in c.get("frames", []):
                h.append("<div class='say'>[画面 %s] %s</div>" % (esc(f["img"]), esc(f["cap"])))
            meta = []
            if c.get("img"):
                meta.append("img=" + c["img"])
            if c.get("sfx"):
                meta.append("sfx=" + c["sfx"])
            meta.append("mode=" + c["mode"])
            if c.get("fx"):
                meta.append("进卡效果：" + fx_text(c["fx"]))
            h.append("<div class='meta'>%s</div>" % esc(" · ".join(meta)))
            for side, nm in (("L", "← 左"), ("R", "→ 右")):
                if side in c:
                    o = c[side]
                    h.append("<div class='opt'>%s <b>%s</b> <span class='meta'>%s</span> → %s</div>" % (
                        nm, esc(o["t"]), esc(fx_text(o["fx"])), link(o["to"])))
            for o in c.get("P", []):
                h.append("<div class='opt'>道具【%s】 <b>%s</b> <span class='meta'>%s</span> → %s</div>" % (
                    esc(o["p"]), esc(o["t"]), esc(fx_text(o["fx"])), link(o["to"])))
            if c.get("next") and "L" not in c and "R" not in c:
                h.append("<div class='opt'>继续 → %s</div>" % link(c["next"]))
            h.append("</div>")
    h.append("</body></html>")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(h), encoding="utf-8")


# ---------------------------------------------------------------- 主程序 ----

def main():
    ap = argparse.ArgumentParser(description="剧本编译器")
    ap.add_argument("--redlines", help="红线词文件，一行一个词（放在仓库外）")
    ap.add_argument("--review", nargs="?", const="__default__", help="输出审阅稿 HTML 的路径")
    ap.add_argument("--story-dir", help="剧本目录（默认 story/；测试用）")
    ap.add_argument("--out", help="story.json 输出路径（默认 data/story.json；测试用）")
    args = ap.parse_args()
    story_dir = Path(args.story_dir).resolve() if args.story_dir else ROOT / "story"

    rep = Report()
    story = {"lines": {}, "cards": {}, "file_order": []}
    files = sorted(p for p in story_dir.glob("*.txt") if p.name != "props.txt")
    if not files:
        print("ERROR: %s/*.txt 为空" % story_dir, file=sys.stderr)
        return 2
    for p in files:
        parse_file(p, rep, story)
    props = parse_props(story_dir / "props.txt", rep)
    vfile = story_dir / "VERSION"
    version = vfile.read_text(encoding="utf-8").strip() if vfile.exists() else "0.0.0"
    story["version"] = version or "0.0.0"
    story["order"] = [l for l in story["lines"] if l != "common"]
    if "common" not in story["lines"]:
        rep.err("story", "缺少 @line common")
    redlines = []
    if args.redlines:
        rp = Path(args.redlines)
        if rp.exists():
            redlines = [x.strip() for x in rp.read_text(encoding="utf-8").splitlines()
                        if x.strip() and not x.startswith("#")]
        else:
            rep.warn("redlines", "文件不存在：%s" % args.redlines)

    finalize(story, rep)
    validate(story, props, rep, redlines)

    # 可达性（有结构错误时跳过）
    unreachable_ends = []
    if not rep.errors:
        roots = [story["lines"][l]["start"] for l in story["lines"]]
        reach = reach_from(story, roots)
        # 数值死亡规则：沿任何路线数值都碰不到阈值的，单独说明原因（比“走不到”更能指导改剧本）
        never = set()
        for lid, ln in story["lines"].items():
            if ln["locked"]:
                continue
            for d in ln["deaths"]:
                ok, ext = death_reach(story["cards"], ln).get(d["end"], (False, None))
                if not ok:
                    never.add(d["end"])
                    tail = "" if d["end"] in reach else "；该结局没有别的入口，不计入图鉴。要开放它，需要有选项把这个数值推到阈值"
                    rep.warn("line %s" % lid, "死亡规则 %s%s%d → %s 永远触发不了：沿任何路线“%s”只会%s到 %s%s" % (
                        d["meter"], d["op"], d["val"], d["end"], d["meter"],
                        "降" if d["op"] in ("<=", "<") else "升", ext, tail))
        for cid in story["cards"]:
            if cid not in reach and cid not in never:
                rep.warn("card %s" % cid, "从 common 起点或各线起点都走不到")
        # 玩家永远到不了的结局（未锁定线里的）：写进 story.json，图鉴和总数里不算它
        unreachable_ends = [cid for cid, c in story["cards"].items()
                            if "end" in c and cid not in reach and not story["lines"][c["ln"]]["locked"]]

    built = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    story["built"] = built
    stats_lines = []
    if not rep.errors:
        stats_lines = print_stats(story)

    for w in rep.warnings:
        print("WARN  " + w)
    for e in rep.errors:
        print("ERROR " + e, file=sys.stderr)
    if rep.errors:
        print("编译失败：%d 个错误，%d 个警告" % (len(rep.errors), len(rep.warnings)), file=sys.stderr)
        return 1

    lines_out = {}
    for lid, ln in story["lines"].items():
        lines_out[lid] = {
            "name": ln["name"], "team": ln["team"], "motto": ln["motto"],
            "portrait": ln["portrait"], "meters": ln["meters"], "init": ln["init"],
            "start": ln["start"],
            "deaths": [{"meter": d["meter"], "op": d["op"], "val": d["val"], "end": d["end"]}
                       for d in ln["deaths"]],
            "locked": ln["locked"],
        }
    out = {"version": story["version"], "built": built, "lines": lines_out,
           "order": story["order"], "props": props, "unreachable": unreachable_ends,
           "cards": story["cards"]}
    out_path = Path(args.out).resolve() if args.out else ROOT / "data" / "story.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print("")
    print("== 统计 (version %s) ==" % story["version"])
    print("lines=%d  cards=%d  props=%d  story.json=%d bytes" % (
        len(lines_out), len(story["cards"]), len(props), out_path.stat().st_size))
    for l in stats_lines:
        print(l)
    if unreachable_ends:
        print("unreachable ends (图鉴不计入): " + " ".join(unreachable_ends))
    print("warnings=%d errors=0" % len(rep.warnings))

    if args.review:
        rp = (ROOT.parent / "review" / "story_review.html") if args.review == "__default__" \
            else Path(args.review)
        if not rp.is_absolute():
            rp = (Path.cwd() / rp).resolve()
        build_review(story, stats_lines, ["WARN " + w for w in rep.warnings], rp)
        print("review -> %s" % rp)
    return 0


if __name__ == "__main__":
    sys.exit(main())
