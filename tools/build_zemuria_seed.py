#!/usr/bin/env python3
"""
Step-1 Multi-Source Seed Builder for Kiseki Interactive Relationship Graph.
Combines:
  1. Script dialogue statistics (kuro_script_stats.json)
  2. Legacy spreadsheet relationship export (relation_xlsx_dump.json)
  3. Public WordPress REST API catalog (dt_team, org, region)
Outputs canonical static JSON: data/zemuria.latest.json
"""

import glob
import html
import itertools
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
if TOOLS_DIR not in sys.path:
    sys.path.insert(0, TOOLS_DIR)

from kuro2_spec import (
    KURO2_ARC_DEF,
    KURO2_ARC_OVERRIDES,
    KURO2_CANONICAL_NAME_MAP,
    KURO2_CONTINUING_RELS,
    KURO2_ENGLISH_NAME_OVERRIDES,
    KURO2_NEW_CHARS,
    KURO2_NEW_ORGS,
    KURO2_NEW_RELS,
    KURO2_RETURNING_ENTITIES,
    KURO2_SCRIPT_MOMENTS,
    KURO2_SUPERSEDES,
    get_kuro2_moments,
)
from kai_spec import (
    KAI_ARC_DEF,
    KAI_ARC_OVERRIDES,
    KAI_CANONICAL_NAME_MAP,
    KAI_CONTINUING_RELS,
    KAI_ENGLISH_NAME_OVERRIDES,
    KAI_NEW_CHARS,
    KAI_NEW_ORGS,
    KAI_NEW_RELS,
    KAI_NORTHERN_WAR_EXCLUSIONS,
    KAI_RETURNING_ENTITIES,
    KAI_SCRIPT_MOMENTS,
    KAI_SUPERSEDES,
)

REPO_ROOT = os.path.dirname(TOOLS_DIR)
CACHE_DIR = os.environ.get("KISEKI_SEED_CACHE_DIR", os.path.join(TOOLS_DIR, "cache"))
KURO2_DOCS_DIR = os.environ.get("KURO2_DOCS_DIR", "")
OUT_JSON = os.environ.get("KISEKI_OUT_JSON", os.path.join(REPO_ROOT, "data", "zemuria.latest.json"))
VALID_ENTITY_TYPES = {"nation", "organization", "family", "school", "character"}
FORBIDDEN_ARTIFACT_NAMES = {
    "雷盖伦之箱",
    "蕾盖伦之匣",
    "时之至宝",
    "创世",
    "八创世",
    "FIO",
    "FIO（飘浮支援型导力无人机）",
    "XEROS",
    "XEROS（地面强袭型导力无人机）",
    "伊修坦提",
    "伊修坦提（天使人偶型古代遗物）",
}


def parse_xlsx_sheets(xlsx_path: str) -> dict:
    """Parse an .xlsx workbook into {sheet_name: [[cell_str, ...], ...]} using Python 3 stdlib."""
    ns_main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    ns_rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

    def col_to_idx(cell_ref: str) -> int:
        letters = ""
        for ch in cell_ref:
            if ch.isalpha():
                letters += ch.upper()
            else:
                break
        idx = 0
        for ch in letters:
            idx = idx * 26 + (ord(ch) - ord("A") + 1)
        return max(idx - 1, 0)

    sheets_out = {}
    with zipfile.ZipFile(xlsx_path, "r") as zf:
        shared_strings = []
        if "xl/sharedStrings.xml" in zf.namelist():
            ss_root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in ss_root.findall(f"{{{ns_main}}}si"):
                parts = [t.text or "" for t in si.iter(f"{{{ns_main}}}t")]
                shared_strings.append("".join(parts))

        wb_root = ET.fromstring(zf.read("xl/workbook.xml"))
        rels_root = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
        rid_to_target = {}
        for rel in rels_root:
            rid = rel.attrib.get("Id", "")
            tgt = rel.attrib.get("Target", "").lstrip("/")
            if tgt and not tgt.startswith("xl/"):
                tgt = f"xl/{tgt}"
            rid_to_target[rid] = tgt

        for sh in wb_root.findall(f".//{{{ns_main}}}sheet"):
            sh_name = sh.attrib.get("name", "")
            rid = sh.attrib.get(f"{{{ns_rel}}}id", "")
            xml_target = rid_to_target.get(rid, "")
            if not sh_name or xml_target not in zf.namelist():
                continue
            ws_root = ET.fromstring(zf.read(xml_target))
            rows_list = []
            for row_el in ws_root.findall(f".//{{{ns_main}}}sheetData/{{{ns_main}}}row"):
                row_vals = {}
                max_col = -1
                for c_el in row_el.findall(f"{{{ns_main}}}c"):
                    c_idx = col_to_idx(c_el.attrib.get("r", "A1"))
                    c_type = c_el.attrib.get("t", "")
                    val = ""
                    if c_type == "s":
                        v_el = c_el.find(f"{{{ns_main}}}v")
                        if v_el is not None and v_el.text and v_el.text.isdigit():
                            s_idx = int(v_el.text)
                            if 0 <= s_idx < len(shared_strings):
                                val = shared_strings[s_idx]
                    elif c_type == "inlineStr":
                        val = "".join(t.text or "" for t in c_el.iter(f"{{{ns_main}}}t"))
                    else:
                        v_el = c_el.find(f"{{{ns_main}}}v")
                        if v_el is not None and v_el.text is not None:
                            val = v_el.text
                    row_vals[c_idx] = val.strip()
                    if c_idx > max_col:
                        max_col = c_idx
                if max_col >= 0:
                    rows_list.append([row_vals.get(i, "") for i in range(max_col + 1)])
            sheets_out[sh_name] = rows_list
    return sheets_out


def norm_name(s: str) -> str:
    if not s:
        return ""
    s = html.unescape(s).strip()
    for ch in ["‧", "･", "•", "・"]:
        s = s.replace(ch, "·")
    s = re.sub(r"\s+", " ", s)
    return s


def strip_html(raw: str) -> str:
    if not raw:
        return ""
    txt = re.sub(r"<[^>]+>", "", html.unescape(raw))
    txt = re.sub(r"\s+", " ", txt).strip()
    return txt.replace("[&hellip;]", "…").replace("…", "…")


def slugify(text: str, fallback_idx: int) -> str:
    s = text.lower().strip()
    s = re.sub(r"[^a-z0-9\-]+", "-", s).strip("-")
    if s:
        return s
    return f"ent-{fallback_idx}"


# Name unification map (legacy xlsx / variant -> canonical Chinese name)
CANONICAL_NAME_MAP = {
    "ellen?": "卡拜德夫人",
    "静奈·蕾姆·御折木": "静名·蕾姆·御折木",
    "静名·雷姆·御折木": "静名·蕾姆·御折木",
    "金·瓦赛克": "阵·瓦赛克",
    "瓦鲁特": "瓦尔特·克隆",
    "瓦尔特·克伦": "瓦尔特·克隆",
    "巴克霍恩": "贝尔加德·哲曼",
    "范恩·阿克莱德": "范恩·亚克莱德",
    "菲莉·阿尔费德": "菲莉·阿尔法德",
    "结社": "噬身之蛇",
    "克洛斯贝尔独立州": "克洛斯贝尔自治州",
    "克洛斯贝尔": "克洛斯贝尔自治州",
    "特务支援科": "特务支援课",
    "托尔兹士官学校总校": "托尔兹军官学院",
    "托尔兹军官学校": "托尔兹军官学院",
    "托尔兹士官学校第Ⅱ分校": "托尔兹第Ⅱ分校",
    "帝都女子学院": "圣亚斯特莱亚女子学院",
    "莱恩福尔特(RF)集团": "莱恩福尔特社",
    "A·拉赛尔": "阿尔伯特·拉赛尔",
    "A·拉塞尔": "阿尔伯特·拉赛尔",
    "丹·拉塞尔": "丹·拉赛尔",
    "艾莉卡·拉塞尔": "艾丽卡·拉赛尔",
    "塞尔盖·罗": "赛尔盖·罗",
    "阿列克斯·达德利": "亚历克斯·达德利",
    "露西·赛兰德": "露希·赛兰德",
    "艾澳莉亚": "艾澳莉雅",
    "阿龙·魏": "亚伦·魏",
    "艾因·瑟尔纳特": "爱因·瑟尔纳特",
    "卡夏·奥斯本": "卡莎·奥斯本",
    "里翁·巴塔扎尔": "里翁·巴塔札尔",
    "雅利安洛德": "阿瑞安赫德",
    "艾丝梅雷·亚切特": "艾丝梅蕾·亚切特",
    "卢方": "方·卢",
    "卢基恩": "基恩·卢",
    "高郎": "高朗",
    "玛莉艾儿·艾梅": "玛莉艾儿·埃梅",
    "亚里欧斯·马克莱因": "亚里欧斯·马克莱茵",
    "贝尔摩提": "贝尔默提",
    "亚修拉德": "阿修拉德",
    "爱丽儿·朗海姆": "爱丽尔·朗海姆",
    "哈桑": "哈桑·阿尔法德",
    "幻夜之猫": "茱迪丝·兰斯塔",
    "G·施密特": "格哈特·施密特",
    "F·诺华提斯": "弗朗茨·诺华提斯",
    **KURO2_CANONICAL_NAME_MAP,
    **KAI_CANONICAL_NAME_MAP,
}

# Gacha portrait sheet (空零碧闪关系表.xlsx -> 抽卡) short-name & variant -> canonical entity name
GACHA_NAME_TO_CANONICAL = {
    "阿奈斯特": "阿奈斯特·莱兹",
    "索菲亚·海瓦斯": "索菲亚夫人",
    "修莉": "修利·阿多雷德",
    "凛": "琳",
    "玛堤乌斯": "玛提乌斯·范德尔",
    "黄金蝶": "露克蕾琪亚·伊斯雷",
    "阿尔缇菈": "绯之阿尔缇菈",
    "露西亚·舒华泽": "露西亚夫人",
    "亚拉密斯": "亚拉密斯高等学校",
    "约纳": "约纳·赛克里德",
    "渥雷斯": "渥雷斯·拜尔迪安斯",
    "滴": "滴·马克莱茵",
    "卡艾拉": "卡艾拉·马克米兰",
    "艾蕾因": "艾蕾因·奥克雷尔",
    "季斯卡尔": "季斯卡尔技术长",
    "奈特": "奈特搜查官",
    "艾梅丝": "艾梅丝/艾米莉亚·哈林格",
}

# Non-Trails gacha crossovers, pair cards & child/BE alt skins to exclude from defaultAvatarUrl
GACHA_EXCLUDED_EXACT_NAMES = {
    "亚特鲁",
    "多奇",
    "切斯特",
    "雨果",  # Ys Origin Hugo Fact (ficon2023_028_hugo); Trails Hugo Kleist is 雨果·克莱斯特!
    "索菲亚",  # Gagharv Sophia (ficon2023_059_sophia)
    "莫纳",
    "拉比",
    "空·郁岛",
    "美月·北都",
    "璃音·玖我山",
    "栞·仓敷",
    "卢法斯x拉碧丝",
    "蕾恩x媞妲",
    "拉薇安·温斯蕾",
    "马丁·S·罗宾森",
    "伊赛莉亚·弗罗斯特",
    "塔利昂·德雷克",
    "奥利维尔·朗海姆（幼年版）",
    "穆拉·范德尔 (幼年版)",
    "瑟蕾奴（人形）",
    "奥蕾莉亚（少女）",
    "黎恩（幼年版）",
    "黎恩·伊修麦格",
    "怪盗猫",
    "零之御子",
    "苍之齐格飞",
    "emperor",
    "拉碧丝（晶片体）",  # Handled via kuro2/kai arcOverrides so sen keeps doll avatar
    "艾米莉亚·哈林格",  # Handled via kai arcOverrides so kuro/kuro2 keep Hermes avatar
}

# Verified WP post title -> canonical entity name map (ONLY true 1:1 identity matches;
# prevents proxy postids on relatives/pets/tactical shells/sub-divisions from stealing WP profiles)
WP_TITLE_TO_CANONICAL = {
    "地下万事屋": "亚克莱德解决事务所",
    "托尔兹军官学校": "托尔兹军官学院",
    "克洛斯贝尔": "克洛斯贝尔自治州",
    "克洛斯贝尔警察": "克洛斯贝尔警察局",
    "哈梅尔": "哈梅尔村",
    "诺森比亚": "诺森比亚自治州",
    "Ⅶ班": "旧VII班",
    "萨缪尔·洛克史密斯": "洛克史密斯",
    "丹·拉塞尔": "丹·拉赛尔",
    "莱恩哈特": "莱维",
    "玛丽亚贝尔·克洛伊斯": "玛丽亚贝尔·克罗伊斯",
    "瓦奇·赫密士菲亚": "瓦吉·赫米斯菲亚",
    "赛特": "蔡特",
    "悠娜·克劳弗德": "悠娜·克劳福德",
    "娜狄雅·莱恩": "娜狄雅·莱茵",
    "雅里安洛德": "阿瑞安赫德",
    "亚里欧斯·马克莱因": "亚里欧斯·马克莱茵",
    "伊莉雅·普拉提耶": "伊莉娅·普拉缇耶",
    "玛堤乌斯·范德尔": "玛提乌斯·范德尔",
    "雷克多·亚兰德尔": "雷克特·亚兰德尔",
    "玛格丽特·德勒斯登": "玛格丽特",
    "兰伯特·马赫": "兰伯特",
    "裴德烈": "菲德烈",
    "科蕾特": "柯蕾特",
    "梵戴克": "范戴克",
    "亨利": "亨利主任",
    "赛德利克·莱泽·亚诺尔": "赛德里克·莱泽·亚诺尔",
    "艾妲·古兰特": "艾妲",
    "弗利兹·盖特纳": "弗利兹",
    "盖伊·班宁斯": "盖·班宁斯",
    "索妮亚·贝尔茨": "索尼娅·贝尔茨",
    "修莉·亚特雷德": "修利·阿多雷德",
    "星·卢": "星少",
    "赛西儿·诺叶斯": "赛茜尔·诺伊艾丝",
    "索菲亚·海瓦斯": "索菲亚夫人",
    "尤根特·莱泽·亚诺尔": "尤肯特Ⅲ世",
    "普莉希拉·莱泽·亚诺尔": "普莉希拉皇妃",
    "费尔南·海恩斯": "费尔南多·海恩斯",
    "渥雷斯·巴尔迪亚斯": "渥雷斯·拜尔迪安斯",
    "罗赛莉亚·米尔斯汀": "罗赛莉亚",
    "瓦莱莉": "瓦莱丽",
    "滴·马克莱因": "滴·马克莱茵",
    "露西欧拉": "露茜奥拉",
    "古恩·莱恩弗尔特": "古恩·莱恩福尔特",
}

# Clean English names & deterministic slugs for entities without dedicated WP posts
ENGLISH_NAME_OVERRIDES = {
    "新VII班": "New Class VII",
    "托尔兹第Ⅱ分校": "Thors Branch Campus",
    "铁机队": "Stahlritter",
    "贵族联合": "Noble Alliance",
    "魔女眷属": "Hexen Clan",
    "地精": "Gnomes",
    "彩虹舞团": "Arc en Ciel",
    "拜斯兰特决起军": "Weissland Army",
    "游击士(利贝尔支部)": "Bracer Guild Liberl",
    "游击士(克洛斯贝尔)": "Bracer Guild Crossbell",
    "亚拉密斯高等学校": "Aramis High School",
    "卡尔瓦德政府与总统府": "Calvard Government",
    "首都警察": "Capital Police",
    "餐酒馆《蒙马特》": "Bistro Montmart",
    "泰雷尔通讯社": "Tyrell News",
    "维加斯影业": "Vegas Film",
    "八叶一刀流": "Eight Leaves One Blade",
    "泰斗流": "Taito Style",
    "昆仑流": "Kunlun Style",
    "月华流": "Gekka Style",
    "黑神一刀流": "Black God One Blade",
    "亚尔赛德流": "Arseid School",
    "范德尔流": "Vander School",
    "百式军刀术": "Hundred-Form Military Saber",
    "宫廷枪术": "Court Fencing",
    "骑马枪术": "Mounted Lance",
    "许莱登流": "Schleiden School",
    "布莱特家族": "Bright Family",
    "拉赛尔家族": "Russell Family",
    "利贝尔王家": "Liberl Royal Family",
    "麦克道尔家族": "MacDowell Family",
    "克劳福德家族": "Crawford Family",
    "海瓦斯家族": "Hayworth Family",
    "舒华泽家族": "Schwarzer Family",
    "莱恩福尔特家族": "Reinford Family",
    "艾尔巴雷亚家族": "Albarea Family",
    "罗格纳家族": "Rogner Family",
    "海恩斯家族": "Hyarms Family",
    "凯恩家族": "Cayenne Family",
    "范德尔家族": "Vander Family",
    "奥斯本家族": "Osborne Family",
    "克雷格家族": "Craig Family",
    "利维特家族": "Rieveldt Family",
    "亚诺尔皇族": "Arnor Imperial Family",
    "克劳蒂尔家系": "Claudel Family",
    "卢家": "Lu Family",
    "I班": "Thors Class I",
    "II班": "Thors Class II",
    "III班": "Thors Class III",
    "IV班": "Thors Class IV",
    "V班": "Thors Class V",
    "VIII班": "Thors Class VIII",
    "IX班": "Thors Class IX",
    "第一机甲师团": "1st Armored Division",
    "第三机甲师团": "3rd Armored Division",
    "第四机甲师团": "4th Armored Division",
    "第五机甲师团": "5th Armored Division",
    "第七机甲师团": "7th Armored Division",
    "第九机甲师团": "9th Armored Division",
    "第十三机甲师团": "13th Armored Division",
    "第二十三机甲师团": "23rd Armored Division",
    "卡莲·阿斯特雷": "Karin Astray",
    "帕蒂尔·玛蒂尔": "Pater-Mater",
    "古利亚诺斯": "Grianos",
    "捷欧": "Zeo",
    "《银臂》": "Airgetlam",
    "《光剑》": "Claiomh Solais",
    "瓦利玛": "Valimar",
    "奥尔迪涅": "Ordine",
    "特斯塔·罗莎": "Testa-Rossa",
    "亚格里昂": "Argreion",
    "赛克托": "Zector",
    "埃尔·普拉多": "El-Prado",
    "伊修麦格": "Ishmelga",
    "弗兰兹·莱恩福尔特": "Franz Reinford",
    "德莱凯尔斯·莱泽·亚诺尔": "Dreichels Reise Arnor",
    "哈桑·阿尔法德": "Hassan Al-Fayed",
    "杰兰特": "Geraint",
    "海克力士": "Hercules",
    "克洛德·爱普斯泰恩": "Claude Epstein",
    "叶花·魏": "Yehua Wei",
    "萨尔曼": "Salman Asverl",
    "艾德蒙·奥克雷尔": "Edmond Auclair",
    "艾林格": "Elling",
    "罗宾·格拉斯戈": "Robin Glasgow",
    "范格兰茨·赛恩": "Vagrant Zion",
    "萨菈": "Saara",
    "莎希娜": "Shaheena",
    "巴泽尔理科大学": "Basel Institute of Science",
    "雷克塞尔演艺事务所": "Reksel Agency",
    "季斯卡尔工房": "Giscard Workshop",
    "国际协力机构": "ICO",
    "煌都华剧场": "Langport Eastern Theater",
    "杂志《扒粪者》": "Muckraker Magazine",
    "昆西公司": "Quincy Company",
    "卡尔瓦德前皇室": "Former Calvard Royal Family",
    "蒙马特家族": "Montmart Family",
    "雷家": "Lei Family",
    "凶手": "Heiyue Assassins",
    "胧月流": "Oborozuki Style",
    **KURO2_ENGLISH_NAME_OVERRIDES,
    **KAI_ENGLISH_NAME_OVERRIDES,
}

NATION_NAMES = {
    "卡尔瓦德共和国",
    "埃雷波尼亚帝国",
    "利贝尔王国",
    "克洛斯贝尔自治州",
    "艾尔萨姆公国",
    "奥雷德自治州",
    "亚尔特利亚法典国",
    "雷米菲利亚公国",
    "诺森比亚自治州",
}

SCHOOL_NAMES = {
    "八叶一刀流",
    "泰斗流",
    "昆仑流",
    "月华流",
    "黑神一刀流",
    "胧月流",
    "范德尔流",
    "亚尔赛德流",
    "百式军刀术",
    "宫廷枪术",
    "骑马枪术",
    "许莱登流",
}

FAMILY_NAMES_EXTRA = {
    "四大名门",
    "亚诺尔皇族",
    "利贝尔王家",
    "克劳蒂尔家系",
    "卡尔瓦德前皇室",
    "蒙马特家族",
    "奥克雷尔家族",
    "卢家",
    "雷家",
    "李家",
    "兰斯塔家系",
}

# Global multi-arc hubs (do not propagate single-arc tags blindly across them)
GLOBAL_HUBS = {
    "噬身之蛇",
    "游击士协会",
    "七耀教会",
    "星杯骑士团",
    "八叶一刀流",
    "泰斗流",
    "黑月",
    "爱普斯泰恩财团",
}

# Explicit arc sets for global hubs so none spawn orphan nodes in arcs they never appeared in
GLOBAL_HUB_ARCS = {
    "噬身之蛇": {"sora", "zero_ao", "sen", "kuro"},
    "游击士协会": {"sora", "zero_ao", "sen", "kuro"},
    "七耀教会": {"sora", "zero_ao", "sen", "kuro"},
    "星杯骑士团": {"sora", "zero_ao", "sen", "kuro"},
    "八叶一刀流": {"sora", "zero_ao", "sen", "kuro"},
    "泰斗流": {"sora", "sen", "kuro"},
    "黑月": {"zero_ao", "sen", "kuro"},
    "爱普斯泰恩财团": {"sora", "zero_ao", "sen", "kuro"},
}

SORA_SEEDS = {
    "利贝尔王国", "利贝尔王家", "游击士(利贝尔支部)", "拉赛尔家族", "哈梅尔村",
    "艾丝蒂尔·布莱特", "约修亚·布莱特", "卡西乌斯·布莱特", "布莱特家族",
    "雪拉扎德·哈维", "阿加特·科洛斯纳", "科洛蒂娅·冯·奥赛雷丝", "缇妲·拉赛尔",
    "阵·瓦赛克", "雾香·楼兰", "亚兰·理查德", "亚妮拉丝·艾尔菲德", "凯文·格拉汉姆",
    "莉丝·亚尔珍特", "露菲娜·亚尔珍特", "爱因·瑟尔纳特", "盖鲁格·怀斯曼",
    "莱维", "卡莲·阿斯特雷", "露茜奥拉", "瓦尔特·克隆", "乔丝特·卡普亚", "多伦·卡普亚",
    "杜南·冯·奥赛雷丝", "摩尔根", "尤莉亚", "奈尔·班兹",
    "阿尔伯特·拉赛尔", "艾丽卡·拉赛尔", "丹·拉赛尔", "帕蒂尔·玛蒂尔",
}

ZERO_AO_SEEDS = {
    "克洛斯贝尔自治州", "特务支援课", "克洛斯贝尔警察局", "克洛斯贝尔警备队",
    "游击士(克洛斯贝尔)", "彩虹舞团", "鲁巴彻商会", "赤色星座",
    "麦克道尔家族", "克劳福德家族", "海瓦斯家族",
    "罗伊德·班宁斯", "艾莉·麦克道尔", "缇欧·普拉托", "兰迪·奥兰多",
    "诺艾尔·希卡", "瓦吉·赫米斯菲亚", "莉夏·毛", "琪雅·班宁斯",
    "盖·班宁斯", "赛尔盖·罗", "亚里欧斯·马克莱茵", "滴·马克莱茵",
    "亚历克斯·达德利", "玛丽亚贝尔·克罗伊斯", "伊莉娅·普拉缇耶", "修利·阿多雷德",
    "芙兰·希卡", "赛茜尔·诺伊艾丝", "索尼娅·贝尔茨", "米蕾优",
    "亨利·麦克道尔", "加尔西亚·罗西", "瓦鲁多·瓦雷斯", "阿奈斯特·莱兹",
    "约纳·赛克里德", "蔡特", "阿巴斯", "谢莉·奥兰多", "哈罗德·海瓦斯",
    "索菲亚夫人", "柯林·海瓦斯", "星少", "晶歌", "咪西", "戴安娜·麦克道尔", "莱昂·麦克道尔",
}

SEN_SEEDS = {
    "埃雷波尼亚帝国", "托尔兹军官学院", "托尔兹第Ⅱ分校", "旧VII班", "新VII班",
    "I班", "II班", "III班", "IV班", "V班", "VIII班", "IX班",
    "帝国正规军", "帝国军情报局", "帝国解放战线", "贵族联合", "铁血之子", "铁机队",
    "魔女眷属", "地精", "黑之工房", "西风旅团", "北方猎兵", "拜斯兰特决起军",
    "圣亚斯特莱亚女子学院", "莱恩福尔特社", "诺尔德高原",
    "第一机甲师团", "第三机甲师团", "第四机甲师团", "第五机甲师团",
    "第七机甲师团", "第九机甲师团", "第十三机甲师团", "第二十三机甲师团",
    "舒华泽家族", "莱恩福尔特家族", "艾尔巴雷亚家族", "罗格纳家族", "海恩斯家族",
    "凯恩家族", "范德尔家族", "奥斯本家族", "克雷格家族", "沃泽尔家族", "利维特家族",
    "黎恩·舒华泽", "亚莉莎·莱恩福尔特", "艾略特·克雷格", "劳拉·S·亚尔赛德",
    "马奇亚斯·雷格尼兹", "尤西斯·艾尔巴雷亚", "艾玛·米尔斯汀", "菲·克劳赛尔",
    "盖乌斯·沃泽尔", "米莉亚姆·奥莱恩", "克洛·安布斯特", "莎拉·巴雷斯坦",
    "托娃·赫歇尔", "悠娜·克劳福德", "库尔特·范德尔", "亚尔缇娜·奥莱恩",
    "妙婕·伊格瑞特", "亚修·卡拜德", "奥利巴特·莱泽·亚诺尔", "吉利亚斯·奥斯本",
    "卢法斯·艾尔巴雷亚", "克蕾雅·利维特", "雷克特·亚兰德尔", "雪伦·克鲁格",
    "托瓦尔·兰德纳", "安洁莉卡·罗格纳", "乔治·诺姆", "薇塔·克洛提德",
    "阿瑞安赫德", "马克邦", "杜巴莉", "拉碧丝·罗赞贝尔克", "斯温·亚贝尔", "娜狄雅·莱茵",
    "桃乐丝", "亚格里昂", "斯卡蕾特",
}

MINOR_ORG_NAMES = {
    "I班", "II班", "III班", "IV班", "V班", "VIII班", "IX班",
    "第一机甲师团", "第三机甲师团", "第四机甲师团", "第五机甲师团",
    "第七机甲师团", "第九机甲师团", "第十三机甲师团", "第二十三机甲师团",
    "拜斯兰特决起军", "哈梅尔村", "诺尔德高原", "百式军刀术", "宫廷枪术", "骑马枪术", "许莱登流",
}

LEGACY_CORE_CHARS = {
    "艾丝蒂尔·布莱特", "约修亚·布莱特", "卡西乌斯·布莱特", "蕾恩·布莱特",
    "雪拉扎德·哈维", "阿加特·科洛斯纳", "科洛蒂娅·冯·奥赛雷丝", "缇妲·拉赛尔",
    "阵·瓦赛克", "凯文·格拉汉姆", "莉丝·亚尔珍特", "莱维", "盖鲁格·怀斯曼",
    "罗伊德·班宁斯", "艾莉·麦克道尔", "缇欧·普拉托", "兰迪·奥兰多",
    "诺艾尔·希卡", "瓦吉·赫米斯菲亚", "莉夏·毛", "琪雅·班宁斯", "赛尔盖·罗",
    "亚里欧斯·马克莱茵", "玛丽亚贝尔·克罗伊斯",
    "黎恩·舒华泽", "亚莉莎·莱恩福尔特", "艾略特·克雷格", "劳拉·S·亚尔赛德",
    "马奇亚斯·雷格尼兹", "尤西斯·艾尔巴雷亚", "艾玛·米尔斯汀", "菲·克劳赛尔",
    "盖乌斯·沃泽尔", "米莉亚姆·奥莱恩", "克洛·安布斯特", "莎拉·巴雷斯坦",
    "悠娜·克劳福德", "库尔特·范德尔", "亚尔缇娜·奥莱恩", "妙婕·伊格瑞特", "亚修·卡拜德",
    "奥利巴特·莱泽·亚诺尔", "吉利亚斯·奥斯本", "卢法斯·艾尔巴雷亚",
    "阿瑞安赫德", "薇塔·克洛提德", "马克邦", "坎佩尼拉", "盟主",
    "拉碧丝·罗赞贝尔克", "斯温·亚贝尔", "娜狄雅·莱茵",
}

# Explicit importance overrides for characters whose lore role differs from raw degree count
IMPORTANCE_OVERRIDES = {
    "晶歌": "minor",
    "奥莉耶·范德尔": "minor",
    "米蕾优": "supporting",
    "赛尔盖·罗": "core",
    "亚历克斯·达德利": "supporting",
    "爱因·瑟尔纳特": "supporting",
    "弗朗茨·诺华提斯": "supporting",
    "阿尔伯特·拉赛尔": "supporting",
    "艾丽卡·拉赛尔": "supporting",
    "亚兰·理查德": "supporting",
    "亚妮拉丝·艾尔菲德": "supporting",
    "乔丝特·卡普亚": "supporting",
    "露茜奥拉": "supporting",
    "尤莉亚": "supporting",
    "摩尔根": "supporting",
    "杜南·冯·奥赛雷丝": "supporting",
    "奈尔·班兹": "supporting",
    "基尔巴特·斯坦因": "supporting",
    "露菲娜·亚尔珍特": "supporting",
    "伊莉娅·普拉缇耶": "supporting",
    "赛茜尔·诺伊艾丝": "supporting",
    "芙兰·希卡": "supporting",
    "索尼娅·贝尔茨": "supporting",
    "亨利·麦克道尔": "supporting",
    "加尔西亚·罗西": "supporting",
    "瓦鲁多·瓦雷斯": "supporting",
    "阿奈斯特·莱兹": "supporting",
    "约纳·赛克里德": "supporting",
    "蔡特": "supporting",
    "阿巴斯": "supporting",
    "盖·班宁斯": "supporting",
    "滴·马克莱茵": "supporting",
    "汤玛斯·雷山德": "supporting",
    "斯卡蕾特": "supporting",
    "露希·赛兰德": "supporting",
    "恩奈雅": "supporting",
    "艾奈丝": "supporting",
    "伊琳娜·莱恩福尔特": "supporting",
    "古恩·莱恩福尔特": "supporting",
    "弗兰兹·莱恩福尔特": "supporting",
    "奥拉夫·克雷格": "supporting",
    "卡尔·雷格尼兹": "supporting",
    "玛提乌斯·范德尔": "supporting",
    "尤肯特Ⅲ世": "supporting",
    "布卢布兰": "supporting",
    "云·卡法伊": "supporting",
    "瓦利玛": "supporting",
}

# Authoritative nationality overrides ("" clears falsely inferred nationality)
NATION_OVERRIDES = {
    "哈梅尔村": "埃雷波尼亚帝国",
    "莱维": "埃雷波尼亚帝国",
    "卡莲·阿斯特雷": "埃雷波尼亚帝国",
    "基尔巴特·斯坦因": "利贝尔王国",
    "悠娜·克劳福德": "克洛斯贝尔自治州",
    "肯恩·克劳福德": "克洛斯贝尔自治州",
    "丽娜·克劳福德": "克洛斯贝尔自治州",
    "马修·克劳福德": "克洛斯贝尔自治州",
    "娜娜·克劳福德": "克洛斯贝尔自治州",
    "克劳福德家族": "克洛斯贝尔自治州",
    "凯文·格拉汉姆": "亚尔特利亚法典国",
    "莉丝·亚尔珍特": "亚尔特利亚法典国",
    "露菲娜·亚尔珍特": "亚尔特利亚法典国",
    "爱因·瑟尔纳特": "亚尔特利亚法典国",
    "汤玛斯·雷山德": "亚尔特利亚法典国",
    "阿巴斯": "亚尔特利亚法典国",
    "星杯骑士团": "亚尔特利亚法典国",
    "七耀教会": "亚尔特利亚法典国",
    "僧兵厅": "亚尔特利亚法典国",
    "露希·赛兰德": "雷米菲利亚公国",
    "赛兰德教授": "雷米菲利亚公国",
    "阵·瓦赛克": "卡尔瓦德共和国",
    "雾香·楼兰": "卡尔瓦德共和国",
    "瓦尔特·克隆": "卡尔瓦德共和国",
    "贝尔加德·哲曼": "卡尔瓦德共和国",
    "星少": "卡尔瓦德共和国",
    "曹·李": "卡尔瓦德共和国",
    "洛克史密斯": "卡尔瓦德共和国",
    "黑月": "卡尔瓦德共和国",
    "泰斗流": "卡尔瓦德共和国",
    "亚历山卓": "诺森比亚自治州",
    "北方猎兵": "诺森比亚自治州",
    "盖鲁格·怀斯曼": "诺森比亚自治州",
    "盟主": "",
    "马克邦": "",
    "坎佩尼拉": "",
    "布卢布兰": "",
    "弗朗茨·诺华提斯": "",
    "谢莉·奥兰多": "",
    "加尔西亚·罗西": "",
    "赤色星座": "",
    "西风旅团": "",
    "铁机队": "",
    "艾尔罗伊·贺伍德": "",
    "露克蕾琪亚·伊斯雷": "",
    "薇欧菈": "",
    "奥林匹亚": "",
    "亚里欧契": "",
    "亚格里昂": "",
    "噬身之蛇": "",
    "游击士协会": "",
    "爱普斯泰恩财团": "",
    "D∴G教团": "",
    "八叶一刀流": "",
    "云·卡法伊": "",
    "范格兰茨·赛恩": "",
    "国际协力机构": "",
    "克洛德·爱普斯泰恩": "",
}


def map_relation_category(rel_type: str, label: str) -> str:
    rt = (rel_type or "").strip()
    lb = (label or "").strip()
    if rt in ("成员", "隶属"):
        return "membership"
    if rt in ("流派", "师生", "师从", "学生"):
        return "school"
    if rt in ("家族",):
        return "family"
    if rt in ("恋人", "倾慕", "倾慕?") or any(k in lb for k in ("恋爱", "相爱", "爱情", "倾慕", "好感", "告白")):
        return "romance"
    if "敌" in rt or "仇" in lb or "敌" in lb or "杀" in lb or "憎恨" in lb:
        return "hostile"
    if rt in ("合作", "同事", "上下级", "支配") or any(k in lb for k in ("雇主", "委托", "邀请", "利用", "启动者", "创始人")):
        return "hierarchy"
    return "ally"


def main():
    with open(os.path.join(CACHE_DIR, "trails_wp_catalog.json"), "r", encoding="utf-8") as f:
        wp_cat = json.load(f)
    with open(os.path.join(CACHE_DIR, "relation_xlsx_dump.json"), "r", encoding="utf-8") as f:
        xlsx = json.load(f)
    with open(os.path.join(CACHE_DIR, "kuro_script_stats.json"), "r", encoding="utf-8") as f:
        kuro_stats = json.load(f)

    # Index WP catalog by ID and cleaned canonical title
    wp_by_id = {}
    wp_by_canon = {}
    for cpt in ["dt_team", "org", "region"]:
        for it in wp_cat.get(cpt, []):
            it["cpt"] = cpt
            t = norm_name(strip_html(it["title"]))
            it["_clean_title"] = t
            canon_t = WP_TITLE_TO_CANONICAL.get(t, CANONICAL_NAME_MAP.get(t, t))
            it["_canon_title"] = canon_t
            wp_by_id[int(it["id"])] = it
            wp_by_canon.setdefault(canon_t, it)
            if "/" in t:
                for part in t.split("/"):
                    p_clean = part.strip()
                    wp_by_canon.setdefault(p_clean, it)

    def normalize_wiki_url(raw_url: str) -> str:
        u = (raw_url or "").strip()
        if not u:
            return ""
        m = re.search(r"[?&]p=(\d+)", u)
        if m:
            pid = int(m.group(1))
            if pid in wp_by_id and wp_by_id[pid].get("link"):
                return wp_by_id[pid]["link"]
            return ""
        return u

    # Load curated square face portrait table (空零碧闪关系表.xlsx -> 抽卡) & Kuro table (黎.xlsx) via stdlib
    sora_sen_xlsx_path = os.path.join(REPO_ROOT, "空零碧闪关系表.xlsx")
    parsed_sora_sen_cache = os.path.join(CACHE_DIR, "parsed_sora_sen.json")
    if os.path.isfile(sora_sen_xlsx_path):
        sora_sen_sheets = parse_xlsx_sheets(sora_sen_xlsx_path)
    elif os.path.isfile(parsed_sora_sen_cache):
        with open(parsed_sora_sen_cache, "r", encoding="utf-8") as f:
            sora_sen_sheets = json.load(f)
    else:
        sora_sen_sheets = {}

    kuro_xlsx_path = os.path.join(REPO_ROOT, "黎.xlsx")
    parsed_kuro_cache = os.path.join(CACHE_DIR, "parsed_kuro.json")
    if os.path.isfile(kuro_xlsx_path):
        kuro_xlsx_sheets = parse_xlsx_sheets(kuro_xlsx_path)
    elif os.path.isfile(parsed_kuro_cache):
        with open(parsed_kuro_cache, "r", encoding="utf-8") as f:
            kuro_xlsx_sheets = json.load(f)
    else:
        kuro_xlsx_sheets = {}

    # Index curated square face avatars (HIGHEST priority over full-body WP thumbnails & legacy full-body art!)
    face_avatar_by_canon = {}
    gacha_rows = sora_sen_sheets.get("抽卡", [])
    if gacha_rows:
        for row_idx, grow in enumerate(gacha_rows[1:], 1):
            if len(grow) < 3:
                continue
            raw_gn = norm_name(grow[0])
            star_str = str(grow[1]).strip()
            gurl = str(grow[2]).strip()
            if not raw_gn or not gurl:
                continue
            if gurl.startswith("https://trails-game.com/"):
                gurl = gurl.replace("https://trails-game.com/", "https://cdn.trails-game.com/")
            # Skip non-Trails crossovers, anniversary skins, pair cards & Northern War anime rows
            if (308 <= row_idx <= 326) or row_idx >= 331:
                continue
            if (
                raw_gn in GACHA_EXCLUDED_EXACT_NAMES
                or "(周年版)" in raw_gn
                or "（YS" in raw_gn
                or "（那由多）" in raw_gn
                or "（白发魔女）" in raw_gn
                or "（朱红之泪）" in raw_gn
                or "（海之槛歌）" in raw_gn
                or "_sen_anime_avatar" in gurl
                or "renne_x_tida" in gurl
            ):
                continue
            if raw_gn == "泰蕾莎":
                if star_str == "2":
                    face_avatar_by_canon["泰蕾莎·卡罗琳"] = gurl
                continue
            if raw_gn == "蕾恩（特典）":
                face_avatar_by_canon["蕾恩·布莱特"] = gurl
                continue
            if raw_gn == "蕾恩·布莱特":
                # Keep young Renne icon_608-150x150.jpg for sora/zero_ao/sen overrides; defaultAvatarUrl uses renne-150x150.png
                face_avatar_by_canon.setdefault("蕾恩·布莱特", gurl)
                continue
            mapped_gn = GACHA_NAME_TO_CANONICAL.get(raw_gn, CANONICAL_NAME_MAP.get(raw_gn, raw_gn))
            face_avatar_by_canon[mapped_gn] = gurl

    # Fallback gacha avatars from legacy relation_xlsx_dump.json if workbook is absent
    gacha_avatar = {}
    for g in xlsx.get("gacha", []):
        raw_gn = norm_name(g.get("name", ""))
        if not raw_gn or raw_gn in GACHA_EXCLUDED_EXACT_NAMES:
            continue
        gn = GACHA_NAME_TO_CANONICAL.get(raw_gn, CANONICAL_NAME_MAP.get(raw_gn, raw_gn))
        if g.get("url"):
            gacha_avatar[gn] = g["url"]

    # Enrich Kuro notes from 黎.xlsx (角色 sheet: ['name', 'avatar', 'type', 'postid', 'wikiPage', '备注'])
    kuro_xlsx_bios = {}
    for crow in kuro_xlsx_sheets.get("角色", [])[1:]:
        if len(crow) >= 6:
            cn_raw = norm_name(crow[0])
            cn_mapped = CANONICAL_NAME_MAP.get(cn_raw, cn_raw)
            desc = norm_name(crow[5])
            if cn_mapped and desc and not desc.startswith("同“"):
                kuro_xlsx_bios[cn_mapped] = f"塞姆利亚大陆词条：{cn_mapped}（{desc}）。"

    entities_by_name = {}

    def upsert_entity(
        cname: str,
        entity_type: str,
        arcs: list,
        importance: str = None,
        nation_name: str = None,
        group_name: str = None,
        title: str = None,
        avatar_url: str = None,
        wp_post_id: int = None,
        wiki_url: str = None,
        name_en: str = None,
        aliases: list = None,
        bio: str = None,
        subtype: str = None,
        script_moments: list = None,
        authoritative: bool = False,
    ):
        cname = CANONICAL_NAME_MAP.get(norm_name(cname), norm_name(cname))
        wiki_url = normalize_wiki_url(wiki_url)

        # Match WP post strictly when WP title corresponds to the SAME canonical entity
        true_wp_hit = None
        proxy_wp_hit = None
        if wp_post_id:
            cand = wp_by_id.get(int(wp_post_id))
            if cand is not None:
                if cand["_canon_title"] == cname or cname in cand["_clean_title"].split("/"):
                    true_wp_hit = cand
                else:
                    proxy_wp_hit = cand
            # Discard dead or proxy wp_post_id so it never corrupts wpPostId / slug / avatar / bio
            wp_post_id = int(true_wp_hit["id"]) if true_wp_hit else None

        if not true_wp_hit and cname in wp_by_canon:
            cand = wp_by_canon[cname]
            # Ensure CPT matches entity kind (do not bind region to royal family etc.)
            if not (entity_type == "family" and cand["cpt"] == "region"):
                true_wp_hit = cand
                wp_post_id = int(cand["id"])

        if true_wp_hit:
            wiki_url = true_wp_hit.get("link") or wiki_url
            if not avatar_url and true_wp_hit.get("avatar"):
                avatar_url = true_wp_hit["avatar"]
            if not bio and true_wp_hit.get("excerpt"):
                bio = strip_html(true_wp_hit["excerpt"])
            if not name_en and true_wp_hit.get("slug") and not true_wp_hit["slug"].startswith("%"):
                name_en = true_wp_hit["slug"].replace("-", " ").title()
        elif proxy_wp_hit and not wiki_url:
            # Optional reference permalink for sub-orgs/relatives without stealing main identity
            if entity_type in ("organization", "family") and proxy_wp_hit.get("link"):
                wiki_url = proxy_wp_hit["link"]

        if not name_en and cname in ENGLISH_NAME_OVERRIDES:
            name_en = ENGLISH_NAME_OVERRIDES[cname]

        if cname in face_avatar_by_canon:
            avatar_url = face_avatar_by_canon[cname]
        elif not avatar_url and cname in gacha_avatar:
            avatar_url = gacha_avatar[cname]

        if not bio and cname in kuro_xlsx_bios:
            bio = kuro_xlsx_bios[cname]

        if entity_type == "nation":
            nation_name = ""

        if cname not in entities_by_name:
            entities_by_name[cname] = {
                "id": "",
                "canonicalName": cname,
                "nameEn": name_en or "",
                "entityType": entity_type,
                "subtype": subtype or "",
                "importance": importance or ("core" if entity_type in ("nation", "organization") else "supporting"),
                "_nationName": nation_name or "",
                "_groupName": group_name or "",
                "defaultTitle": title or "",
                "wpPostId": wp_post_id,
                "defaultAvatarUrl": avatar_url or "",
                "wikiUrl": wiki_url or "",
                "aliases": list(aliases or []),
                "arcs": list(arcs),
                "arcOverrides": {},
                "bio": bio or f"塞姆利亚大陆词条：{cname}。",
                "scriptMoments": list(script_moments or []),
            }
        else:
            ent = entities_by_name[cname]
            if entity_type != "character" or ent["entityType"] == "character":
                ent["entityType"] = entity_type
            if ent["entityType"] == "nation":
                ent["_nationName"] = ""
            for a in arcs:
                if a not in ent["arcs"]:
                    ent["arcs"].append(a)
            if importance:
                if authoritative:
                    ent["importance"] = importance
                else:
                    rank = {"core": 1, "supporting": 2, "minor": 3}
                    if rank[importance] < rank.get(ent["importance"], 2):
                        ent["importance"] = importance
            if ent["entityType"] != "nation":
                if nation_name is not None and (authoritative or not ent["_nationName"]):
                    ent["_nationName"] = nation_name
            if group_name is not None and (authoritative or (group_name and not ent["_groupName"])):
                ent["_groupName"] = group_name
            if title:
                ent["defaultTitle"] = title
            if cname in face_avatar_by_canon:
                ent["defaultAvatarUrl"] = face_avatar_by_canon[cname]
            elif avatar_url and (not ent["defaultAvatarUrl"] or "-150x150" in avatar_url):
                ent["defaultAvatarUrl"] = avatar_url
            if wp_post_id and (authoritative or not ent["wpPostId"]):
                ent["wpPostId"] = wp_post_id
            if wiki_url and (authoritative or not ent["wikiUrl"] or "?p=" in ent["wikiUrl"]):
                ent["wikiUrl"] = wiki_url
            if name_en and (authoritative or not ent["nameEn"]):
                ent["nameEn"] = name_en
            if bio and (ent["bio"].startswith("塞姆利亚大陆词条") or len(bio) > len(ent["bio"])):
                ent["bio"] = bio
            for al in aliases or []:
                if al not in ent["aliases"]:
                    ent["aliases"].append(al)
            if script_moments:
                existing_quotes = {m.get("quote") for m in ent["scriptMoments"]}
                for m in script_moments:
                    if m.get("quote") not in existing_quotes:
                        ent["scriptMoments"].append(dict(m))
                        existing_quotes.add(m.get("quote"))

    # Pre-classify xlsx entity types so membership_target never picks a Character or Nation
    xlsx_etype = {}
    for e in xlsx["entities"]:
        raw_nm = norm_name(e["name"])
        nm = CANONICAL_NAME_MAP.get(raw_nm, raw_nm)
        raw_t = e.get("type", "Char")
        if nm in NATION_NAMES:
            et = "nation"
        elif nm in SCHOOL_NAMES:
            et = "school"
        elif raw_t == "Fam" or nm in FAMILY_NAMES_EXTRA or nm.endswith("家族"):
            et = "family"
        elif raw_t == "Org":
            et = "organization"
        else:
            et = "character"
        xlsx_etype[nm] = et

    # 1. Determine arcs & group candidates for legacy relation.xlsx nodes
    adj = defaultdict(set)
    membership_candidates = defaultdict(list)
    for r in xlsx["relations"]:
        s_raw, t_raw = r.get("source", ""), r.get("target", "")
        if not s_raw or not t_raw:
            continue
        s = CANONICAL_NAME_MAP.get(norm_name(s_raw), norm_name(s_raw))
        t = CANONICAL_NAME_MAP.get(norm_name(t_raw), norm_name(t_raw))
        adj[s].add(t)
        adj[t].add(s)
        rt = r.get("RelationType", "")
        lb = norm_name(r.get("Relation", ""))
        t_type = xlsx_etype.get(t, "character")
        if rt in ("成员", "隶属", "家族", "学生", "流派") and s not in NATION_NAMES and t_type in ("organization", "family", "school"):
            is_former = any(w in lb for w in ("已退出", "曾就读", "曾隶属", "前学生", "曾支配", "(前)"))
            type_prio = 0 if t_type == "organization" else (1 if t_type == "family" else 2)
            minor_pen = 1 if t in MINOR_ORG_NAMES else 0
            membership_candidates[s].append((1 if is_former else 0, type_prio, minor_pen, t))

    node_arcs = defaultdict(set)
    for n in SORA_SEEDS:
        node_arcs[n].add("sora")
    for n in ZERO_AO_SEEDS:
        node_arcs[n].add("zero_ao")
    for n in SEN_SEEDS:
        node_arcs[n].add("sen")

    # Authoritative cross-arc legacy bridges & misclassified nodes
    cross_bridges = {
        "蕾恩·布莱特": {"sora", "zero_ao", "sen", "kuro"},
        "艾丝蒂尔·布莱特": {"sora", "zero_ao", "sen"},
        "约修亚·布莱特": {"sora", "zero_ao", "sen"},
        "卡西乌斯·布莱特": {"sora", "sen"},
        "哈梅尔村": {"sora", "sen"},
        "布莱特家族": {"sora", "zero_ao", "sen"},
        "科洛蒂娅·冯·奥赛雷丝": {"sora", "zero_ao", "sen"},
        "雪拉扎德·哈维": {"sora", "sen"},
        "缇妲·拉赛尔": {"sora", "sen"},
        "阿加特·科洛斯纳": {"sora", "sen"},
        "基尔巴特·斯坦因": {"sora", "sen"},
        "凯文·格拉汉姆": {"sora", "zero_ao"},
        "莉丝·亚尔珍特": {"sora", "zero_ao"},
        "爱因·瑟尔纳特": {"sora", "sen"},
        "奥利巴特·莱泽·亚诺尔": {"sora", "zero_ao", "sen"},
        "雷克特·亚兰德尔": {"sora", "zero_ao", "sen"},
        "吉利亚斯·奥斯本": {"sora", "zero_ao", "sen"},
        "坎佩尼拉": {"sora", "zero_ao", "sen"},
        "布卢布兰": {"sora", "sen"},
        "盟主": {"sora", "zero_ao", "sen"},
        "弗朗茨·诺华提斯": {"zero_ao", "sen"},
        "杜巴莉": {"zero_ao", "sen"},
        "恩奈雅": {"zero_ao", "sen"},
        "艾奈丝": {"zero_ao", "sen"},
        "阿瑞安赫德": {"zero_ao", "sen"},
        "罗伊德·班宁斯": {"zero_ao", "sen"},
        "艾莉·麦克道尔": {"zero_ao", "sen"},
        "缇欧·普拉托": {"zero_ao", "sen"},
        "兰迪·奥兰多": {"zero_ao", "sen"},
        "诺艾尔·希卡": {"zero_ao", "sen"},
        "瓦吉·赫米斯菲亚": {"zero_ao", "sen"},
        "莉夏·毛": {"zero_ao", "sen", "kuro"},
        "琪雅·班宁斯": {"zero_ao", "sen"},
        "赛尔盖·罗": {"zero_ao", "sen"},
        "亚历克斯·达德利": {"zero_ao", "sen"},
        "亚里欧斯·马克莱茵": {"zero_ao", "sen"},
        "玛丽亚贝尔·克罗伊斯": {"zero_ao", "sen"},
        "谢莉·奥兰多": {"zero_ao", "sen"},
        "加尔西亚·罗西": {"zero_ao", "sen"},
        "修利·阿多雷德": {"zero_ao", "sen"},
        "伊莉娅·普拉缇耶": {"zero_ao", "sen"},
        "特务支援课": {"zero_ao", "sen"},
        "克洛斯贝尔自治州": {"zero_ao", "sen"},
        "克洛斯贝尔警察局": {"zero_ao", "sen"},
        "克洛斯贝尔警备队": {"zero_ao", "sen"},
        "克劳福德家族": {"zero_ao", "sen"},
        "彩虹舞团": {"zero_ao", "sen"},
        "赤色星座": {"zero_ao", "sen"},
        "西风旅团": {"zero_ao", "sen", "kuro"},
        "铁机队": {"zero_ao", "sen"},
        "露希·赛兰德": {"sora", "sen"},
        "赛兰德教授": {"zero_ao", "sen"},
        "雾香·楼兰": {"sora", "zero_ao", "sen", "kuro"},
        "阵·瓦赛克": {"sora", "kuro"},
        "瓦尔特·克隆": {"sora", "kuro"},
        "贝尔加德·哲曼": {"sen", "kuro"},
        "菲·克劳赛尔": {"sen", "kuro"},
        "静名·蕾姆·御折木": {"kuro"},
        "云·卡法伊": {"sora", "sen"},
    }
    for k, v in cross_bridges.items():
        node_arcs[k] = set(v)
    for k, v in GLOBAL_HUB_ARCS.items():
        node_arcs[k] = set(v)

    # Propagate 4 passes without crossing GLOBAL_HUBS
    for _ in range(4):
        for e in xlsx["entities"]:
            nm = CANONICAL_NAME_MAP.get(norm_name(e["name"]), norm_name(e["name"]))
            if nm in GLOBAL_HUBS or node_arcs[nm]:
                continue
            neighbor_votes = Counter()
            for nb in sorted(adj[nm]):
                if nb in GLOBAL_HUBS:
                    continue
                for a in sorted(node_arcs[nb]):
                    neighbor_votes[a] += 1
            if neighbor_votes:
                top_arc = sorted(neighbor_votes.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
                node_arcs[nm].add(top_arc)

    for e in xlsx["entities"]:
        nm = CANONICAL_NAME_MAP.get(norm_name(e["name"]), norm_name(e["name"]))
        if not node_arcs[nm]:
            node_arcs[nm].add("sen")

    # Select best defaultGroupId per xlsx entity (preferring Org > Fam > School, and overlapping arcs!)
    best_membership_target = {
        "修利·阿多雷德": "彩虹舞团",
        "加尔西亚·罗西": "鲁巴彻商会",
        "盟主": "噬身之蛇",
        "阿瑞安赫德": "噬身之蛇",
        "亚妮拉丝·艾尔菲德": "游击士(利贝尔支部)",
        "科洛蒂娅·冯·奥赛雷丝": "利贝尔王家",
        "盖·班宁斯": "克洛斯贝尔警察局",
        "星少": "黑月",
    }
    for s, cands in membership_candidates.items():
        if s in best_membership_target:
            continue
        s_arcs = node_arcs[s]
        scored = []
        for is_former, type_prio, minor_pen, t in cands:
            t_arcs = node_arcs[t]
            covers_all = 0 if s_arcs.issubset(t_arcs) else 1
            has_overlap = 0 if (s_arcs & t_arcs) else 1
            scored.append((covers_all, has_overlap, is_former, type_prio, minor_pen, t))
        scored.sort(key=lambda x: x[:5])
        if scored and scored[0][1] == 0:
            best_membership_target[s] = scored[0][5]

    # Compute degrees excluding MINOR_ORG_NAMES so background Thors class NPCs aren't inflated to supporting
    deg_counter = Counter()
    major_deg_counter = Counter()
    for r in xlsx["relations"]:
        s = CANONICAL_NAME_MAP.get(norm_name(r.get("source", "")), norm_name(r.get("source", "")))
        t = CANONICAL_NAME_MAP.get(norm_name(r.get("target", "")), norm_name(r.get("target", "")))
        deg_counter[s] += 1
        deg_counter[t] += 1
        if t not in MINOR_ORG_NAMES:
            major_deg_counter[s] += 1
        if s not in MINOR_ORG_NAMES:
            major_deg_counter[t] += 1

    for e in xlsx["entities"]:
        raw_nm = norm_name(e["name"])
        nm = CANONICAL_NAME_MAP.get(raw_nm, raw_nm)
        etype = xlsx_etype[nm]

        deg = deg_counter[nm]
        mdeg = major_deg_counter[nm]
        if nm in IMPORTANCE_OVERRIDES:
            imp = IMPORTANCE_OVERRIDES[nm]
        elif etype == "nation":
            imp = "core"
        elif etype in ("organization", "school", "family"):
            imp = "minor" if nm in MINOR_ORG_NAMES else ("core" if deg >= 5 else "supporting")
        else:
            if nm in LEGACY_CORE_CHARS or deg >= 6:
                imp = "core"
            elif deg >= 3 and mdeg >= 1:
                imp = "supporting"
            else:
                imp = "minor"

        arcs = sorted(node_arcs[nm])
        nat = ""
        if etype != "nation":
            if nm in NATION_OVERRIDES:
                nat = NATION_OVERRIDES[nm]
            elif nm in SORA_SEEDS or arcs == ["sora"]:
                nat = "利贝尔王国"
            elif nm in ZERO_AO_SEEDS or arcs == ["zero_ao"]:
                nat = "克洛斯贝尔自治州"
            elif nm in SEN_SEEDS or arcs == ["sen"]:
                nat = "埃雷波尼亚帝国"

        pid = int(float(e["postid"])) if e.get("postid") and str(e["postid"]).replace(".", "").isdigit() else None
        av = e.get("avatar", "")
        if av.startswith("https://trails-game.com/"):
            av = av.replace("https://trails-game.com/", "https://cdn.trails-game.com/")

        # Avoid copying generic Erebonia crest placeholder onto non-Erebonia orgs
        if av.endswith("/erebonia-150x150.png") and nm in ("魔女眷属", "地精"):
            av = ""

        aliases = [raw_nm] if raw_nm != nm else []
        upsert_entity(
            cname=nm,
            entity_type=etype,
            arcs=arcs,
            importance=imp,
            nation_name=nat,
            group_name=best_membership_target.get(nm, ""),
            avatar_url=av,
            wp_post_id=pid,
            wiki_url=e.get("wikiPage", ""),
            aliases=aliases,
        )

    # 2. Add Nations (scoped strictly to the arcs where they actively participate in the graph!)
    nations_spec = [
        ("卡尔瓦德共和国", ["kuro"], "Calvard Republic", "塞姆利亚中西部多民族民主大国", 8599, []),
        ("艾尔萨姆公国", ["kuro"], "Principality of Elsaim", "大陆中东部传统富庶公国", 39865, []),
        ("奥雷德自治州", ["kuro"], "Ored State", "高科技警备与疗养自治州", 52909, []),
        ("雷米菲利亚公国", ["zero_ao", "sen"], "Principality of Remiferia", "北方医疗先进公国", 8603, []),
        ("埃雷波尼亚帝国", ["sen"], "Erebonian Empire", "大陆西部传统军事大国", 8241, []),
        ("利贝尔王国", ["sora"], "Liberl Kingdom", "大陆西南部导力王国", 8605, []),
        ("克洛斯贝尔自治州", ["zero_ao", "sen"], "Crossbell State", "大陆贸易金融自治州", 8608, ["克洛斯贝尔", "克洛斯贝尔独立州"]),
        ("亚尔特利亚法典国", ["sora", "zero_ao", "sen", "kuro"], "Arteria", "七耀教会总本山所在圣国", 9517, []),
        ("诺森比亚自治州", ["sen"], "North Ambria", "旧诺森比亚大公国 · 盐之桩灾变后改组自治州", 8601, ["诺森比亚", "旧诺森比亚大公国", "诺桑布利亚自治州"]),
    ]
    for nm, n_arcs, en, ti, pid, als in nations_spec:
        upsert_entity(
            nm, "nation", n_arcs, importance="core", nation_name="", group_name="",
            title=ti, wp_post_id=pid, name_en=en, aliases=als, authoritative=True,
        )
        # Ensure exact arc set on nations (no stale arcs from Stage 1)
        entities_by_name[nm]["arcs"] = list(n_arcs)

    # 3. Add Kuro no Kiseki Organizations, Schools & Families (group_name="" for top-level orgs!)
    kuro_orgs = [
        ("亚克莱德解决事务所", "organization", "core", "卡尔瓦德共和国", "伊帝斯旧市街 · 地下万事屋", 20969, ["地下万事屋", "解决事务所", "Spriggan", "4SPG"]),
        ("游击士协会", "organization", "core", "", "守护平民安全的国际民间组织", 12623, ["游击士", "协会"]),
        ("CID", "organization", "core", "卡尔瓦德共和国", "共和国中央情报省", 30985, ["中央情报省", "情报省"]),
        ("海克力士", "organization", "supporting", "卡尔瓦德共和国", "共和国CID直属精锐谍报特务部队", 12944, ["海格力士", "CID特务部队", "Hercules"]),
        ("首都警察", "organization", "supporting", "卡尔瓦德共和国", "伊帝斯警视厅与搜查课", None, ["共和国警方"]),
        ("卡尔瓦德政府与总统府", "organization", "core", "卡尔瓦德共和国", "格兰哈特政权与共和国军", None, ["共和国政府", "共和国军"]),
        ("亚拉密斯高等学校", "organization", "core", "卡尔瓦德共和国", "共和国历史第一名校", None, ["亚拉密斯", "Aramis"]),
        ("黑月", "organization", "core", "卡尔瓦德共和国", "东方人街最大商业辛迪加", 12950, ["黑月贸易公司", "张家", "刘家"]),
        ("凶手", "organization", "supporting", "卡尔瓦德共和国", "黑月麾下秘密培养的暗杀部队", None, ["黑月凶手"]),
        ("阿玛塔", "organization", "core", "卡尔瓦德共和国", "以「恐惧」支配一切的黑帮", 39927, ["黑帮阿玛塔", "Almata", "《A》"]),
        ("庭园", "organization", "core", "卡尔瓦德共和国", "神秘暗杀组织", 39914, ["Garden", "古战场庭园"]),
        ("噬身之蛇", "organization", "core", "", "推进永劫回归计划的神秘结社", 12788, ["结社", "Ouroboros"]),
        ("星杯骑士团", "organization", "core", "亚尔特利亚法典国", "七耀教会封圣省守护骑士团", 12781, ["守护骑士"]),
        ("七耀教会", "organization", "core", "亚尔特利亚法典国", "信仰空之女神的国际宗教组织", 12603, ["教会"]),
        ("僧兵厅", "organization", "supporting", "亚尔特利亚法典国", "七耀教会典礼省下属秘密僧兵部队", 47399, ["法典国僧兵厅", "秘密僧兵"]),
        ("马尔铎克警备公司", "organization", "core", "奥雷德自治州", "尖端综合警备保障PMC", 24929, ["马尔铎克", "Marduk"]),
        ("斑鸠", "organization", "core", "卡尔瓦德共和国", "东方最强隐密武士猎兵众", 30990, ["猎兵团斑鸠", "Ikaruga"]),
        ("库鲁格战士团", "organization", "core", "艾尔萨姆公国", "中东高阶传统猎兵团", 39445, ["库鲁格", "Kruga"]),
        ("铁盾", "organization", "supporting", "艾尔萨姆公国", "中东精锐猎兵团", 39446, ["猎兵团铁盾", "Eiserne Schild"]),
        ("乌尔努公司", "organization", "supporting", "卡尔瓦德共和国", "导力重工与高科技产业巨头", 24936, ["维尔纳企业", "Verne"]),
        ("巴泽尔理科大学", "organization", "supporting", "卡尔瓦德共和国", "工学都市巴泽尔最高理工学府", None, ["巴泽尔理科大"]),
        ("季斯卡尔工房", "organization", "minor", "卡尔瓦德共和国", "巴泽尔旧市街传统精密机械职人工房", None, []),
        ("爱普斯泰恩财团", "organization", "supporting", "", "导力网络与研究最高财团", 12913, ["财团"]),
        ("餐酒馆《蒙马特》", "organization", "supporting", "卡尔瓦德共和国", "伊帝斯旧市街温馨餐酒馆", None, ["蒙马特", "Montmart"]),
        ("泰雷尔通讯社", "organization", "supporting", "卡尔瓦德共和国", "共和国主流新闻出版媒体", None, ["泰雷尔", "米修拉姆周刊"]),
        ("杂志《扒粪者》", "organization", "supporting", "卡尔瓦德共和国", "揭露政商黑幕的独立八卦调查周刊", None, ["杂志《扒糞者》", "扒粪者"]),
        ("维加斯影业", "organization", "supporting", "卡尔瓦德共和国", "导力电影巨头制片厂", None, ["导力电影界", "萨尔巴德影展"]),
        ("雷克塞尔演艺事务所", "organization", "supporting", "卡尔瓦德共和国", "卡尔瓦德知名导力电影与演艺经纪事务所", None, ["雷克塞尔事务所"]),
        ("煌都华剧场", "organization", "supporting", "卡尔瓦德共和国", "煌都兰波特传统东方戏曲剧场", None, ["华剧场"]),
        ("昆西公司", "organization", "supporting", "卡尔瓦德共和国", "共和国大型知名甜品点心食品企业", None, ["昆西社"]),
        ("D∴G教团", "organization", "supporting", "", "昔日覆灭的狂信邪教余孽渊源", 13118, ["教团"]),
        ("昆仑流", "school", "core", "卡尔瓦德共和国", "东方三大拳法之一（刚柔破劲）", None, ["昆仑门"]),
        ("泰斗流", "school", "core", "卡尔瓦德共和国", "东方三大拳法之一（刚猛霸道）", None, ["泰斗门"]),
        ("月华流", "school", "supporting", "卡尔瓦德共和国", "东方三大拳法之一（诡变暗杀）", None, ["月华门"]),
        ("八叶一刀流", "school", "core", "", "《剑仙》云·卡法伊创立剑术流派", None, ["八叶流"]),
        ("黑神一刀流", "school", "supporting", "卡尔瓦德共和国", "斑鸠传承的东方古剑术源流", None, ["黑神流"]),
        ("胧月流", "school", "supporting", "卡尔瓦德共和国", "斑鸠忍者修习的东方隐密忍术与暗器流派", None, []),
        ("克劳蒂尔家系", "family", "supporting", "卡尔瓦德共和国", "爱普斯泰恩博士后裔与格兰哈特家系", None, ["爱普斯泰恩血脉"]),
        ("卡尔瓦德前皇室", "family", "supporting", "卡尔瓦德共和国", "百年前民主化革命前的旧亚尔达里翁王朝皇族", None, ["亚尔达里翁王室", "旧卡尔瓦德王室"]),
        ("蒙马特家族", "family", "supporting", "卡尔瓦德共和国", "伊帝斯旧市街餐酒馆《蒙马特》经营者一家", None, []),
        ("卢家", "family", "supporting", "卡尔瓦德共和国", "煌都黑月笔头长老家族", None, ["兰波特卢家"]),
        ("雷家", "family", "supporting", "卡尔瓦德共和国", "原黑月次席长老家族（勾结阿玛塔后覆灭除名）", None, ["黑月雷家"]),
    ]
    parent_group_by_org = {
        "僧兵厅": "七耀教会",
        "星杯骑士团": "七耀教会",
        "海克力士": "CID",
        "凶手": "黑月",
        "卢家": "黑月",
        "雷家": "黑月",
        "巴泽尔理科大学": "乌尔努公司",
        "季斯卡尔工房": "乌尔努公司",
    }
    for nm, et, imp, nat, ti, pid, als in kuro_orgs:
        parent_grp = parent_group_by_org.get(nm, "")
        upsert_entity(
            nm, et, ["kuro"], importance=imp, nation_name=nat, group_name=parent_grp,
            title=ti, wp_post_id=pid, aliases=als, authoritative=True,
        )

    # Quotes helper from docs/kuro
    quotes_db = kuro_stats.get("quotes", {})

    def get_kuro_moments(spk_keys):
        res = []
        for k in spk_keys:
            for item in quotes_db.get(k, []):
                res.append({"chapter": f"黎之轨迹 · {item['file']}", "speaker": k, "quote": item["quote"]})
                if len(res) >= 2:
                    return res
        return res

    # Kuro Characters: (canonicalName, extraArcs, spkKeys, defaultGroup, nation, title, wpPostId, manualTier, aliases)
    kuro_chars = [
        ("范恩·亚克莱德", ["kuro"], ["范恩"], "亚克莱德解决事务所", "卡尔瓦德共和国", "《地下万事屋》所长 · 魔装鬼宿主", 20880, "core", ["范恩", "魔装鬼", "Van"]),
        ("亚妮艾丝·克劳蒂尔", ["kuro"], ["亚妮艾丝"], "亚克莱德解决事务所", "卡尔瓦德共和国", "亚拉密斯一年级生 · 事务所助手", 20885, "core", ["亚妮艾丝", "Agnes"]),
        ("菲莉·阿尔法德", ["kuro"], ["菲莉"], "亚克莱德解决事务所", "艾尔萨姆公国", "库鲁格少女战士 · 事务所助手", 20890, "core", ["菲莉", "菲莉妲", "Feri"]),
        ("亚伦·魏", ["kuro"], ["亚伦"], "亚克莱德解决事务所", "卡尔瓦德共和国", "《煌都麒麟儿》 · 大君转生", 20895, "core", ["亚伦", "麒麟儿", "大君"]),
        ("莉婕特·唐宁", ["kuro"], ["莉婕特"], "马尔铎克警备公司", "奥雷德自治州", "马尔铎克SC服务专员", 24947, "core", ["莉婕特", "Risette"]),
        ("卡特尔·萨里西翁", ["kuro"], ["卡特尔"], "亚克莱德解决事务所", "卡尔瓦德共和国", "巴泽尔天才导力学者 · 事务所助手", 24942, "core", ["卡特尔", "Quatre"]),
        ("茱迪丝·兰斯塔", ["kuro"], ["茱迪丝", "幻夜之猫"], "亚克莱德解决事务所", "卡尔瓦德共和国", "顶级导力电影女星 · 怪盗《幻夜之猫》", 28188, "core", ["茱迪丝", "幻夜之猫", "怪盗凶猫"]),
        ("贝尔加德·哲曼", ["sen", "kuro"], ["贝尔加德"], "星杯骑士团", "卡尔瓦德共和国", "《吼天狮子》巴克霍恩 · 范恩恩师", 28193, "core", ["贝尔加德", "巴克霍恩", "艮特·巴克霍恩", "吼天狮子"]),
        ("梅亚", ["kuro"], ["梅亚"], "亚克莱德解决事务所", "卡尔瓦德共和国", "范恩赛法中的特殊空洞核心", 38512, "core", ["Mare", "空洞核心梅亚"]),
        ("范格兰茨·赛恩", ["kuro"], [], "", "", "寄宿于范恩魔核的异界五大魔王之一《漂泊之魔王》", None, "supporting", ["漂泊之魔王", "魔核之王"]),
        ("艾蕾因·奥克雷尔", ["kuro"], ["艾蕾因"], "游击士协会", "卡尔瓦德共和国", "最年轻A级游击士《剑之少女》", 29455, "core", ["艾蕾因", "剑之少女", "Elaine"]),
        ("卢尼·金凯德", ["kuro"], ["金凯德"], "CID", "卡尔瓦德共和国", "CID统合分析室辅佐官", 29465, "core", ["金凯德", "卢尼"]),
        ("洛伊·格兰哈特", ["kuro"], ["格兰哈特总统"], "卡尔瓦德政府与总统府", "卡尔瓦德共和国", "卡尔瓦德共和国第23任总统", 37515, "core", ["格兰哈特总统", "格兰哈特"]),
        ("蕾恩·布莱特", ["sora", "zero_ao", "sen", "kuro"], ["蕾恩"], "亚拉密斯高等学校", "利贝尔王国", "亚拉密斯学生会长", 1355, "core", ["玲", "蕾恩", "歼灭天使"]),
        ("菲·克劳赛尔", ["sen", "kuro"], ["菲"], "游击士协会", "埃雷波尼亚帝国", "B级游击士《妖精》", 6129, "core", ["菲", "妖精"]),
        ("阵·瓦赛克", ["sora", "kuro"], ["不动的阵"], "游击士协会", "卡尔瓦德共和国", "准S级／A级游击士《不动》", 2457, "core", ["阵", "金·瓦赛克", "不动"]),
        ("雾香·楼兰", ["sora", "zero_ao", "sen", "kuro"], ["雾香"], "", "卡尔瓦德共和国", "CID统合分析室室长", 9920, "supporting", ["雾香", "红莲之轮"]),
        ("静名·蕾姆·御折木", ["kuro"], ["静名"], "斑鸠", "卡尔瓦德共和国", "斑鸠副长 · 《白银剑圣》", 32347, "core", ["静名", "静奈", "白银剑圣"]),
        ("杰拉尔·丹提斯", ["kuro"], ["杰拉尔"], "阿玛塔", "卡尔瓦德共和国", "黑帮《阿玛塔》首领", 37949, "core", ["杰拉尔", "Gerard"]),
        ("梅鲁奇欧", ["kuro"], ["梅鲁奇欧"], "阿玛塔", "卡尔瓦德共和国", "《阿玛塔》干部 · 《荆棘庭园》管理人", 37915, "core", ["梅鲁奇欧"]),
        ("薇欧菈", ["kuro"], ["薇欧菈"], "阿玛塔", "", "《阿玛塔》干部（嗜虐毒针使）", 37922, "supporting", ["薇欧菈"]),
        ("亚历山卓", ["kuro"], ["亚历山卓"], "阿玛塔", "诺森比亚自治州", "《阿玛塔》干部（前诺森比亚大公近卫）", 37931, "supporting", ["亚历山卓"]),
        ("奥林匹亚", ["kuro"], ["奥林匹亚"], "庭园", "", "《黄金庭园》管理人 · 《阿玛塔》协力者", 37943, "supporting", ["奥林匹亚"]),
        ("亚里欧契", ["kuro"], ["亚里欧契"], "庭园", "", "《铁锈庭园》管理人《鏖杀》 · 阿玛塔协力者", 37937, "supporting", ["亚里欧契", "鏖杀"]),
        ("艾尔罗伊·贺伍德", ["kuro"], ["破戒的贺伍德"], "噬身之蛇", "", "结社使徒第四柱《破戒》", 38497, "core", ["贺伍德", "破戒", "千之破戒者"]),
        ("瓦尔特·克隆", ["sora", "kuro"], ["瘦狼瓦尔特", "痩狼瓦尔特"], "噬身之蛇", "卡尔瓦德共和国", "结社执行者No.VIII《瘦狼》", 20552, "supporting", ["瓦尔特", "瓦鲁特", "瘦狼"]),
        ("露克蕾琪亚·伊斯雷", ["kuro"], ["黄金蝶露克蕾琪亚"], "噬身之蛇", "", "结社执行者No.III《黄金蝶》", 32363, "supporting", ["露克蕾琪亚", "黄金蝶"]),
        ("塞莉丝·奥提希亚", ["kuro"], ["守护骑士塞莉丝"], "星杯骑士团", "亚尔特利亚法典国", "星杯骑士团第四位《绯红》", 39796, "supporting", ["塞莉丝"]),
        ("里翁·巴塔札尔", ["kuro"], ["守护骑士里翁"], "星杯骑士团", "亚尔特利亚法典国", "星杯骑士团第十一位《苍冰》", 39798, "supporting", ["里翁"]),
        ("阿修拉德", ["kuro"], ["阿修拉德"], "僧兵厅", "亚尔特利亚法典国", "法典国僧兵厅副僧兵长", 43928, "supporting", ["亚修拉德"]),
        ("曹·李", ["zero_ao", "sen", "kuro"], ["曹"], "黑月", "卡尔瓦德共和国", "黑月干部《白兰龙》", 4547, "supporting", ["曹", "白兰龙"]),
        ("莉夏·毛", ["zero_ao", "sen", "kuro"], ["银"], "彩虹舞团", "克洛斯贝尔自治州", "传说凶手《银》 · 彩虹舞团之星", 4536, "core", ["银", "莉夏"]),
        ("亚仙·卢", ["kuro"], ["亚仙"], "黑月", "卡尔瓦德共和国", "煌都卢家千金（亚伦青梅竹马）", 37521, "supporting", ["亚仙"]),
        ("方·卢", ["kuro"], ["方"], "黑月", "卡尔瓦德共和国", "黑月兰波特支部少当家", 39883, "supporting", ["方"]),
        ("基恩·卢", ["kuro"], ["基恩老先生"], "黑月", "卡尔瓦德共和国", "黑月笔头长老", 39871, "supporting", ["基恩长老"]),
        ("丁格·布拉德", ["kuro"], ["丁格"], "杂志《扒粪者》", "卡尔瓦德共和国", "《扒粪者》独立情报记者", 37492, "supporting", ["丁格", "魔装鬼·佐尔格"]),
        ("玛莉艾儿·埃梅", ["kuro"], ["玛莉艾儿"], "泰雷尔通讯社", "卡尔瓦德共和国", "泰雷尔通讯社新晋记者", 39843, "supporting", ["玛莉艾儿", "玛莉艾儿·艾梅"]),
        ("艾德蒙·奥克雷尔", ["kuro"], [], "昆西公司", "卡尔瓦德共和国", "昆西公司董事长 · 艾蕾因之父", None, "minor", ["奥克雷尔董事长"]),
        ("波蕾特", ["kuro"], ["波蕾特"], "餐酒馆《蒙马特》", "卡尔瓦德共和国", "《蒙马特》店主 · 维克托之女", 37482, "supporting", ["波蕾特"]),
        ("梦", ["kuro"], ["梦"], "餐酒馆《蒙马特》", "卡尔瓦德共和国", "波蕾特的活泼幼女", 37487, "supporting", ["小梦"]),
        ("维克托", ["kuro"], ["维克托"], "餐酒馆《蒙马特》", "卡尔瓦德共和国", "《蒙马特》主厨兼房东大叔", 43918, "minor", ["维克托大叔"]),
        ("马克希姆·卢根", ["kuro"], ["马克希姆"], "乌尔努公司", "卡尔瓦德共和国", "乌尔努Z1厂队王牌赛车手（波蕾特旧恋人）", 39825, "supporting", ["马克希姆"]),
        ("卡希姆·阿尔法德", ["kuro"], ["卡希姆警备主任"], "马尔铎克警备公司", "艾尔萨姆公国", "马尔铎克警备主任 · 《灼飙》 · 菲莉兄长", 37552, "supporting", ["卡希姆", "灼飙"]),
        ("基利亚姆·森戴克", ["kuro"], ["森戴克总经理"], "马尔铎克警备公司", "奥雷德自治州", "马尔铎克公司总经理(GM)", 37536, "minor", ["森戴克GM", "森戴克总经理"]),
        ("米拉贝尔·亚尔顿", ["kuro"], [], "马尔铎克警备公司", "奥雷德自治州", "马尔铎克SC服务专员（莉婕特同僚）", 46962, "minor", ["米拉贝尔"]),
        ("哈桑·阿尔法德", ["kuro"], ["哈桑副头目"], "库鲁格战士团", "艾尔萨姆公国", "库鲁格战士团副首领 · 卡希姆与菲莉之父", None, "minor", ["哈桑", "哈桑副头目"]),
        ("阿伊妲", ["kuro"], ["猎兵阿伊妲"], "铁盾", "艾尔萨姆公国", "《铁盾》女性猎兵队长（菲莉义姐）", 39848, "supporting", ["猎兵阿伊妲"]),
        ("杰兰特", ["kuro"], ["杰兰特连队长"], "铁盾", "艾尔萨姆公国", "猎兵团《铁盾》连队长", None, "minor", ["杰兰特连队长"]),
        ("黑铁", ["kuro"], ["黑铁"], "斑鸠", "卡尔瓦德共和国", "《斑鸠》覆面忍者副长", 38506, "minor", ["Kurogane"]),
        ("妮娜·芬里", ["kuro"], ["妮娜"], "雷克塞尔演艺事务所", "卡尔瓦德共和国", "新世代人气女演员 · 《终结之圣女》", 38518, "supporting", ["妮娜", "终结之圣女"]),
        ("萨尔曼", ["kuro"], [], "", "艾尔萨姆公国", "艾尔萨姆公国公王 · 歇里德与吉塔之父", None, "minor", ["萨尔曼公王"]),
        ("歇里德·阿斯瓦尔", ["kuro"], ["歇里德公太子"], "艾尔萨姆公国", "艾尔萨姆公国", "艾尔萨姆公国公太子", 39849, "supporting", ["歇里德", "公太子"]),
        ("娜洁·贝尔卡", ["kuro"], ["娜洁"], "艾尔萨姆公国", "艾尔萨姆公国", "歇里德公太子贴身女护卫", 43923, "minor", ["娜洁"]),
        ("萨尔巴托雷·哥奇", ["kuro"], ["哥奇导演"], "维加斯影业", "卡尔瓦德共和国", "导力电影新锐鬼才导演", 43947, "minor", ["哥奇导演"]),
        ("贾斯柏·迪隆", ["kuro"], ["贾斯柏董事长"], "维加斯影业", "卡尔瓦德共和国", "维加斯影业董事长", 43985, "minor", ["贾斯柏董事长"]),
        ("萨菈", ["kuro"], ["萨菈"], "雷克塞尔演艺事务所", "艾尔萨姆公国", "萨尔巴德东方舞娘姐妹之姐", None, "minor", ["Saara"]),
        ("莎希娜", ["kuro"], ["莎希娜"], "雷克塞尔演艺事务所", "艾尔萨姆公国", "萨尔巴德东方舞娘姐妹之妹", None, "minor", ["Shaheena"]),
        ("克洛德·爱普斯泰恩", ["sora", "sen", "kuro"], [], "爱普斯泰恩财团", "", "导力革命之父 · 现代导力器发明者", None, "supporting", ["C·爱普斯泰恩", "爱普斯泰恩博士"]),
        ("拉托雅·汉弥尔顿", ["kuro"], ["汉弥尔顿博士"], "巴泽尔理科大学", "卡尔瓦德共和国", "导力工学三高徒之一 · 巴泽尔理科大学名誉教授", 37526, "supporting", ["汉弥尔顿博士"]),
        ("艾丝梅蕾·亚切特", ["kuro"], ["艾丝梅蕾准教授"], "巴泽尔理科大学", "卡尔瓦德共和国", "巴泽尔理科大学准教授", 37531, "minor", ["艾丝梅蕾准教授", "艾丝梅雷·亚切特"]),
        ("杨·库伦凯特", ["kuro"], ["库伦凯特教授"], "巴泽尔理科大学", "卡尔瓦德共和国", "巴泽尔天体物理派权威教授", 43964, "minor", ["库伦凯特教授"]),
        ("大卫·凯拉罕", ["kuro"], ["凯拉罕教授"], "巴泽尔理科大学", "卡尔瓦德共和国", "巴泽尔禁忌反应兵器研究者", 43969, "supporting", ["凯拉罕教授"]),
        ("季斯卡尔技术长", ["kuro"], ["季斯卡尔技术长"], "季斯卡尔工房", "卡尔瓦德共和国", "巴泽尔职人派首席技术长", 43955, "minor", ["季斯卡尔"]),
        ("达斯瓦尼", ["kuro"], ["达斯瓦尼警部"], "首都警察", "卡尔瓦德共和国", "首都警察搜查一课精英警部", 43913, "supporting", ["达斯瓦尼警部"]),
        ("奈特搜查官", ["kuro"], ["奈特搜察官"], "首都警察", "卡尔瓦德共和国", "首都警察热血年轻搜查官", 43902, "minor", ["奈特"]),
        ("艾尔维斯", ["kuro"], ["游击士艾尔维斯"], "游击士协会", "卡尔瓦德共和国", "卡尔瓦德伊帝斯支部正游击士", 43934, "supporting", ["游击士艾尔维斯"]),
        ("贝尔默提", ["kuro"], ["贝尔默提"], "亚克莱德解决事务所", "卡尔瓦德共和国", "调酒师兼地下情报贩子", 43897, "minor", ["贝尔摩提"]),
        ("杰克·崔佛", ["kuro"], ["杰克"], "亚克莱德解决事务所", "卡尔瓦德共和国", "《赌博师杰克》传奇牌手与情报屋", 39816, "minor", ["杰克"]),
        ("哈璐·科尔曼", ["kuro"], ["哈璐"], "亚克莱德解决事务所", "卡尔瓦德共和国", "杰克的王牌搭档", 39815, "minor", ["哈璐"]),
        ("亚尔贝尔", ["kuro"], ["亚尔贝尔"], "亚拉密斯高等学校", "卡尔瓦德共和国", "亚拉密斯学生会会计（暗恋亚妮艾丝）", 37502, "minor", ["亚尔贝尔"]),
        ("奥黛特", ["kuro"], ["奥黛特"], "亚拉密斯高等学校", "卡尔瓦德共和国", "亚拉密斯学生会书记（亚妮艾丝挚友）", 37510, "minor", ["奥黛特"]),
        ("艾梅丝/艾米莉亚·哈林格", ["kuro"], ["艾梅丝"], "", "卡尔瓦德共和国", "前空军王牌少校《银翼》 · 《赫尔墨斯》速递骑手", 43889, "minor", ["艾梅丝", "艾米莉亚", "赫尔墨斯"]),
        ("卡艾拉·马克米兰", ["sen", "kuro"], ["卡艾拉少尉"], "", "卡尔瓦德共和国", "共和国总统府／CID年轻少尉", 29346, "minor", ["卡艾拉少尉"]),
        ("洛克史密斯", ["zero_ao", "kuro"], ["洛克史密斯"], "", "卡尔瓦德共和国", "卡尔瓦德共和国前任总统", 9918, "supporting", ["萨缪尔·洛克史密斯", "洛克史密斯前总统"]),
        ("多明尼克·兰斯塔", ["kuro"], [], "维加斯影业", "卡尔瓦德共和国", "传奇大女优 · 初代《幻夜之猫》 · 茱迪丝外婆", 46961, "minor", ["多明尼克"]),
        ("叶花·魏", ["kuro"], [], "", "卡尔瓦德共和国", "亚伦亡母 · 煌都旧家出身", None, "minor", ["叶花"]),
        ("拉冈·坎", ["kuro"], [], "", "卡尔瓦德共和国", "四十年前煌都霸主《大君》（灵魂阴影）", None, "minor", ["大君", "煌都霸主"]),
        ("艾林格", ["kuro"], [], "阿玛塔", "卡尔瓦德共和国", "黑帮《阿玛塔》前任首领（遭杰拉尔篡位杀害）", None, "minor", ["艾林格首领"]),
        ("罗宾·格拉斯戈", ["kuro"], [], "阿玛塔", "卡尔瓦德共和国", "黑帮《阿玛塔》物资调配成员（死亡）", None, "minor", ["罗宾"]),
    ]

    for cname, char_arcs, spk_keys, grp, nat, ti, pid, tier, als in kuro_chars:
        # Never point a character's defaultGroupId to a nation!
        if grp in NATION_NAMES:
            grp = ""
        moments = get_kuro_moments(spk_keys)
        upsert_entity(
            cname=cname,
            entity_type="character",
            arcs=char_arcs,
            importance=tier,
            nation_name=nat,
            group_name=grp,
            title=ti,
            wp_post_id=pid,
            wiki_url="https://trails-game.com/character/sarah-shahina/" if cname in ("萨菈", "莎希娜") else None,
            aliases=als,
            script_moments=moments,
            authoritative=True,
        )

    # Final pass on global hubs' exact pre-Kuro2 arcs & authoritative nationality overrides
    for hub_nm, hub_arcs in GLOBAL_HUB_ARCS.items():
        if hub_nm in entities_by_name:
            entities_by_name[hub_nm]["arcs"] = sorted(hub_arcs)
    if "云·卡法伊" in entities_by_name:
        entities_by_name["云·卡法伊"]["arcs"] = ["sen", "sora"]
    for nm, nat_override in NATION_OVERRIDES.items():
        if nm in entities_by_name and entities_by_name[nm]["entityType"] != "nation":
            entities_by_name[nm]["_nationName"] = nat_override

    def append_moments(cname_raw: str, moments_list: list):
        if not moments_list:
            return
        cn = CANONICAL_NAME_MAP.get(norm_name(cname_raw), norm_name(cname_raw))
        if cn not in entities_by_name:
            return
        ent = entities_by_name[cn]
        seen_q = {m.get("quote") for m in ent["scriptMoments"]}
        for m in moments_list:
            if m.get("quote") not in seen_q:
                ent["scriptMoments"].append(dict(m))
                seen_q.add(m.get("quote"))

    # 3B. Add Kuro no Kiseki II (黎之轨迹II, S.1209 early) Organizations, Characters & Returning Cast
    for org in KURO2_NEW_ORGS:
        assert org["entityType"] in VALID_ENTITY_TYPES and org["canonicalName"] not in FORBIDDEN_ARTIFACT_NAMES
        upsert_entity(
            cname=org["canonicalName"],
            entity_type=org["entityType"],
            arcs=["kuro2"],
            importance=org["importance"],
            nation_name=org["nation"],
            group_name=org["parentGroup"],
            title=org["title"],
            wp_post_id=org["wpPostId"],
            name_en=org["nameEn"],
            aliases=org["aliases"],
            bio=org["bio"],
            authoritative=True,
        )

    for cname, spk_keys, grp, nat, ti, pid, tier, als, bio_txt in KURO2_NEW_CHARS:
        assert cname not in FORBIDDEN_ARTIFACT_NAMES, f"Forbidden artifact node {cname}!"
        if grp in NATION_NAMES:
            grp = ""
        upsert_entity(
            cname=cname,
            entity_type="character",
            arcs=["kuro2"],
            importance=tier,
            nation_name=nat,
            group_name=grp,
            title=ti,
            wp_post_id=pid,
            aliases=als,
            bio=bio_txt,
            script_moments=get_kuro2_moments(cname, spk_keys),
            authoritative=True,
        )

    for ret_nm in KURO2_RETURNING_ENTITIES:
        rcanon = CANONICAL_NAME_MAP.get(norm_name(ret_nm), norm_name(ret_nm))
        assert rcanon in entities_by_name, f"Missing KURO2 returning entity: {ret_nm} ({rcanon})"
        if "kuro2" not in entities_by_name[rcanon]["arcs"]:
            entities_by_name[rcanon]["arcs"].append("kuro2")
        append_moments(rcanon, get_kuro2_moments(rcanon))

    # 3C. Add Kai no Kiseki (界之轨迹, S.1209 mid) Organizations, Characters & Returning Cast
    for org in KAI_NEW_ORGS:
        assert org["entityType"] in VALID_ENTITY_TYPES and org["canonicalName"] not in FORBIDDEN_ARTIFACT_NAMES
        upsert_entity(
            cname=org["canonicalName"],
            entity_type=org["entityType"],
            arcs=["kai"],
            importance=org["importance"],
            nation_name=org["nation"],
            group_name=org["parentGroup"],
            title=org["title"],
            wp_post_id=org["wpPostId"],
            name_en=org["nameEn"],
            aliases=org["aliases"],
            bio=org["bio"],
            authoritative=True,
        )

    for cname, grp, nat, ti, pid, tier, als, bio_txt in KAI_NEW_CHARS:
        if cname in FORBIDDEN_ARTIFACT_NAMES:
            continue
        if grp in NATION_NAMES:
            grp = ""
        upsert_entity(
            cname=cname,
            entity_type="character",
            arcs=["kai"],
            importance=tier,
            nation_name=nat,
            group_name=grp,
            title=ti,
            wp_post_id=pid,
            aliases=als,
            bio=bio_txt,
            script_moments=KAI_SCRIPT_MOMENTS.get(cname, []),
            authoritative=True,
        )

    for ret_nm in KAI_RETURNING_ENTITIES:
        rcanon = CANONICAL_NAME_MAP.get(norm_name(ret_nm), norm_name(ret_nm))
        assert rcanon in entities_by_name, f"Missing KAI returning entity: {ret_nm} ({rcanon})"
        if "kai" not in entities_by_name[rcanon]["arcs"]:
            entities_by_name[rcanon]["arcs"].append("kai")
        append_moments(rcanon, KAI_SCRIPT_MOMENTS.get(rcanon, []))

    # 4. Assign unique clean slugs to all entities (WP-matched entities claim base slugs FIRST!)
    used_ids = set()
    slug_collisions = []
    ordered_for_slugs = sorted(
        entities_by_name.items(),
        key=lambda kv: (0 if kv[1].get("wpPostId") else 1, kv[0]),
    )
    for idx, (cname, ent) in enumerate(ordered_for_slugs, 1):
        base_slug = ""
        if ent["wpPostId"] and ent["wpPostId"] in wp_by_id:
            s = wp_by_id[ent["wpPostId"]].get("slug", "")
            if s and not s.startswith("%"):
                base_slug = s
        if not base_slug and ent["nameEn"]:
            base_slug = slugify(ent["nameEn"], idx)
        if not base_slug:
            base_slug = f"node-{idx}"
        cand = base_slug
        n = 2
        while cand in used_ids:
            cand = f"{base_slug}-{n}"
            n += 1
        if cand != base_slug:
            slug_collisions.append((cname, base_slug, cand))
        used_ids.add(cand)
        ent["id"] = cand

    # 5. Resolve _nationName and _groupName to entity IDs (preserving already-canonical group names!)
    for cname, ent in entities_by_name.items():
        nn = norm_name(ent.pop("_nationName", ""))
        nn = CANONICAL_NAME_MAP.get(nn, nn)
        raw_gn = norm_name(ent.pop("_groupName", ""))
        gn = CANONICAL_NAME_MAP.get(raw_gn, raw_gn)
        if ent["entityType"] != "nation" and nn and nn in entities_by_name and entities_by_name[nn]["entityType"] == "nation":
            ent["nationId"] = entities_by_name[nn]["id"]
        if (
            gn
            and gn in entities_by_name
            and entities_by_name[gn]["id"] != ent["id"]
            and entities_by_name[gn]["entityType"] in ("organization", "family", "school")
        ):
            ent["defaultGroupId"] = entities_by_name[gn]["id"]

    # 6. Add Cross-Arc Profile Overrides (identity, org, avatar, and cameo importance calibration)
    def set_override(cname, arc_id, **kwargs):
        cname = CANONICAL_NAME_MAP.get(norm_name(cname), norm_name(cname))
        if cname not in entities_by_name:
            return
        ent = entities_by_name[cname]
        if arc_id not in ent["arcs"]:
            return
        if "primaryGroupName" in kwargs:
            gname = kwargs.pop("primaryGroupName")
            gcanon = CANONICAL_NAME_MAP.get(norm_name(gname), norm_name(gname))
            assert gcanon in entities_by_name, f"Unknown primaryGroupName {gname} ({gcanon}) on {cname} [{arc_id}]"
            kwargs["primaryGroupId"] = entities_by_name[gcanon]["id"]
        cur_ov = ent["arcOverrides"].get(arc_id, {})
        cur_ov.update(kwargs)
        ent["arcOverrides"][arc_id] = cur_ov

    # Renne Bright (4-arc evolution)
    set_override(
        "蕾恩·布莱特", "sora",
        displayName="玲",
        title="结社执行者No.XV《歼灭天使》",
        primaryGroupName="噬身之蛇",
        avatarUrl="https://cdn.trails-game.com/wp-content/uploads/2020/08/icon_608-150x150.jpg",
        importance="core",
    )
    set_override(
        "蕾恩·布莱特", "zero_ao",
        displayName="玲",
        title="布莱特家新家人 · 导力天才少女",
        primaryGroupName="布莱特家族",
        avatarUrl="https://cdn.trails-game.com/wp-content/uploads/2020/08/icon_608-150x150.jpg",
        importance="supporting",
    )
    set_override(
        "蕾恩·布莱特", "sen",
        displayName="玲·布莱特",
        title="杰尼斯王立学院生 · 布莱特家养女",
        primaryGroupName="布莱特家族",
        avatarUrl="https://cdn.trails-game.com/wp-content/uploads/2020/08/icon_608-150x150.jpg",
        importance="supporting",
    )
    set_override(
        "蕾恩·布莱特", "kuro",
        displayName="蕾恩·布莱特",
        title="亚拉密斯高等学校学生会长",
        primaryGroupName="亚拉密斯高等学校",
        avatarUrl="https://cdn.trails-game.com/wp-content/uploads/2021/06/renne-150x150.png",
        importance="core",
    )

    # Fie Claussell
    set_override(
        "菲·克劳赛尔", "sen",
        displayName="菲·克劳赛尔",
        title="托尔兹旧第VII班 · 最年轻正游击士",
        primaryGroupName="旧VII班",
        importance="core",
    )
    set_override(
        "菲·克劳赛尔", "kuro",
        displayName="菲·克劳赛尔",
        title="赴共和国支援B级游击士《妖精》",
        primaryGroupName="游击士协会",
        importance="supporting",
    )

    # Kilika Rouran (4-arc evolution)
    set_override(
        "雾香·楼兰", "sora",
        displayName="雾香·楼兰",
        title="游击士协会 · 利贝尔蔡斯支部接待员",
        primaryGroupName="游击士协会",
        avatarUrl="https://cdn.trails-game.com/wp-content/uploads/2021/04/雾香-150x150.png",
        importance="supporting",
    )
    set_override(
        "雾香·楼兰", "zero_ao",
        displayName="雾香·楼兰",
        title="卡尔瓦德情报机关《洛克史密斯机关》室长",
        avatarUrl="https://cdn.trails-game.com/wp-content/uploads/2021/04/雾香-150x150.png",
        importance="supporting",
    )
    set_override(
        "雾香·楼兰", "sen",
        displayName="雾香·楼兰",
        title="卡尔瓦德情报机关《洛克史密斯机关》室长",
        primaryGroupName="泰斗流",
        avatarUrl="https://cdn.trails-game.com/wp-content/uploads/2021/04/雾香-150x150.png",
        importance="supporting",
    )
    set_override(
        "雾香·楼兰", "kuro",
        displayName="雾香·楼兰",
        title="卡尔瓦德中央情报省 (CID) 统合分析室室长",
        primaryGroupName="CID",
        avatarUrl="https://cdn.trails-game.com/wp-content/uploads/2023/04/kirika_kuro_avatar-150x150.png",
        importance="supporting",
    )

    # Zin Vathek
    set_override(
        "阵·瓦赛克", "sora",
        displayName="金·瓦赛克",
        title="旅居利贝尔的A级游击士《不动》",
        primaryGroupName="游击士协会",
        importance="core",
    )
    set_override(
        "阵·瓦赛克", "kuro",
        displayName="阵·瓦赛克",
        title="卡尔瓦德协会支柱 · 准S级游击士",
        primaryGroupName="游击士协会",
        importance="core",
    )

    # Bergard Zeman / Barkhorn
    set_override(
        "贝尔加德·哲曼", "sen",
        displayName="巴克霍恩",
        title="星杯骑士团前第八位正骑士 · 盖乌斯恩师",
        primaryGroupName="星杯骑士团",
        importance="supporting",
    )
    set_override(
        "贝尔加德·哲曼", "kuro",
        displayName="贝尔加德·哲曼",
        title="《吼天狮子》 · 范恩昆仑流恩师",
        primaryGroupName="亚克莱德解决事务所",
        importance="core",
    )

    # Walter Kron
    set_override(
        "瓦尔特·克隆", "sora",
        displayName="瓦鲁特",
        title="结社执行者No.VIII《瘦狼》",
        primaryGroupName="噬身之蛇",
        importance="supporting",
    )
    set_override(
        "瓦尔特·克隆", "kuro",
        displayName="瓦尔特·克隆",
        title="结社执行者No.VIII《瘦狼》 · 杀人拳达人",
        primaryGroupName="噬身之蛇",
        importance="supporting",
    )

    # Rixia Mao
    set_override(
        "莉夏·毛", "zero_ao",
        displayName="莉夏·毛",
        title="彩虹剧团新星 · 传说杀手《银》",
        primaryGroupName="彩虹舞团",
        importance="core",
    )
    set_override(
        "莉夏·毛", "sen",
        displayName="莉夏·毛",
        title="克洛斯贝尔抵抗中坚 · 彩虹剧团首席",
        primaryGroupName="特务支援课",
        importance="supporting",
    )
    set_override(
        "莉夏·毛", "kuro",
        displayName="莉夏·毛",
        title="彩虹剧团台柱 · 东方魔人《银》",
        primaryGroupName="黑月",
        importance="supporting",
    )

    # Cao Lee
    set_override(
        "曹·李", "zero_ao",
        displayName="曹·李",
        title="黑月贸易公司克洛斯贝尔支社长《白兰龙》",
        primaryGroupName="黑月",
        importance="supporting",
    )
    set_override(
        "曹·李", "sen",
        displayName="曹·李",
        title="黑月贸易公司克洛斯贝尔支社长《白兰龙》",
        primaryGroupName="黑月",
        importance="supporting",
    )
    set_override(
        "曹·李", "kuro",
        displayName="曹·李",
        title="黑月兰波特干部 · 路家当家《白兰龙》",
        primaryGroupName="黑月",
        importance="supporting",
    )

    # Shirley Orlando
    set_override(
        "谢莉·奥兰多", "zero_ao",
        title="赤色星座大队副长《血染谢莉》",
        primaryGroupName="赤色星座",
        importance="supporting",
    )
    set_override(
        "谢莉·奥兰多", "sen",
        title="结社执行者No.XVII《血染谢莉》",
        primaryGroupName="噬身之蛇",
        importance="supporting",
    )

    # Tita Russell, Kaela MacMillan & Rocksmith per-arc group overrides
    set_override(
        "缇妲·拉赛尔", "sora",
        title="蔡斯中央工房导力技师学徒",
        primaryGroupName="拉赛尔家族",
        importance="core",
    )
    set_override(
        "缇妲·拉赛尔", "sen",
        title="托尔兹第Ⅱ分校交换生 · 施密特门生",
        primaryGroupName="托尔兹第Ⅱ分校",
        importance="supporting",
    )
    set_override(
        "卡艾拉·马克米兰", "sen",
        title="共和国军洛克史密斯机关情报少尉",
        importance="minor",
    )
    set_override(
        "卡艾拉·马克米兰", "kuro",
        title="共和国中央情报省 (CID) 分析少尉",
        primaryGroupName="CID",
        importance="minor",
    )
    set_override(
        "洛克史密斯", "zero_ao",
        title="卡尔瓦德共和国第22任总统（通商会议代表）",
        importance="supporting",
    )
    set_override(
        "洛克史密斯", "kuro",
        title="卡尔瓦德共和国前任总统",
        primaryGroupName="卡尔瓦德政府与总统府",
        importance="supporting",
    )
    set_override(
        "拉碧丝·罗赞贝尔克", "sen",
        avatarUrl="https://cdn.trails-game.com/wp-content/uploads/2020/07/lapis-150x150.jpg",
    )
    set_override(
        "拉冈·坎", "kuro",
        title="四十年前煌都霸主《大君》（纠缠亚伦的灵魂阴影）",
        importance="minor",
    )
    set_override(
        "拉冈·坎", "kai",
        title="《假面武道家》 · 四十年前君临煌都的传说《大君》",
        primaryGroupName="《残滓》",
        importance="minor",
    )

    # Cameo importance calibrations so non-protagonists don't overcrowd Core view in cameo arcs
    for cameo_char, cameo_arcs in [
        ("杜巴莉", ["zero_ao"]),
        ("黑月", ["sen"]),
        ("泰斗流", ["sen"]),
        ("赛尔盖·罗", ["sen"]),
        ("诺艾尔·希卡", ["sen"]),
        ("瓦吉·赫米斯菲亚", ["sen"]),
        ("亚里欧斯·马克莱茵", ["sen"]),
        ("琪雅·班宁斯", ["sen"]),
        ("坎佩尼拉", ["sora", "zero_ao"]),
        ("雷克特·亚兰德尔", ["sora", "zero_ao"]),
        ("吉利亚斯·奥斯本", ["sora", "zero_ao"]),
        ("雪拉扎德·哈维", ["sen"]),
        ("科洛蒂娅·冯·奥赛雷丝", ["zero_ao", "sen"]),
        ("阿加特·科洛斯纳", ["sen"]),
        ("卡西乌斯·布莱特", ["sen"]),
    ]:
        for ca in cameo_arcs:
            set_override(cameo_char, ca, importance="supporting")

    # Apply Kuro II & Kai per-arc overrides (resolving primaryGroupName -> primaryGroupId)
    for ov_name, ov_dict in KURO2_ARC_OVERRIDES.items():
        ocanon = CANONICAL_NAME_MAP.get(norm_name(ov_name), norm_name(ov_name))
        assert ocanon in entities_by_name and "kuro2" in entities_by_name[ocanon]["arcs"], (
            f"KURO2_ARC_OVERRIDES target {ov_name} ({ocanon}) not active in kuro2"
        )
        set_override(ocanon, "kuro2", **dict(ov_dict))

    for ov_name, ov_dict in KAI_ARC_OVERRIDES.items():
        ocanon = CANONICAL_NAME_MAP.get(norm_name(ov_name), norm_name(ov_name))
        assert ocanon in entities_by_name and "kai" in entities_by_name[ocanon]["arcs"], (
            f"KAI_ARC_OVERRIDES target {ov_name} ({ocanon}) not active in kai"
        )
        set_override(ocanon, "kai", **dict(ov_dict))

    # Safety cleanup: ensure defaultGroupId is active in every non-overridden arc of the entity;
    # if a group only exists in a subset of the entity's arcs, scope it cleanly to those arcOverrides!
    ent_by_id_tmp = {e["id"]: e for e in entities_by_name.values()}
    for cname, ent in entities_by_name.items():
        dg = ent.get("defaultGroupId")
        if not dg:
            continue
        dg_arcs = set(ent_by_id_tmp[dg]["arcs"])
        missing_in_any = False
        for aid in ent["arcs"]:
            ov_pg = ent["arcOverrides"].get(aid, {}).get("primaryGroupId")
            if not ov_pg and aid not in dg_arcs:
                missing_in_any = True
        if missing_in_any:
            for aid in ent["arcs"]:
                if aid in dg_arcs and not ent["arcOverrides"].get(aid, {}).get("primaryGroupId"):
                    cur_ov = ent["arcOverrides"].get(aid, {})
                    cur_ov["primaryGroupId"] = dg
                    ent["arcOverrides"][aid] = cur_ov
            ent.pop("defaultGroupId", None)

    # 7. Build Relations list (Curated Evolution + Cleaned Legacy + Comprehensive Kuro)
    relations = []
    rel_index_by_sig = {}

    def add_rel(
        sname: str,
        tname: str,
        category: str,
        label: str,
        arcs: list,
        direction: str = "directed",
        weight: int = 3,
        supersedes_id: str = None,
        note: str = "",
        mutate_arcs: bool = False,
    ):
        s_canon = CANONICAL_NAME_MAP.get(norm_name(sname), norm_name(sname))
        t_canon = CANONICAL_NAME_MAP.get(norm_name(tname), norm_name(tname))
        if s_canon not in entities_by_name or t_canon not in entities_by_name:
            return None
        s_ent = entities_by_name[s_canon]
        t_ent = entities_by_name[t_canon]
        if s_ent["id"] == t_ent["id"]:
            return None

        if mutate_arcs:
            for a in arcs:
                if a not in s_ent["arcs"]:
                    s_ent["arcs"].append(a)
                if a not in t_ent["arcs"]:
                    t_ent["arcs"].append(a)

        sig = (s_ent["id"], t_ent["id"], label, tuple(sorted(set(arcs))))
        if sig in rel_index_by_sig:
            return rel_index_by_sig[sig]

        rid = f"rel-{len(relations) + 1:04d}"
        rec = {
            "id": rid,
            "source": s_ent["id"],
            "target": t_ent["id"],
            "category": category,
            "label": label,
            "direction": direction,
            "weight": weight,
            "arcs": sorted(set(arcs)),
            "status": "published",
        }
        if supersedes_id:
            rec["supersedesId"] = supersedes_id
        if note:
            rec["note"] = note
        relations.append(rec)
        rel_index_by_sig[sig] = rid
        return rid

    # Legacy xlsx rows to skip (duplicates, gender errors, or superseded by curated multi-arc evolution chains)
    xlsx_skip_exact = {
        ("路嘉·克劳赛尔", "菲·克劳赛尔", "养子"),
        ("尤西斯·艾尔巴雷亚", "旧VII班", "成员"),
        ("艾丝蒂尔·布莱特", "布莱特家族", "隶属"),
        ("罗赛莉亚", "魔女眷属", "所属"),
        ("罗赛莉亚", "薇塔·克洛提德", "弟子"),
        ("马克邦", "阿瑞安赫德", "同僚"),
        ("吉利亚斯·奥斯本", "奥利巴特·莱泽·亚诺尔", "对手"),
        ("古利亚诺斯", "罗赛莉亚", "分身?"),
        ("瑟蕾奴", "罗赛莉亚", "分身?"),
        ("米莉亚姆·奥莱恩", "尤西斯·艾尔巴雷亚", "纠缠?"),
        ("路嘉·克劳赛尔", "莎拉·巴雷斯坦", "友人"),
        ("亚修·卡拜德", "雷克特·亚兰德尔", "利用"),
        ("静名·蕾姆·御折木", "八叶一刀流", "奥传(零之型)"),
        ("艾尔贝里希", "格哈特·施密特", "师从"),
        ("星杯骑士团", "亚尔特利亚法典国", "隶属"),
        # Handled in explicit cross-arc evolution chains below:
        ("蕾恩·布莱特", "噬身之蛇", "执行者(已退出)"),
        ("蕾恩·布莱特", "布莱特家族", "养女"),
        ("菲·克劳赛尔", "游击士协会", "正游击士"),
        ("雾香·楼兰", "泰斗流", "直系"),
        ("阵·瓦赛克", "泰斗流", "直系"),
        ("瓦尔特·克隆", "泰斗流", "直系"),
        ("瓦尔特·克隆", "噬身之蛇", "执行者"),
        ("瓦尔特·克隆", "雾香·楼兰", "恋人"),
        ("贝尔加德·哲曼", "星杯骑士团", "(前)第VIII守护骑士"),
        ("莉夏·毛", "黑月", "雇主(已结束)"),
        ("谢莉·奥兰多", "赤色星座", "成员"),
        ("谢莉·奥兰多", "噬身之蛇", "执行者"),
        ("奥利巴特·莱泽·亚诺尔", "雪拉扎德·哈维", "夫妻"),
        ("艾莉·麦克道尔", "玛丽亚贝尔·克罗伊斯", "亲密的朋友"),
        ("盟主", "噬身之蛇", "创始人"),
    }

    # Explicit semantic, category & directional rewrites for legacy xlsx rows:
    # (s_canon, t_canon, raw_label) -> (new_s, new_t, category, new_label, direction, optional_arcs_override)
    xlsx_rewrites = {
        # One-way crushes / affections -> directed romance
        ("派崔克·T·海恩斯", "爱丽榭·舒华泽", "倾慕"): ("派崔克·T·海恩斯", "爱丽榭·舒华泽", "romance", "倾慕", "directed", None),
        ("悠娜·克劳福德", "黎恩·舒华泽", "倾慕"): ("悠娜·克劳福德", "黎恩·舒华泽", "romance", "倾慕", "directed", None),
        ("亚尔缇娜·奥莱恩", "黎恩·舒华泽", "倾慕"): ("亚尔缇娜·奥莱恩", "黎恩·舒华泽", "romance", "倾慕与深厚羁绊", "directed", None),
        ("妙婕·伊格瑞特", "黎恩·舒华泽", "倾慕"): ("妙婕·伊格瑞特", "黎恩·舒华泽", "romance", "倾慕", "directed", None),
        ("爱丽榭·舒华泽", "黎恩·舒华泽", "倾慕"): ("爱丽榭·舒华泽", "黎恩·舒华泽", "romance", "倾慕", "directed", None),
        ("托娃·赫歇尔", "黎恩·舒华泽", "倾慕"): ("托娃·赫歇尔", "黎恩·舒华泽", "romance", "倾慕", "directed", None),
        ("艾尔芬·莱泽·亚诺尔", "黎恩·舒华泽", "憧憬(好感)"): ("艾尔芬·莱泽·亚诺尔", "黎恩·舒华泽", "romance", "憧憬与好感", "directed", None),
        ("克蕾雅·利维特", "黎恩·舒华泽", "有好感"): ("克蕾雅·利维特", "黎恩·舒华泽", "romance", "有好感", "directed", None),
        ("菲欧娜·克雷格", "奈特哈尔", "好感"): ("菲欧娜·克雷格", "奈特哈尔", "romance", "好感", "directed", None),
        ("缇欧·普拉托", "罗伊德·班宁斯", "好感?"): ("缇欧·普拉托", "罗伊德·班宁斯", "romance", "信赖与好感", "directed", None),
        ("莉夏·毛", "罗伊德·班宁斯", "倾慕"): ("莉夏·毛", "罗伊德·班宁斯", "romance", "倾慕", "directed", None),
        ("科洛蒂娅·冯·奥赛雷丝", "约修亚·布莱特", "羁绊(爱情?)"): ("科洛蒂娅·冯·奥赛雷丝", "约修亚·布莱特", "romance", "倾慕与深厚羁绊", "directed", ["sora"]),
        ("乔丝特·卡普亚", "约修亚·布莱特", "羁绊(爱情?)"): ("乔丝特·卡普亚", "约修亚·布莱特", "romance", "欢喜冤家与倾慕", "directed", ["sora"]),
        ("托瓦尔·兰德纳", "爱因·瑟尔纳特", "憧憬(爱情?)"): ("托瓦尔·兰德纳", "爱因·瑟尔纳特", "romance", "憧憬与倾慕", "directed", ["sen"]),
        ("雪伦·克鲁格", "安敦", "被告白"): ("安敦", "雪伦·克鲁格", "romance", "一见钟情告白倾慕", "directed", None),
        ("艾莉·麦克道尔", "星少", "被有好感"): ("星少", "艾莉·麦克道尔", "romance", "一见钟情有好感", "directed", ["zero_ao"]),
        # Mutual couples & distinct romance/ally pairs
        ("艾莉·麦克道尔", "罗伊德·班宁斯", "恋爱(互相)"): ("艾莉·麦克道尔", "罗伊德·班宁斯", "romance", "两情相悦", "bidirectional", None),
        ("兰迪·奥兰多", "米蕾优", "相爱"): ("兰迪·奥兰多", "米蕾优", "romance", "相爱恋人", "bidirectional", ["zero_ao"]),
        ("尤西斯·艾尔巴雷亚", "米莉亚姆·奥莱恩", "爱情"): ("尤西斯·艾尔巴雷亚", "米莉亚姆·奥莱恩", "romance", "欢喜搭档与深切眷恋", "bidirectional", None),
        ("斯温·亚贝尔", "娜狄雅·莱茵", "必须保护的人"): ("斯温·亚贝尔", "娜狄雅·莱茵", "ally", "生死相托的搭档", "bidirectional", None),
        ("娜狄雅·莱茵", "斯温·亚贝尔", "爱情?"): ("娜狄雅·莱茵", "斯温·亚贝尔", "romance", "信赖依赖与恋慕", "directed", None),
        ("缇妲·拉赛尔", "阿加特·科洛斯纳", "羁绊(爱情?)"): ("缇妲·拉赛尔", "阿加特·科洛斯纳", "romance", "深厚羁绊与倾慕", "directed", None),
        ("阿瑞安赫德", "德莱凯尔斯·莱泽·亚诺尔", "羁绊(爱情?)"): ("阿瑞安赫德", "德莱凯尔斯·莱泽·亚诺尔", "romance", "跨越两百年的追慕与誓约", "directed", ["sen"]),
        ("奥蕾莉亚·勒瑰恩", "渥雷斯·拜尔迪安斯", "羁绊(爱情?)"): ("奥蕾莉亚·勒瑰恩", "渥雷斯·拜尔迪安斯", "romance", "武道默契与情愫", "bidirectional", None),
        ("拉碧丝·罗赞贝尔克", "卢法斯·艾尔巴雷亚", "友人(爱情?)"): ("拉碧丝·罗赞贝尔克", "卢法斯·艾尔巴雷亚", "ally", "相依同行的灵魂搭档", "bidirectional", None),
        ("雷克特·亚兰德尔", "露希·赛兰德", "同级生(爱情?)"): ("雷克特·亚兰德尔", "露希·赛兰德", "ally", "杰尼斯学生会同级旧识", "bidirectional", ["sora", "sen"]),
        # Non-hostile rows from 敌人 sheet fixed out of red dashed hostile
        ("莎拉·巴雷斯坦", "路嘉·克劳赛尔", "喜爱的大叔"): ("莎拉·巴雷斯坦", "路嘉·克劳赛尔", "ally", "敬慕喜爱的大叔前辈", "directed", None),
        ("艾莉·麦克道尔", "阿奈斯特·莱兹", "师生"): ("阿奈斯特·莱兹", "艾莉·麦克道尔", "school", "市政秘书实务指导（后堕落敌对）", "directed", ["zero_ao"]),
        ("布卢布兰", "维克多·S·亚尔赛德", "救助"): ("布卢布兰", "维克多·S·亚尔赛德", "ally", "卡雷贾斯号危难时出手救助", "directed", ["sen"]),
        ("布卢布兰", "奥利巴特·莱泽·亚诺尔", "羁绊"): ("布卢布兰", "奥利巴特·莱泽·亚诺尔", "ally", "美学竞逐与惺惺相惜", "bidirectional", ["sora", "sen"]),
        ("路嘉·克劳赛尔", "亚修·卡拜德", "赏识"): ("路嘉·克劳赛尔", "亚修·卡拜德", "ally", "豪爽赏识", "directed", None),
        ("杰诺", "菲·克劳赛尔", "友人"): ("杰诺", "菲·克劳赛尔", "family", "如兄长般疼爱守护旧团员", "directed", None),
        ("雷欧尼达斯", "菲·克劳赛尔", "友人"): ("雷欧尼达斯", "菲·克劳赛尔", "family", "如兄长般疼爱守护旧团员", "directed", None),
        ("杰诺", "莎拉·巴雷斯坦", "托付菲·克劳赛尔"): ("杰诺", "莎拉·巴雷斯坦", "ally", "托付照顾菲", "directed", None),
        ("雷欧尼达斯", "莎拉·巴雷斯坦", "托付菲·克劳赛尔"): ("雷欧尼达斯", "莎拉·巴雷斯坦", "ally", "托付照顾菲", "directed", None),
        ("阿瑞安赫德", "黎恩·舒华泽", "守护"): ("阿瑞安赫德", "黎恩·舒华泽", "hierarchy", "武道试炼与暗中守护", "directed", ["sen"]),
        ("亚尔缇娜·奥莱恩", "贵族联合", "曾潜入"): ("亚尔缇娜·奥莱恩", "贵族联合", "hierarchy", "内战时期潜伏协力", "directed", None),
        ("卢法斯·艾尔巴雷亚", "贵族联合", "潜入(已退出)"): ("卢法斯·艾尔巴雷亚", "贵族联合", "hierarchy", "任总参谋暗中架空（铁血之子卧底）", "directed", None),
        ("兰迪·奥兰多", "赤色星座", "成员(已退出)"): ("兰迪·奥兰多", "赤色星座", "membership", "原少主猎兵《斗神之子》（已叛离）", "directed", None),
        ("阿加特·科洛斯纳", "艾丽卡·拉赛尔", "对手(姻亲?)"): ("艾丽卡·拉赛尔", "阿加特·科洛斯纳", "ally", "护女心切严防死守", "directed", ["sora"]),
        ("雷克特·亚兰德尔", "黎恩·舒华泽", "传递宰相命令"): ("雷克特·亚兰德尔", "黎恩·舒华泽", "hierarchy", "传达政府委托与情报交涉", "directed", ["sen"]),
        ("雷克特·亚兰德尔", "约修亚·布莱特", "赎罪"): ("雷克特·亚兰德尔", "约修亚·布莱特", "ally", "哈梅尔旧债愧疚与协助", "directed", ["sora", "sen"]),
        # Inverted arrows & asymmetric labels fixed to Senior/Actor -> Junior/Target
        ("妙婕·伊格瑞特", "薇塔·克洛提德", "魔法的导师"): ("薇塔·克洛提德", "妙婕·伊格瑞特", "school", "传授魔女秘术的导师", "directed", None),
        ("艾略特·克雷格", "奈特哈尔", "前教官,旧识"): ("奈特哈尔", "艾略特·克雷格", "school", "前教官与旧识", "directed", None),
        ("雪伦·克鲁格", "伊琳娜·莱恩福尔特", "雇主"): ("伊琳娜·莱恩福尔特", "雪伦·克鲁格", "hierarchy", "莱恩福尔特家主与贴身女仆", "directed", None),
        ("杰诺", "贵族联合", "雇主"): ("杰诺", "贵族联合", "hierarchy", "内战受雇猎兵干部", "directed", None),
        ("艾尔贝里希", "伊修麦格", "君主"): ("伊修麦格", "艾尔贝里希", "hierarchy", "支配黑之工房长的元凶君主", "directed", None),
        ("米莉亚姆·奥莱恩", "艾尔贝里希", "创造者"): ("艾尔贝里希", "米莉亚姆·奥莱恩", "hierarchy", "人造人创造者与支配企图", "directed", None),
        ("亚尔缇娜·奥莱恩", "艾尔贝里希", "创造者"): ("艾尔贝里希", "亚尔缇娜·奥莱恩", "hierarchy", "人造人创造者与支配企图", "directed", None),
        ("约修亚·布莱特", "盖鲁格·怀斯曼", "利用"): ("盖鲁格·怀斯曼", "约修亚·布莱特", "hostile", "心理暗示洗脑与残酷利用", "directed", ["sora"]),
        ("蕾恩·布莱特", "弗朗茨·诺华提斯", "被利用"): ("弗朗茨·诺华提斯", "蕾恩·布莱特", "hostile", "帕蒂尔·玛蒂尔实验利用", "directed", ["zero_ao", "sen"]),
        ("悠娜·克劳福德", "克蕾雅·利维特", "警察学校时期的恩人"): ("克蕾雅·利维特", "悠娜·克劳福德", "ally", "警察学校时期的恩人讲师", "directed", ["sen"]),
        ("阿加特·科洛斯纳", "卡西乌斯·布莱特", "恩人"): ("卡西乌斯·布莱特", "阿加特·科洛斯纳", "ally", "指引重生的恩人前辈", "directed", ["sora"]),
        ("雷欧尼达斯", "路嘉·克劳赛尔", "恩人"): ("路嘉·克劳赛尔", "雷欧尼达斯", "ally", "收留提携的团长恩人", "directed", ["sen"]),
        ("雷欧尼达斯", "加尔西亚·罗西", "恩人"): ("雷欧尼达斯", "加尔西亚·罗西", "ally", "西风旅团旧日战友", "bidirectional", ["sen"]),
        ("盖·班宁斯", "缇欧·普拉托", "恩人"): ("盖·班宁斯", "缇欧·普拉托", "ally", "救出教团的救命恩人", "directed", ["zero_ao"]),
        ("吉利亚斯·奥斯本", "克蕾雅·利维特", "恩人"): ("吉利亚斯·奥斯本", "克蕾雅·利维特", "hierarchy", "扶持雪冤的恩人宰相", "directed", ["sen"]),
        ("雷克特·亚兰德尔", "亚修·卡拜德", "利用"): ("雷克特·亚兰德尔", "亚修·卡拜德", "hierarchy", "情报监管与政治利用", "directed", ["sen"]),
        ("玛丽亚贝尔·克罗伊斯", "亚里欧斯·马克莱茵", "利用"): ("玛丽亚贝尔·克罗伊斯", "亚里欧斯·马克莱茵", "hierarchy", "幻之至宝计划拉拢与利用", "directed", ["zero_ao"]),
        ("玛丽亚贝尔·克罗伊斯", "琪雅·班宁斯", "利用"): ("玛丽亚贝尔·克罗伊斯", "琪雅·班宁斯", "hostile", "幻之至宝计划利用", "directed", ["zero_ao"]),
        ("琪雅·班宁斯", "玛丽亚贝尔·克罗伊斯", "促使觉醒"): ("琪雅·班宁斯", "玛丽亚贝尔·克罗伊斯", "hierarchy", "促使其炼金术力量觉醒", "directed", ["zero_ao"]),
        ("吉利亚斯·奥斯本", "伊修麦格", "利用"): ("吉利亚斯·奥斯本", "伊修麦格", "hostile", "背负诅咒反向算计终结元凶", "directed", ["sen"]),
        ("吉利亚斯·奥斯本", "卡尔·雷格尼兹", "利用"): ("吉利亚斯·奥斯本", "卡尔·雷格尼兹", "hierarchy", "政治博弈与施压利用", "directed", ["sen"]),
        ("克洛·安布斯特", "吉利亚斯·奥斯本", "因故乡被夺取而憎恨"): ("克洛·安布斯特", "吉利亚斯·奥斯本", "hostile", "因故乡茱莱被吞并而复仇", "directed", ["sen"]),
        ("盟主", "玛丽亚贝尔·克罗伊斯", "邀请"): ("盟主", "玛丽亚贝尔·克罗伊斯", "hierarchy", "邀任蛇之使徒第三柱", "directed", ["zero_ao", "sen"]),
        ("盟主", "阿瑞安赫德", "邀请"): ("盟主", "阿瑞安赫德", "hierarchy", "邀任蛇之使徒第七柱", "directed", ["zero_ao", "sen"]),
        ("盟主", "莱维", "邀请"): ("盟主", "莱维", "hierarchy", "招揽为执行者《剑帝》", "directed", ["sora"]),
        ("盟主", "坎佩尼拉", "委托"): ("盟主", "坎佩尼拉", "hierarchy", "委派见证永劫回归计划", "directed", ["sora", "zero_ao", "sen"]),
        ("罗赛莉亚", "古利亚诺斯", "创造者"): ("罗赛莉亚", "古利亚诺斯", "family", "创造者与分身使魔", "directed", ["sen"]),
        ("罗赛莉亚", "瑟蕾奴", "创造者"): ("罗赛莉亚", "瑟蕾奴", "family", "创造者与分身使魔", "directed", ["sen"]),
        ("阿瑞安赫德", "马克邦", "同僚"): ("阿瑞安赫德", "马克邦", "hierarchy", "结社使徒与执行者同僚", "bidirectional", ["sen"]),
        ("奥利巴特·莱泽·亚诺尔", "吉利亚斯·奥斯本", "对手"): ("奥利巴特·莱泽·亚诺尔", "吉利亚斯·奥斯本", "hostile", "帝国皇道派与铁血革新派宿敌", "bidirectional", ["sora", "zero_ao", "sen"]),
        ("克洛·安布斯特", "薇塔·克洛提德", "骑神引导者"): ("薇塔·克洛提德", "克洛·安布斯特", "hierarchy", "苍之骑神引导者与搭档", "directed", ["sen"]),
        ("卢法斯·艾尔巴雷亚", "克洛斯贝尔自治州", "支配"): ("卢法斯·艾尔巴雷亚", "克洛斯贝尔自治州", "hostile", "首任总督占领支配", "directed", ["sen"]),
        ("露希·赛兰德", "赛兰德教授", "子侄"): ("露希·赛兰德", "赛兰德教授", "family", "侄女", "directed", ["sen"]),
        # Tactical shells & archaic weapons (clear operator -> unit semantics)
        ("米莉亚姆·奥莱恩", "《银臂》", "战术壳"): ("米莉亚姆·奥莱恩", "《银臂》", "hierarchy", "操控战术壳", "directed", ["sen"]),
        ("亚尔缇娜·奥莱恩", "《光剑》", "战术壳"): ("亚尔缇娜·奥莱恩", "《光剑》", "hierarchy", "操控战术壳", "directed", ["sen"]),
        ("蕾恩·布莱特", "帕蒂尔·玛蒂尔", "战术壳"): ("蕾恩·布莱特", "帕蒂尔·玛蒂尔", "hierarchy", "驾驭人形兵器", "directed", ["sora"]),
        # Clean up legacy xlsx draft '?' & slang labels
        ("安洁莉卡·罗格纳", "蕾恩·布莱特", "lolicon"): ("安洁莉卡·罗格纳", "蕾恩·布莱特", "ally", "宠溺喜爱美少女", "directed", ["sen"]),
        ("安洁莉卡·罗格纳", "缇妲·拉赛尔", "lolicon"): ("安洁莉卡·罗格纳", "缇妲·拉赛尔", "ally", "宠溺喜爱美少女", "directed", ["sen"]),
        ("安洁莉卡·罗格纳", "琪雅·班宁斯", "lolicon"): ("安洁莉卡·罗格纳", "琪雅·班宁斯", "ally", "宠溺喜爱美少女", "directed", ["sen"]),
        ("库尔特·范德尔", "修利·阿多雷德", "公主抱"): ("库尔特·范德尔", "修利·阿多雷德", "ally", "克洛斯贝尔偶遇搭救", "directed", ["sen"]),
        ("黎恩·舒华泽", "新VII班", "级任教官(班主任?)"): ("黎恩·舒华泽", "新VII班", "membership", "特科班级任教官", "directed", ["sen"]),
        ("卢法斯·艾尔巴雷亚", "艾尔巴雷亚家族", "表兄?堂兄?(大少)"): ("卢法斯·艾尔巴雷亚", "艾尔巴雷亚家族", "family", "名义长子（实为叔父私生子）", "directed", ["sen"]),
        ("尤肯特Ⅲ世", "埃雷波尼亚帝国", "当代皇帝?"): ("尤肯特Ⅲ世", "埃雷波尼亚帝国", "membership", "当代皇帝", "directed", ["sen"]),
        ("德莱凯尔斯·莱泽·亚诺尔", "亚诺尔皇族", "老祖宗?"): ("德莱凯尔斯·莱泽·亚诺尔", "亚诺尔皇族", "family", "中兴始祖（第73代狮心皇帝）", "directed", ["sen"]),
        ("罗伊德·班宁斯", "玛丽亚贝尔·克罗伊斯", "对手(情敌?)"): ("罗伊德·班宁斯", "玛丽亚贝尔·克罗伊斯", "hostile", "理念交锋与围绕艾莉的竞争", "bidirectional", ["zero_ao", "sen"]),
        ("雪拉扎德·哈维", "游击士(利贝尔支部)", "A级游击士(已退出?)"): ("雪拉扎德·哈维", "游击士(利贝尔支部)", "membership", "正游击士《银闪》", "directed", ["sora"]),
        ("菲·克劳赛尔", "西风旅团", "成员(已退出)"): ("菲·克劳赛尔", "西风旅团", "membership", "前猎兵团员（已退出）", "directed", ["sen", "kuro"]),
    }

    # Import cleaned legacy relations WITHOUT mutating endpoint entity arcs
    for r in xlsx["relations"]:
        s_raw, t_raw = r.get("source", ""), r.get("target", "")
        if not s_raw or not t_raw:
            continue
        s_c = CANONICAL_NAME_MAP.get(norm_name(s_raw), norm_name(s_raw))
        t_c = CANONICAL_NAME_MAP.get(norm_name(t_raw), norm_name(t_raw))
        lb_raw = norm_name(r.get("Relation", "关联"))
        if (s_c, t_c, lb_raw) in xlsx_skip_exact:
            continue
        if s_c not in entities_by_name or t_c not in entities_by_name:
            continue

        note = norm_name(r.get("备注", "") or "")
        if (s_c, t_c, lb_raw) in xlsx_rewrites:
            ns, nt, cat, nlb, dirc, ov_arcs = xlsx_rewrites[(s_c, t_c, lb_raw)]
            if ov_arcs is not None:
                edge_arcs = ov_arcs
            else:
                s_arcs = set(entities_by_name[ns]["arcs"]) - {"kuro", "kuro2", "kai"}
                t_arcs = set(entities_by_name[nt]["arcs"]) - {"kuro", "kuro2", "kai"}
                edge_arcs = sorted(s_arcs & t_arcs) or sorted(s_arcs | t_arcs) or ["sen"]
            add_rel(
                ns, nt, cat, nlb,
                arcs=edge_arcs,
                direction=dirc,
                weight=4 if cat in ("family", "romance", "school") else 3,
                note=note,
                mutate_arcs=False,
            )
            continue

        s_arcs = set(entities_by_name[s_c]["arcs"]) - {"kuro", "kuro2", "kai"}
        t_arcs = set(entities_by_name[t_c]["arcs"]) - {"kuro", "kuro2", "kai"}
        shared_legacy = sorted(s_arcs & t_arcs)
        if not shared_legacy:
            shared_all = sorted(
                (set(entities_by_name[s_c]["arcs"]) - {"kuro2", "kai"})
                & (set(entities_by_name[t_c]["arcs"]) - {"kuro2", "kai"})
            )
            # For cross-arc backstory links (e.g. Arianrhod/McBurn/Duvalie -> Loewe), include both sides' legacy arcs
            # WITHOUT mutating entity["arcs"] so single-arc views stay pure and All-Zemuria shows the bond!
            edge_arcs = shared_all if shared_all else sorted(s_arcs | t_arcs or {"sen"})
        else:
            edge_arcs = shared_legacy

        cat = map_relation_category(r.get("RelationType", ""), lb_raw)
        # Keep asymmetric labels directed rather than blindly forcing bidirectional
        is_asym = any(
            w in lb_raw
            for w in ("憧憬", "使魔", "守护兽", "战术壳", "喜爱", "启动者", "创始人", "指引", "挑战", "试炼", "保护", "支持", "教官", "上司")
        )
        bidir = (cat in ("ally", "romance", "hostile") or lb_raw == "同僚") and not is_asym
        add_rel(
            s_c, t_c, cat, lb_raw,
            arcs=edge_arcs,
            direction="bidirectional" if bidir else "directed",
            weight=4 if cat in ("family", "romance", "school") else 3,
            note=note,
            mutate_arcs=False,
        )

    # Restore Franz Reinford -> Professor Schmidt mentorship (moved off possessed persona Black Alberich)
    add_rel("弗兰兹·莱恩福尔特", "格哈特·施密特", "school", "导力工学高徒师从", ["sen"], "directed", 4)

    # 8. Curated Cross-Arc Evolution Chains (supersedesId) & Missing Sora / Zero-Ao / Sen Lore Bridges
    # Global Septian Church & Ouroboros foundations across all 4 arcs
    add_rel("盟主", "噬身之蛇", "hierarchy", "结社创立者与最高统帅", ["sora", "zero_ao", "sen"], "directed", 5)
    add_rel("星杯骑士团", "七耀教会", "hierarchy", "封圣省直属武装骑士团", ["sora", "zero_ao", "sen", "kuro"], "directed", 5)
    add_rel("七耀教会", "亚尔特利亚法典国", "membership", "总本山所在地", ["sora", "zero_ao", "sen", "kuro"], "directed", 5)
    add_rel("星杯骑士团", "亚尔特利亚法典国", "membership", "封圣省驻地", ["sora", "zero_ao", "sen", "kuro"], "directed", 4)
    add_rel("杜巴莉", "阿瑞安赫德", "hierarchy", "铁机队笔头 · 绝对崇敬效忠主君", ["zero_ao", "sen"], "directed", 5)
    add_rel("拉碧丝·罗赞贝尔克", "斯温·亚贝尔", "ally", "新生帝国解放战线搭档", ["sen"], "bidirectional", 4)
    add_rel("拉碧丝·罗赞贝尔克", "娜狄雅·莱茵", "ally", "野餐队挚友伙伴", ["sen"], "bidirectional", 4)

    # Renne Bright evolution
    rid_renne_ouro = add_rel("蕾恩·布莱特", "噬身之蛇", "membership", "执行者No.XV《歼灭天使》", ["sora"], "directed", 5)
    add_rel(
        "蕾恩·布莱特", "噬身之蛇", "hierarchy", "已脱离结社（保留情报往来）", ["zero_ao", "sen", "kuro"], "bidirectional", 3,
        supersedes_id=rid_renne_ouro, note="跨作关系演变：空轨3rd与零轨后正式脱离结社。",
    )
    add_rel("蕾恩·布莱特", "布莱特家族", "family", "养女（克洛斯贝尔重逢后正式收养）", ["zero_ao", "sen"], "directed", 5)

    # Fie Claussell evolution
    rid_fie_guild_sen = add_rel("菲·克劳赛尔", "游击士协会", "membership", "帝国支部最年轻正游击士《妖精》", ["sen"], "directed", 4)
    add_rel(
        "菲·克劳赛尔", "游击士协会", "membership", "赴共和国支援B级游击士《妖精》", ["kuro"], "directed", 4,
        supersedes_id=rid_fie_guild_sen, note="跨作关系演变：从帝国年轻正游击士成长为跨国支援的B级王牌。",
    )

    # Kilika Rouran evolution
    rid_kilika_guild = add_rel("雾香·楼兰", "游击士协会", "membership", "利贝尔蔡斯支部接待员", ["sora"], "directed", 4)
    add_rel(
        "雾香·楼兰", "CID", "membership", "统合分析室室长（改组自洛克史密斯机关）", ["kuro"], "directed", 5,
        supersedes_id=rid_kilika_guild, note="跨作关系演变：空轨3rd后辞去游击士协会职务回国执掌洛克史密斯机关与CID。",
    )
    rid_kilika_taito = add_rel("雾香·楼兰", "泰斗流", "school", "宗师龙牙之女·直系传人", ["sora"], "directed", 4)
    add_rel(
        "雾香·楼兰", "泰斗流", "school", "宗师龙牙之女（圆环武术达人）", ["sen", "kuro"], "directed", 4,
        supersedes_id=rid_kilika_taito, note="跨作关系演变：传承泰斗流圆环暗器并指导后辈。",
    )
    add_rel("雾香·楼兰", "洛克史密斯", "hierarchy", "总统直辖情报机关《洛克史密斯机关》室长", ["zero_ao"], "directed", 4)
    add_rel("洛克史密斯", "克洛斯贝尔自治州", "hierarchy", "出席西塞姆利亚通商会议", ["zero_ao"], "directed", 3)

    # Zin Vathek evolution & Sora party ties
    rid_zin_guild = add_rel("阵·瓦赛克", "游击士协会", "membership", "旅居利贝尔的A级游击士《不动》", ["sora"], "directed", 5)
    add_rel(
        "阵·瓦赛克", "游击士协会", "membership", "卡尔瓦德协会中流砥柱 · 准S级", ["kuro"], "directed", 5,
        supersedes_id=rid_zin_guild, note="跨作关系演变：自利贝尔异变归国后成为共和国游击士协会最高领袖。",
    )
    rid_zin_taito = add_rel("阵·瓦赛克", "泰斗流", "school", "龙牙直系弟子", ["sora"], "directed", 4)
    add_rel(
        "阵·瓦赛克", "泰斗流", "school", "泰斗流正统宗家传人", ["kuro"], "directed", 5,
        supersedes_id=rid_zin_taito, note="跨作关系演变：担负振兴泰斗流正统重任。",
    )
    add_rel("阵·瓦赛克", "艾丝蒂尔·布莱特", "ally", "武术点拨与游击士前辈伙伴", ["sora"], "bidirectional", 4)
    add_rel("阵·瓦赛克", "卡西乌斯·布莱特", "ally", "S级与A级武道知己", ["sora"], "bidirectional", 4)
    add_rel("阵·瓦赛克", "瓦尔特·克隆", "hostile", "泰斗流同门宿敌", ["sora", "kuro"], "bidirectional", 5)
    add_rel("阵·瓦赛克", "雾香·楼兰", "ally", "同门师兄妹 · 多年默契", ["sora", "kuro"], "bidirectional", 4)

    # Walter Kron evolution
    rid_walter_ouro = add_rel("瓦尔特·克隆", "噬身之蛇", "membership", "执行者No.VIII《瘦狼》（福音计划）", ["sora"], "directed", 4)
    add_rel(
        "瓦尔特·克隆", "噬身之蛇", "membership", "执行者No.VIII《瘦狼》（共和国行动）", ["kuro"], "directed", 5,
        supersedes_id=rid_walter_ouro, note="跨作关系演变：随破戒重返故土卡尔瓦德展开行动。",
    )
    rid_walter_taito = add_rel("瓦尔特·克隆", "泰斗流", "school", "弑师叛门的狂暴师兄", ["sora"], "directed", 4)
    add_rel(
        "瓦尔特·克隆", "泰斗流", "school", "叛门师兄（习得杀人拳）", ["kuro"], "directed", 4,
        supersedes_id=rid_walter_taito, note="跨作关系演变：将泰斗流凶拳锤炼至极致。",
    )
    rid_walter_kilika = add_rel("瓦尔特·克隆", "雾香·楼兰", "romance", "同门师兄妹与昔日恋人", ["sora"], "bidirectional", 4)
    add_rel(
        "瓦尔特·克隆", "雾香·楼兰", "ally", "昔日同门旧恋人（立场各异）", ["kuro"], "bidirectional", 4,
        supersedes_id=rid_walter_kilika, note="跨作关系演变：虽分属结社与CID，仍留存旧日因缘。",
    )

    # Bergard Zeman evolution & Gaius mentorship in Sen
    rid_bergard_grals = add_rel("贝尔加德·哲曼", "星杯骑士团", "membership", "(前)第八位守护骑士《吼天狮子》", ["sen"], "directed", 4)
    add_rel(
        "贝尔加德·哲曼", "星杯骑士团", "membership", "番外守护骑士（假死隐退后回归协力）", ["kuro"], "directed", 4,
        supersedes_id=rid_bergard_grals, note="跨作关系演变：将圣痕传予盖乌斯后以番外骑士身份周游大陆。",
    )
    add_rel("贝尔加德·哲曼", "盖乌斯·沃泽尔", "school", "传授圣痕与武艺的恩师", ["sen"], "directed", 5)

    # Rixia Mao & Cao Lee evolution
    rid_rixia_heiyue = add_rel("莉夏·毛", "黑月", "hierarchy", "旧契约雇主（已赎身解除）", ["zero_ao", "sen"], "directed", 3)
    add_rel(
        "莉夏·毛", "黑月", "hierarchy", "契约魔人《银》短期协助", ["kuro"], "bidirectional", 4,
        supersedes_id=rid_rixia_heiyue, note="跨作关系演变：为守护东方人街秩序再度以《银》之名受托协助。",
    )
    rid_cao_heiyue = add_rel("曹·李", "黑月", "membership", "克洛斯贝尔支社长《白兰龙》", ["zero_ao", "sen"], "directed", 4)
    add_rel(
        "曹·李", "黑月", "membership", "路家当家 · 兰波特《白兰龙》干部", ["kuro"], "directed", 5,
        supersedes_id=rid_cao_heiyue, note="跨作关系演变：自克洛斯贝尔支社回归共和国本家权力核心。",
    )
    add_rel("曹·李", "特务支援课", "hierarchy", "地下情报交易与智谋博弈", ["zero_ao", "sen"], "bidirectional", 4)
    add_rel("曹·李", "鲁巴彻商会", "hostile", "克洛斯贝尔黑道霸权争夺", ["zero_ao"], "bidirectional", 4)
    add_rel("曹·李", "莉夏·毛", "hierarchy", "黑月契约委托与拉拢试探", ["zero_ao", "kuro"], "bidirectional", 4)

    # Shirley Orlando, Olivert/Scherazard & Elie/Mariabell evolutions
    rid_shirley_rc = add_rel("谢莉·奥兰多", "赤色星座", "membership", "大队副长《血染谢莉》", ["zero_ao"], "directed", 4)
    add_rel(
        "谢莉·奥兰多", "噬身之蛇", "membership", "执行者No.XVII《血染谢莉》（自赤色星座加入）", ["sen"], "directed", 4,
        supersedes_id=rid_shirley_rc, note="跨作关系演变：碧轨决战后受坎佩尼拉招揽成为结社执行者。",
    )
    rid_olivert_schera = add_rel("奥利巴特·莱泽·亚诺尔", "雪拉扎德·哈维", "romance", "游历利贝尔结下的默契与好感", ["sora"], "bidirectional", 4)
    add_rel(
        "奥利巴特·莱泽·亚诺尔", "雪拉扎德·哈维", "romance", "皇子与王妃（闪轨IV喜结连理）", ["sen"], "bidirectional", 5,
        supersedes_id=rid_olivert_schera, note="跨作关系演变：历经千阳作战后正式举行盛大皇室婚礼。",
    )
    rid_elie_bell = add_rel("艾莉·麦克道尔", "玛丽亚贝尔·克罗伊斯", "ally", "青梅竹马的亲密闺蜜", ["zero_ao"], "bidirectional", 4)
    add_rel(
        "艾莉·麦克道尔", "玛丽亚贝尔·克罗伊斯", "hostile", "理念决裂却仍盼挽回的挚友", ["sen"], "bidirectional", 4,
        supersedes_id=rid_elie_bell, note="跨作关系演变：玛丽亚贝尔出任结社第三柱后双方立场对立但羁绊犹存。",
    )

    # Orphan fixes & missing Sora / Zero-Ao / Sen structural links
    add_rel("科洛蒂娅·冯·奥赛雷丝", "利贝尔王家", "family", "王太女（艾莉茜雅女王孙女）", ["sora"], "directed", 5)
    add_rel("亚妮拉丝·艾尔菲德", "游击士(利贝尔支部)", "membership", "正游击士", ["sora"], "directed", 4)
    add_rel("盖·班宁斯", "克洛斯贝尔警察局", "membership", "原搜查官（殉职）", ["zero_ao"], "directed", 4)
    add_rel("星少", "黑月", "family", "黑月卢家长老孙少爷", ["zero_ao"], "directed", 3)
    add_rel("阿尔伯特·拉赛尔", "爱普斯泰恩财团", "hierarchy", "爱普斯泰恩博士直系高徒·技术合作", ["sora"], "directed", 4)
    add_rel("阿尔伯特·拉赛尔", "克洛德·爱普斯泰恩", "school", "师从（导力工学三高徒之一）", ["sora"], "directed", 5)
    add_rel("格哈特·施密特", "克洛德·爱普斯泰恩", "school", "师从（导力工学三高徒之一）", ["sen"], "directed", 5)
    add_rel("克洛德·爱普斯泰恩", "爱普斯泰恩财团", "hierarchy", "导力革命之父 · 财团冠名先驱", ["sora", "sen", "kuro"], "directed", 5)
    add_rel("赛尔盖·罗", "特务支援课", "membership", "特务支援课创设课长", ["zero_ao", "sen"], "directed", 5)
    add_rel("亚历克斯·达德利", "特务支援课", "ally", "搜查一课精英协力共斗", ["zero_ao", "sen"], "bidirectional", 4)
    add_rel("亚历克斯·达德利", "罗伊德·班宁斯", "ally", "刑警前辈与共斗搭档", ["zero_ao"], "bidirectional", 4)
    add_rel("修利·阿多雷德", "彩虹舞团", "membership", "潜力新星舞者", ["zero_ao", "sen"], "directed", 4)
    add_rel("伊莉娅·普拉缇耶", "修利·阿多雷德", "school", "发掘指导的剧团前辈", ["zero_ao", "sen"], "directed", 4)
    add_rel("加尔西亚·罗西", "鲁巴彻商会", "membership", "二当家《杀戮熊》", ["zero_ao"], "directed", 4)
    add_rel("加尔西亚·罗西", "西风旅团", "membership", "原部队长（已退出）", ["zero_ao", "sen"], "directed", 3)
    add_rel("罗伊德·班宁斯", "加尔西亚·罗西", "ally", "拘留所越狱共斗的义气对手", ["zero_ao"], "bidirectional", 4)
    add_rel("凯文·格拉汉姆", "罗伊德·班宁斯", "ally", "梅尔卡巴潜入支援特务支援课", ["zero_ao"], "bidirectional", 4)
    add_rel("莉丝·亚尔珍特", "特务支援课", "ally", "随行支援克洛斯贝尔危机", ["zero_ao"], "directed", 3)
    add_rel("科洛蒂娅·冯·奥赛雷丝", "艾莉·麦克道尔", "ally", "西塞姆利亚通商会议与千阳作战盟友", ["zero_ao", "sen"], "bidirectional", 3)
    add_rel("斯卡蕾特", "帝国解放战线", "membership", "原干部《S》（已赎罪）", ["sen"], "directed", 4)
    add_rel("卡艾拉·马克米兰", "雾香·楼兰", "hierarchy", "洛克史密斯机关情报部下（千阳作战联络）", ["sen"], "directed", 3)
    add_rel("露希·赛兰德", "雷米菲利亚公国", "membership", "雷米菲利亚公国大公秘书官", ["sen"], "directed", 4)
    add_rel("赛兰德教授", "雷米菲利亚公国", "membership", "雷米菲利亚权威医学教授", ["zero_ao", "sen"], "directed", 3)
    add_rel("雷米菲利亚公国", "克洛斯贝尔自治州", "ally", "通商会议与乌尔斯拉医疗合作盟邦", ["zero_ao"], "bidirectional", 4)
    add_rel("雷米菲利亚公国", "埃雷波尼亚帝国", "hierarchy", "北方邻邦与千阳作战反抗同盟", ["sen"], "bidirectional", 4)
    add_rel("北方猎兵", "诺森比亚自治州", "membership", "前公国军改组之国家支柱猎兵团", ["sen"], "directed", 5)
    add_rel("诺森比亚自治州", "埃雷波尼亚帝国", "hostile", "北方战役交战与一度并入帝国属州", ["sen"], "bidirectional", 4)

    # 9. Comprehensive Kuro no Kiseki Relationships
    kuro_rels = [
        # Macro Geopolitics, Church Orders & Gramhart Secret Contracts
        ("亚克莱德解决事务所", "卡尔瓦德共和国", "membership", "扎根首都伊帝斯旧市街", "directed", 4),
        ("CID", "卡尔瓦德政府与总统府", "hierarchy", "总统直辖国家情报中枢", "directed", 5),
        ("海克力士", "CID", "hierarchy", "CID直属精锐谍报特务部队", "directed", 5),
        ("首都警察", "卡尔瓦德政府与总统府", "hierarchy", "治安执法机构", "directed", 4),
        ("卡尔瓦德政府与总统府", "卡尔瓦德共和国", "hierarchy", "执政中枢", "directed", 5),
        ("卡尔瓦德政府与总统府", "斑鸠", "hierarchy", "格兰哈特总统秘密雇佣契约", "bidirectional", 4),
        ("卡尔瓦德政府与总统府", "马尔铎克警备公司", "hierarchy", "次世代兵器研发与安保测试合作", "bidirectional", 4),
        ("亚拉密斯高等学校", "卡尔瓦德共和国", "membership", "首都第一名门学府", "directed", 4),
        ("黑月", "卡尔瓦德共和国", "membership", "煌都兰波特东方人街根据地", "directed", 4),
        ("卢家", "黑月", "membership", "煌都黑月笔头长老家", "directed", 5),
        ("雷家", "黑月", "membership", "原次席长老家（勾结外敌后垮台除名）", "directed", 4),
        ("凶手", "黑月", "membership", "隶属（黑月培养的杀手组织）", "directed", 4, "黑月培养的杀手组织"),
        ("阿玛塔", "卡尔瓦德共和国", "hostile", "在各地散播恐慌与泛魔化", "directed", 5),
        ("黑月", "阿玛塔", "hostile", "地下社会霸权全面抗争", "bidirectional", 5),
        ("雷家", "阿玛塔", "hierarchy", "暗中勾结策划复活大君", "bidirectional", 3),
        ("庭园", "阿玛塔", "hierarchy", "合流并暗中提供刺客支援", "bidirectional", 4),
        ("阿玛塔", "D∴G教团", "hierarchy", "吸收旧教团遗产与残党", "directed", 3),
        ("马尔铎克警备公司", "奥雷德自治州", "membership", "总部位于奥雷德", "directed", 4),
        ("库鲁格战士团", "艾尔萨姆公国", "membership", "中东传统守护猎兵氏族", "directed", 4),
        ("库鲁格战士团", "马尔铎克警备公司", "hierarchy", "技术合作", "bidirectional", 4),
        ("铁盾", "艾尔萨姆公国", "membership", "中东精锐猎兵团", "directed", 3),
        ("库鲁格战士团", "铁盾", "hostile", "猎兵界长期劲敌竞争", "bidirectional", 4),
        ("斑鸠", "黑神一刀流", "school", "传承东方古剑术体系", "directed", 4),
        ("胧月流", "斑鸠", "school", "斑鸠隐密忍众修习流派之一", "directed", 3),
        ("黑神一刀流", "八叶一刀流", "school", "剑术源流渊源", "bidirectional", 3),
        ("乌尔努公司", "卡尔瓦德共和国", "membership", "工学都市巴泽尔产学中枢", "directed", 4),
        ("乌尔努公司", "爱普斯泰恩财团", "hierarchy", "导力技术竞争与标准合作", "bidirectional", 3),
        ("巴泽尔理科大学", "乌尔努公司", "hierarchy", "产学研一体核心学术学府", "directed", 5),
        ("巴泽尔理科大学", "卡尔瓦德共和国", "membership", "工学都市巴泽尔最高理工学府", "directed", 4),
        ("季斯卡尔工房", "乌尔努公司", "hierarchy", "巴泽尔旧市街精密机械合作工房", "directed", 3),
        ("僧兵厅", "七耀教会", "hierarchy", "典礼省直属武装僧兵厅", "directed", 4),
        ("僧兵厅", "星杯骑士团", "hierarchy", "教会两大武装派阀竞合", "bidirectional", 4),
        ("餐酒馆《蒙马特》", "亚克莱德解决事务所", "hierarchy", "一楼餐酒馆与二楼租客事务所", "bidirectional", 4),
        ("蒙马特家族", "餐酒馆《蒙马特》", "hierarchy", "世代经营旧市街餐酒馆《蒙马特》", "directed", 4),
        ("煌都华剧场", "卡尔瓦德共和国", "membership", "煌都兰波特传统剧场", "directed", 3),
        ("雷克塞尔演艺事务所", "维加斯影业", "hierarchy", "导力电影演员经纪合作", "bidirectional", 3),
        ("杂志《扒粪者》", "泰雷尔通讯社", "hierarchy", "共和国新闻出版界同行", "bidirectional", 3),
        ("昆西公司", "卡尔瓦德共和国", "membership", "共和国知名点心食品企业", "directed", 3),
        ("卡尔瓦德前皇室", "卡尔瓦德共和国", "hierarchy", "百年前民主革命前的旧亚尔达里翁王朝", "directed", 4),

        # Arkride Solutions Office Core Party
        ("范恩·亚克莱德", "亚克莱德解决事务所", "membership", "所长 · 《地下万事屋》", "directed", 5),
        ("亚妮艾丝·克劳蒂尔", "亚克莱德解决事务所", "membership", "打工助手 · 八《创世》委托人", "directed", 5),
        ("菲莉·阿尔法德", "亚克莱德解决事务所", "membership", "见习助手（第1章加入）", "directed", 5),
        ("亚伦·魏", "亚克莱德解决事务所", "membership", "事务所成员（第2章加入）", "directed", 5),
        ("莉婕特·唐宁", "亚克莱德解决事务所", "membership", "外派驻所SC专员（第3章起）", "directed", 5),
        ("卡特尔·萨里西翁", "亚克莱德解决事务所", "membership", "技术助手（第4章加入）", "directed", 5),
        ("茱迪丝·兰斯塔", "亚克莱德解决事务所", "membership", "事务所伙伴（间章后正式入队）", "directed", 5),
        ("贝尔加德·哲曼", "亚克莱德解决事务所", "membership", "顾问与武术导师（第5章合流）", "directed", 5),
        ("梅亚", "范恩·亚克莱德", "ally", "赛法空洞核心 · 赋予魔装鬼之力", "bidirectional", 5),
        ("范格兰茨·赛恩", "范恩·亚克莱德", "hostile", "附体（透过魔核相连的漂泊魔王）", "bidirectional", 5),
        ("梅亚", "范格兰茨·赛恩", "hierarchy", "以魔装鬼外壳拘束抑制魔王之力", "directed", 4),

        # D∴G Cult Core Backstory Links
        ("杰拉尔·丹提斯", "D∴G教团", "membership", "原教团干部祭司（吞噬真知魔人化）", "directed", 5),
        ("D∴G教团", "范恩·亚克莱德", "hostile", "幼年掳走并进行残酷魔核实验", "directed", 5),
        ("D∴G教团", "范格兰茨·赛恩", "hostile", "曾自年幼范恩体内强行抽取魔核实验", "directed", 4),
        ("D∴G教团", "卡特尔·萨里西翁", "hostile", "幼年特殊实验受害孤儿", "directed", 4),
        ("贝尔加德·哲曼", "D∴G教团", "hostile", "参与歼灭教团并救出年幼范恩", "directed", 4),

        # Interpersonal Party & Childhood Trio Ties (including Parallel Multi-Edges!)
        ("亚妮艾丝·克劳蒂尔", "范恩·亚克莱德", "romance", "深切信赖与倾慕（率众寻回范恩）", "directed", 5),
        ("范恩·亚克莱德", "艾蕾因·奥克雷尔", "ally", "亚拉密斯青梅竹马 · 并肩搭档", "bidirectional", 4),
        ("艾蕾因·奥克雷尔", "范恩·亚克莱德", "romance", "学生时代前恋人 · 旧情难忘", "bidirectional", 5),
        ("范恩·亚克莱德", "卢尼·金凯德", "ally", "亚拉密斯总角挚友 · 灰色情报互助", "bidirectional", 4),
        ("艾蕾因·奥克雷尔", "卢尼·金凯德", "ally", "亚拉密斯青梅三人组", "bidirectional", 4),
        ("范恩·亚克莱德", "亚拉密斯高等学校", "membership", "曾就读（中途辍学）", "directed", 3),
        ("艾蕾因·奥克雷尔", "亚拉密斯高等学校", "membership", "优秀毕业生（前学生会长）", "directed", 3),
        ("卢尼·金凯德", "亚拉密斯高等学校", "membership", "优秀毕业生（前学生会长）", "directed", 3),
        ("洛伊·格兰哈特", "亚拉密斯高等学校", "membership", "毕业生", "directed", 3),

        # Agnes, Gramhart & Claudel Lineage
        ("亚妮艾丝·克劳蒂尔", "亚拉密斯高等学校", "membership", "一年级学生会干事", "directed", 4),
        ("亚妮艾丝·克劳蒂尔", "克劳蒂尔家系", "family", "爱普斯泰恩博士外曾孙女", "directed", 5),
        ("亚妮艾丝·克劳蒂尔", "克洛德·爱普斯泰恩", "family", "曾孙女（祖母莉莉雅养父 · 继承八创世）", "directed", 5, "亚妮艾丝·克劳蒂尔的祖母莉莉雅是克洛德·爱普斯泰恩的养女，实际上无血缘关系"),
        ("洛伊·格兰哈特", "亚妮艾丝·克劳蒂尔", "family", "父女（隐姓克劳蒂尔就学）", "directed", 5),
        ("洛伊·格兰哈特", "卡尔瓦德政府与总统府", "membership", "第23任共和国总统", "directed", 5),
        ("洛伊·格兰哈特", "卡尔瓦德共和国", "membership", "第23任总统", "directed", 5),
        ("卢尼·金凯德", "洛伊·格兰哈特", "hierarchy", "临时辅佐官与亲信联络人", "directed", 4),
        ("洛伊·格兰哈特", "噬身之蛇", "hierarchy", "秘密签订互不侵犯协定", "bidirectional", 4),
        ("蕾恩·布莱特", "亚拉密斯高等学校", "membership", "交换留学生 · 现任学生会长", "directed", 4),
        ("蕾恩·布莱特", "亚妮艾丝·克劳蒂尔", "ally", "关照有加的学姐（指引4SPG暗号）", "directed", 4),
        ("蕾恩·布莱特", "范恩·亚克莱德", "ally", "幼年受其照顾的旧识挚友", "bidirectional", 4),
        ("亚尔贝尔", "亚拉密斯高等学校", "membership", "学生会会计", "directed", 3),
        ("奥黛特", "亚拉密斯高等学校", "membership", "学生会书记", "directed", 3),
        ("亚尔贝尔", "亚妮艾丝·克劳蒂尔", "romance", "同级好友与暗恋", "directed", 3),
        ("奥黛特", "亚妮艾丝·克劳蒂尔", "ally", "同级闺蜜挚友", "bidirectional", 3),

        # Feri, Kruga, Kasim & Aida
        ("菲莉·阿尔法德", "库鲁格战士团", "membership", "年少猎兵战士", "directed", 4),
        ("卡希姆·阿尔法德", "菲莉·阿尔法德", "family", "严厉而关爱的亲兄妹", "bidirectional", 5),
        ("卡希姆·阿尔法德", "库鲁格战士团", "membership", "原首席战士《灼飙》", "directed", 3),
        ("卡希姆·阿尔法德", "马尔铎克警备公司", "membership", "警备主任（武装测试主管）", "directed", 5),
        ("范恩·亚克莱德", "卡希姆·阿尔法德", "school", "师从（指导击剑与零式劲术）", "directed", 4, "教范恩打击剑和零式劲术"),
        ("哈桑·阿尔法德", "库鲁格战士团", "membership", "副首领", "directed", 4),
        ("哈桑·阿尔法德", "菲莉·阿尔法德", "family", "父亲", "directed", 5),
        ("哈桑·阿尔法德", "卡希姆·阿尔法德", "family", "父亲", "directed", 4),
        ("阿伊妲", "铁盾", "membership", "精锐分队长", "directed", 4),
        ("阿伊妲", "西风旅团", "membership", "前部队长（已退出）", "directed", 3),
        ("阿伊妲", "阿玛塔", "hostile", "被利用（部队尸鬼化牺牲）", "bidirectional", 4),
        ("菲莉·阿尔法德", "阿伊妲", "ally", "敬若亲姐的前辈猎兵", "bidirectional", 4),
        ("杰兰特", "铁盾", "membership", "连队长", "directed", 4),
        ("菲·克劳赛尔", "菲莉·阿尔法德", "ally", "前猎兵前辈的温柔开导", "directed", 4),

        # Aaron, Heiyue, Cao & Rixia
        ("亚伦·魏", "黑月", "hierarchy", "煌都牵制与合作（拒不入伙）", "bidirectional", 4),
        ("亚伦·魏", "叶花·魏", "family", "儿子（深切缅怀亡母）", "directed", 4),
        ("亚伦·魏", "煌都华剧场", "membership", "旦角、非正式成员", "directed", 4),
        ("亚伦·魏", "月华流", "school", "中传", "directed", 4),
        ("亚伦·魏", "拉冈·坎", "hostile", "大君转世宿命与灵魂阴影", "bidirectional", 4),
        ("曹·李", "亚伦·魏", "hierarchy", "试探拉拢与智谋交锋", "bidirectional", 3),
        ("曹·李", "卢家", "family", "养子（17岁李家没落后获收养）", "directed", 4, "曹·李17岁时在李家因陷害没落后被卢家收养"),
        ("曹·李", "雷家", "hostile", "灭门旧恨 · 设局彻底清算雷家叛党", "bidirectional", 4),
        ("亚仙·卢", "卢家", "family", "卢家千金", "directed", 4),
        ("亚仙·卢", "黑月", "membership", "卢家代表", "directed", 3),
        ("亚伦·魏", "亚仙·卢", "ally", "青梅竹马与牵挂", "bidirectional", 4),
        ("亚仙·卢", "曹·李", "romance", "倾慕与爱恋", "directed", 4),
        ("方·卢", "黑月", "membership", "卢家下任长老 · 兰波特支部少当家", "directed", 4, "九龙银行副总裁"),
        ("方·卢", "卢家", "family", "长子（亚仙兄长）", "directed", 4),
        ("方·卢", "亚伦·魏", "ally", "东方人街损友与对手", "bidirectional", 3),
        ("基恩·卢", "黑月", "membership", "笔头长老 · 卢家现任长老", "directed", 5),
        ("基恩·卢", "卢家", "family", "家主长老", "directed", 5),
        ("莉夏·毛", "凶手", "hostile", "传说魔人《银》震慑黑月杀手", "bidirectional", 3),
        ("莉夏·毛", "月华流", "school", "暗杀术与剑舞传承", "directed", 4),
        ("曹·李", "月华流", "school", "武术修习", "directed", 3),
        ("茱迪丝·兰斯塔", "莉夏·毛", "ally", "舞台艺术同行与奥拉希翁劲敌切磋", "bidirectional", 3),

        # Risette & Marduk
        ("莉婕特·唐宁", "马尔铎克警备公司", "membership", "SC服务专员", "directed", 5),
        ("范恩·亚克莱德", "马尔铎克警备公司", "hierarchy", "外部武装测试员契约", "bidirectional", 4),
        ("基利亚姆·森戴克", "马尔铎克警备公司", "membership", "公司总经理(GM)", "directed", 4),
        ("米拉贝尔·亚尔顿", "马尔铎克警备公司", "membership", "SC服务专员", "directed", 3),
        ("米拉贝尔·亚尔顿", "莉婕特·唐宁", "ally", "专员同僚挚友", "bidirectional", 3),

        # Quatre, Basel Academic Rivalry & Verne
        ("卡特尔·萨里西翁", "乌尔努公司", "membership", "巴泽尔理科大学硕士研究员", "directed", 4),
        ("卡特尔·萨里西翁", "巴泽尔理科大学", "membership", "助教、在读硕士生", "directed", 5),
        ("拉托雅·汉弥尔顿", "卡特尔·萨里西翁", "school", "收养监护人与导力工学恩师", "directed", 5),
        ("拉托雅·汉弥尔顿", "乌尔努公司", "membership", "巴泽尔名誉顾问 · 三高徒之一", "directed", 4),
        ("拉托雅·汉弥尔顿", "巴泽尔理科大学", "membership", "前任学长 · 名誉教授", "directed", 5),
        ("拉托雅·汉弥尔顿", "爱普斯泰恩财团", "hierarchy", "爱普斯泰恩博士三大直系高徒之一", "directed", 4),
        ("拉托雅·汉弥尔顿", "克洛德·爱普斯泰恩", "school", "师从（导力工学三高徒之一）", "directed", 5),
        ("拉托雅·汉弥尔顿", "艾丝梅蕾·亚切特", "school", "师徒（巴泽尔三高徒传承）", "directed", 3),
        ("艾丝梅蕾·亚切特", "乌尔努公司", "membership", "生体工学准教授", "directed", 3),
        ("艾丝梅蕾·亚切特", "巴泽尔理科大学", "membership", "生体工学副教授", "directed", 4),
        ("艾丝梅蕾·亚切特", "卡特尔·萨里西翁", "ally", "同门师姐弟", "bidirectional", 3),
        ("杨·库伦凯特", "乌尔努公司", "membership", "天体物理派权威教授", "directed", 3),
        ("杨·库伦凯特", "巴泽尔理科大学", "membership", "天体物理派教授", "directed", 4),
        ("卡特尔·萨里西翁", "杨·库伦凯特", "ally", "师弟与学术协力", "bidirectional", 3),
        ("大卫·凯拉罕", "乌尔努公司", "membership", "前教授（受阿玛塔蛊惑开发反应兵器）", "directed", 3),
        ("大卫·凯拉罕", "巴泽尔理科大学", "membership", "前反应兵器派教授（已故）", "directed", 4),
        ("大卫·凯拉罕", "阿玛塔", "hierarchy", "秘密提供反应兵器", "directed", 4),
        ("大卫·凯拉罕", "杨·库伦凯特", "hostile", "巴泽尔学派主导权宿怨竞争", "bidirectional", 4),
        ("大卫·凯拉罕", "卡特尔·萨里西翁", "hostile", "学术堕落对质与AI死斗", "bidirectional", 4),
        ("季斯卡尔技术长", "乌尔努公司", "membership", "职人派首席技术长", "directed", 3),
        ("季斯卡尔技术长", "季斯卡尔工房", "membership", "代表技术长 · 巴泽尔职人派核心工房", "directed", 4),

        # Judith, Nina, Tharbad Conspiracy & Elsaim
        ("茱迪丝·兰斯塔", "维加斯影业", "hierarchy", "顶级签约导力女优", "directed", 3),
        ("茱迪丝·兰斯塔", "雷克塞尔演艺事务所", "membership", "签约招牌女星艺人", "directed", 4),
        ("多明尼克·兰斯塔", "茱迪丝·兰斯塔", "family", "外婆与孙女 · 初代幻夜之猫传承", "directed", 4),
        ("妮娜·芬里", "维加斯影业", "membership", "新世代人气女演员", "directed", 3),
        ("妮娜·芬里", "雷克塞尔演艺事务所", "membership", "签约人气女演员艺人", "directed", 4),
        ("妮娜·芬里", "茱迪丝·兰斯塔", "ally", "敬仰的前辈与演技劲敌", "bidirectional", 4),
        ("妮娜·芬里", "亚克莱德解决事务所", "hierarchy", "萨尔巴德影展护卫委托人", "directed", 3),
        ("妮娜·芬里", "七耀教会", "membership", "隐秘身份《终结之圣女》", "directed", 4),
        ("阿修拉德", "妮娜·芬里", "hierarchy", "暗中联络守护《终结之圣女》", "directed", 4),
        ("萨尔曼", "艾尔萨姆公国", "membership", "公王", "directed", 5),
        ("萨尔曼", "歇里德·阿斯瓦尔", "family", "父子（公王与公太子）", "directed", 4),
        ("歇里德·阿斯瓦尔", "艾尔萨姆公国", "membership", "王储公太子", "directed", 5),
        ("歇里德·阿斯瓦尔", "亚克莱德解决事务所", "hierarchy", "影展出资人与协力盟友", "bidirectional", 3),
        ("娜洁·贝尔卡", "歇里德·阿斯瓦尔", "hierarchy", "贴身护卫队长", "directed", 4),
        ("萨尔巴托雷·哥奇", "维加斯影业", "membership", "新锐电影导演", "directed", 3),
        ("贾斯柏·迪隆", "维加斯影业", "membership", "董事长", "directed", 3),
        ("贾斯柏·迪隆", "阿玛塔", "hierarchy", "暗中勾结走私违禁水烟遭灭口", "directed", 4),
        ("萨菈", "莎希娜", "family", "亲生姐妹（姐姐）", "directed", 5),
        ("萨菈", "雷克塞尔演艺事务所", "membership", "签约东方舞娘艺人", "directed", 3),
        ("莎希娜", "雷克塞尔演艺事务所", "membership", "签约东方舞娘艺人", "directed", 3),
        ("萨菈", "亚克莱德解决事务所", "ally", "萨尔巴德协力友人", "bidirectional", 3),
        ("莎希娜", "亚克莱德解决事务所", "ally", "萨尔巴德解救与协力友人", "bidirectional", 3),
        ("萨菈", "歇里德·阿斯瓦尔", "ally", "萨尔巴德故交与影展协力", "bidirectional", 3),
        ("莎希娜", "歇里德·阿斯瓦尔", "ally", "萨尔巴德故交与影展协力", "bidirectional", 3),
        ("莎希娜", "阿玛塔", "hostile", "萨尔巴德遭胁迫利用", "bidirectional", 4),

        # Bergard, Church, Papal Guard, Martial Schools & Shizuna
        ("贝尔加德·哲曼", "范恩·亚克莱德", "school", "传授昆仑流武术的恩师", "directed", 5),
        ("贝尔加德·哲曼", "昆仑流", "school", "《吼天狮子》达人", "directed", 5),
        ("范恩·亚克莱德", "昆仑流", "school", "门下弟子（零劲）", "directed", 4),
        ("塞莉丝·奥提希亚", "星杯骑士团", "membership", "第四位守护骑士《绯红》", "directed", 4),
        ("里翁·巴塔札尔", "星杯骑士团", "membership", "第十一位守护骑士《苍冰》", "directed", 4),
        ("贝尔加德·哲曼", "塞莉丝·奥提希亚", "school", "师父与私收门生", "directed", 4),
        ("贝尔加德·哲曼", "里翁·巴塔札尔", "school", "师父与私收门生", "directed", 4),
        ("贝尔加德·哲曼", "阿修拉德", "school", "师父（指导战槌矛）", "directed", 4),
        ("塞莉丝·奥提希亚", "范恩·亚克莱德", "ally", "嘴硬关心的同门师姐弟／协力", "bidirectional", 3),
        ("阿修拉德", "僧兵厅", "membership", "副僧兵长", "directed", 5),
        ("贝尔加德·哲曼", "洛克史密斯", "ally", "多年故交好友", "bidirectional", 3),
        ("洛克史密斯", "卡尔瓦德政府与总统府", "hierarchy", "前任共和国总统", "directed", 4),
        ("洛克史密斯", "卡尔瓦德共和国", "membership", "前任总统（第22任）", "directed", 4),
        ("静名·蕾姆·御折木", "斑鸠", "membership", "副长《白银剑圣》", "directed", 5),
        ("静名·蕾姆·御折木", "黑神一刀流", "school", "白银剑圣达人", "directed", 5),
        ("静名·蕾姆·御折木", "八叶一刀流", "school", "零之型体悟（偷师共鸣）", "directed", 4),
        ("静名·蕾姆·御折木", "范恩·亚克莱德", "ally", "龙来交锋与奥拉希翁雇佣共斗", "bidirectional", 4),
        ("黑铁", "斑鸠", "membership", "覆面副长 · 静名随从", "directed", 4),
        ("黑铁", "胧月流", "school", "东方忍术与暗器流派达人", "directed", 5),
        ("黑铁", "静名·蕾姆·御折木", "hierarchy", "贴身辅佐", "directed", 4),

        # Bracers, Quincy, CID & Police in Calvard
        ("艾蕾因·奥克雷尔", "游击士协会", "membership", "卡尔瓦德最年轻A级游击士", "directed", 5),
        ("艾德蒙·奥克雷尔", "昆西公司", "membership", "董事长", "directed", 5),
        ("艾德蒙·奥克雷尔", "艾蕾因·奥克雷尔", "family", "父女（理念冲突的严父）", "directed", 4),
        ("艾蕾因·奥克雷尔", "昆西公司", "family", "董事长千金（拒承家业投身游击士）", "directed", 3),
        ("艾德蒙·奥克雷尔", "阿玛塔", "hierarchy", "商业贪欲遭胁迫利用", "directed", 3),
        ("阵·瓦赛克", "范恩·亚克莱德", "ally", "关照有加的武门老大哥", "directed", 4),
        ("阵·瓦赛克", "艾蕾因·奥克雷尔", "hierarchy", "协会前辈指导", "directed", 4),
        ("菲·克劳赛尔", "艾蕾因·奥克雷尔", "ally", "游击士同行搭档", "bidirectional", 4),
        ("艾尔维斯", "游击士协会", "membership", "首都支部正游击士", "directed", 3),
        ("卢尼·金凯德", "CID", "membership", "统合分析室辅佐官", "directed", 5),
        ("雾香·楼兰", "卢尼·金凯德", "hierarchy", "直属上司与王牌副手", "directed", 4),
        ("卡艾拉·马克米兰", "CID", "membership", "情报分析少尉", "directed", 3),
        ("卡艾拉·马克米兰", "海克力士", "membership", "特务少尉", "directed", 4),
        ("达斯瓦尼", "首都警察", "membership", "搜查一课警部", "directed", 4),
        ("奈特搜查官", "首都警察", "membership", "搜查官（达斯瓦尼部下）", "directed", 3),
        ("达斯瓦尼", "奈特搜查官", "hierarchy", "上司与部下", "directed", 3),
        ("达斯瓦尼", "范恩·亚克莱德", "hierarchy", "从戒备盯防到认可合作", "bidirectional", 3),

        # Montmart, Maxim, Emilia, Press & Underground Network
        ("波蕾特", "餐酒馆《蒙马特》", "membership", "温柔干练的老板娘", "directed", 4),
        ("波蕾特", "梦", "family", "母女", "directed", 5),
        ("维克托", "波蕾特", "family", "父女", "directed", 4),
        ("维克托", "餐酒馆《蒙马特》", "membership", "主厨兼房东", "directed", 4),
        ("维克托", "蒙马特家族", "family", "家主、父亲", "directed", 4),
        ("波蕾特", "蒙马特家族", "family", "长女", "directed", 4),
        ("梦", "蒙马特家族", "family", "外孙女", "directed", 4),
        ("马克希姆·卢根", "蒙马特家族", "family", "梦的生父（准女婿 · 默默守护）", "directed", 4, "梦的生父，尚未相认"),
        ("范恩·亚克莱德", "维克托", "ally", "房客与关照长辈", "directed", 4),
        ("范恩·亚克莱德", "波蕾特", "ally", "房东母女与贴心租客", "bidirectional", 4),
        ("范恩·亚克莱德", "梦", "ally", "如兄如父般疼爱照顾", "bidirectional", 4),
        ("马克希姆·卢根", "波蕾特", "romance", "往昔恋人（小梦生父）", "bidirectional", 4),
        ("马克希姆·卢根", "梦", "family", "亲生父女（隐瞒身份守护）", "directed", 4),
        ("马克希姆·卢根", "乌尔努公司", "hierarchy", "Z1厂队王牌赛车手", "directed", 4),
        ("马克希姆·卢根", "亚克莱德解决事务所", "hierarchy", "寻找旧恋人母女委托人", "directed", 3),
        ("丁格·布拉德", "杂志《扒粪者》", "membership", "王牌独立调查写手", "directed", 4),
        ("丁格·布拉德", "泰雷尔通讯社", "hierarchy", "特约独立八卦记者", "directed", 4),
        ("玛莉艾儿·埃梅", "泰雷尔通讯社", "membership", "新晋记者", "directed", 3),
        ("玛莉艾儿·埃梅", "丁格·布拉德", "ally", "敬仰的新闻前辈与遗志继承者", "directed", 4),
        ("范恩·亚克莱德", "丁格·布拉德", "ally", "多年情报挚友（托付克雷优最后影像）", "bidirectional", 5),
        ("贝尔默提", "范恩·亚克莱德", "hierarchy", "黑芒街与首都情报交易伙伴", "bidirectional", 3),
        ("杰克·崔佛", "哈璐·科尔曼", "ally", "王牌牌手与情报搭档", "bidirectional", 4),
        ("杰克·崔佛", "范恩·亚克莱德", "ally", "煌都与首都地下协力友人", "bidirectional", 3),
        ("范恩·亚克莱德", "哈璐·科尔曼", "ally", "牌桌与地下情报协力友人", "bidirectional", 3),
        ("艾梅丝/艾米莉亚·哈林格", "范恩·亚克莱德", "ally", "速递情报与导力车同好", "bidirectional", 3),
        ("艾梅丝/艾米莉亚·哈林格", "卡尔瓦德政府与总统府", "hierarchy", "前空军王牌少校《银翼》", "directed", 3),

        # Antagonists: Almata, Garden & Ouroboros
        ("杰拉尔·丹提斯", "阿玛塔", "membership", "绝对首领", "directed", 5),
        ("杰拉尔·丹提斯", "卡尔瓦德前皇室", "family", "旧王储后裔（本名杰拉尔·亚尔达里翁）", "directed", 5, "本名杰拉尔·亚尔达里翁"),
        ("艾林格", "阿玛塔", "membership", "前首领（死亡）", "directed", 4),
        ("杰拉尔·丹提斯", "艾林格", "hostile", "篡位肃清前任首领", "directed", 4),
        ("罗宾·格拉斯戈", "阿玛塔", "membership", "物资调配成员（死亡）", "directed", 3, "负责管理和调配物资"),
        ("罗宾·格拉斯戈", "亚克莱德解决事务所", "hostile", "首都地下物资走私交锋", "bidirectional", 3),
        ("梅鲁奇欧", "阿玛塔", "membership", "三干部之一", "directed", 5),
        ("梅鲁奇欧", "庭园", "membership", "《荆棘庭园》管理人", "directed", 4),
        ("梅鲁奇欧", "杰拉尔·丹提斯", "hierarchy", "狂热崇拜与效忠", "directed", 5),
        ("梅鲁奇欧", "艾尔罗伊·贺伍德", "school", "旧《月光木马团》熏陶后辈", "directed", 3),
        ("薇欧菈", "阿玛塔", "membership", "三干部之一", "directed", 4),
        ("薇欧菈", "杰拉尔·丹提斯", "hierarchy", "狂热崇拜与效忠", "directed", 4),
        ("薇欧菈", "梅鲁奇欧", "hostile", "干部争宠与竞争意识", "bidirectional", 3),
        ("亚历山卓", "阿玛塔", "membership", "三干部之一", "directed", 4),
        ("亚历山卓", "杰拉尔·丹提斯", "hierarchy", "追随赴死的效忠", "directed", 4),
        ("亚历山卓", "亚伦·魏", "hostile", "煌都同伴血仇与奥拉希翁死斗", "bidirectional", 4),
        ("奥林匹亚", "庭园", "membership", "《黄金庭园》管理人", "directed", 4),
        ("奥林匹亚", "阿玛塔", "hierarchy", "契约协力者", "directed", 4),
        ("亚里欧契", "庭园", "membership", "《铁锈庭园》管理人《鏖杀》", "directed", 4),
        ("亚里欧契", "阿玛塔", "hierarchy", "契约协力杀戮者", "directed", 4),
        ("亚里欧契", "静名·蕾姆·御折木", "hostile", "龙来山脉与古战场交锋", "bidirectional", 3),
        ("范恩·亚克莱德", "杰拉尔·丹提斯", "hostile", "宿命死敌（魔核与泛魔化决战）", "bidirectional", 5),
        ("杰拉尔·丹提斯", "丁格·布拉德", "hostile", "克雷优村核爆灭口", "directed", 5),
        ("梅鲁奇欧", "阿伊妲", "hostile", "设局使其部队尸鬼化", "directed", 4),
        ("艾尔罗伊·贺伍德", "噬身之蛇", "membership", "蛇之使徒第四柱《破戒》", "directed", 5),
        ("艾尔罗伊·贺伍德", "庭园", "hierarchy", "整编创立后撒手放任", "directed", 4, "贺伍德将《月光木马团》与《D∴G教团》的残党整编成《庭园》后撒手不管"),
        ("艾尔罗伊·贺伍德", "范恩·亚克莱德", "hierarchy", "奥拉希翁死亡游戏委托与试探", "directed", 4),
        ("露克蕾琪亚·伊斯雷", "噬身之蛇", "membership", "执行者No.III《黄金蝶》", "directed", 4),
        ("露克蕾琪亚·伊斯雷", "艾尔罗伊·贺伍德", "hierarchy", "同行协力（旧月光木马团渊源）", "bidirectional", 4),
        ("瓦尔特·克隆", "范恩·亚克莱德", "hostile", "劲敌交锋（赏识其爱车品味）", "bidirectional", 4),
    ]

    for rel_item in kuro_rels:
        s, t, cat, lb, dirc, w = rel_item[:6]
        rnote = rel_item[6] if len(rel_item) > 6 else ""
        add_rel(s, t, cat, lb, ["kuro"], dirc, w, note=rnote)

    # Helpers to extend continuing relations & link multi-hop supersedesId chains cleanly
    def find_existing_rel(sname: str, tname: str, category: str, label: str):
        sc = CANONICAL_NAME_MAP.get(norm_name(sname), norm_name(sname))
        tc = CANONICAL_NAME_MAP.get(norm_name(tname), norm_name(tname))
        assert sc in entities_by_name and tc in entities_by_name, f"Missing endpoint in lookup: {sc} / {tc}"
        sid, tid = entities_by_name[sc]["id"], entities_by_name[tc]["id"]
        for r in reversed(relations):
            if r["source"] == sid and r["target"] == tid and r["category"] == category and r["label"] == label:
                return r
        pair_set = {sid, tid}
        for r in reversed(relations):
            if {r["source"], r["target"]} == pair_set and r["category"] == category and r["label"] == label:
                return r
        raise AssertionError(f"Prior relation not found: ({sc}, {tc}, {category}, {label})")

    def extend_continuing_rel(sname: str, tname: str, category: str, label: str, arc_id: str):
        r = find_existing_rel(sname, tname, category, label)
        sc = CANONICAL_NAME_MAP.get(norm_name(sname), norm_name(sname))
        tc = CANONICAL_NAME_MAP.get(norm_name(tname), norm_name(tname))
        assert arc_id in entities_by_name[sc]["arcs"], f"Continuing rel endpoint {sc} not active in {arc_id}"
        assert arc_id in entities_by_name[tc]["arcs"], f"Continuing rel endpoint {tc} not active in {arc_id}"
        if arc_id not in r["arcs"]:
            r["arcs"] = sorted(set(r["arcs"]) | {arc_id})
        return r["id"]

    # 10. Kuro no Kiseki II (黎之轨迹II, S.1209 early) Continuing, New & Evolved Relations
    for s, t, cat, lb, _dirc, _w in KURO2_CONTINUING_RELS:
        extend_continuing_rel(s, t, cat, lb, "kuro2")

    for s, t, cat, lb, dirc, w in KURO2_NEW_RELS:
        rid = add_rel(s, t, cat, lb, ["kuro2"], dirc, w)
        assert rid is not None, f"Failed to add KURO2_NEW_REL: {(s, t, cat, lb)}"

    for sup in KURO2_SUPERSEDES:
        prior_rel = find_existing_rel(*sup["supersedes"])
        rid = add_rel(
            sup["source"],
            sup["target"],
            sup["category"],
            sup["label"],
            ["kuro2"],
            direction=sup["direction"],
            weight=sup["weight"],
            supersedes_id=prior_rel["id"],
            note=sup.get("note", ""),
        )
        assert rid is not None, f"Failed to add KURO2_SUPERSEDES: {sup}"

    # 11. Kai no Kiseki (界之轨迹, S.1209 mid) Continuing, New & Evolved Relations
    for s, t, cat, lb, _dirc, _w in KAI_CONTINUING_RELS:
        extend_continuing_rel(s, t, cat, lb, "kai")

    for s, t, cat, lb, dirc, w in KAI_NEW_RELS:
        assert s not in FORBIDDEN_ARTIFACT_NAMES and t not in FORBIDDEN_ARTIFACT_NAMES, (
            f"Forbidden artifact endpoint in KAI_NEW_RELS: {(s, t, cat, lb)}"
        )
        rid = add_rel(s, t, cat, lb, ["kai"], dirc, w)
        assert rid is not None, f"Failed to add KAI_NEW_REL: {(s, t, cat, lb)}"

    for sup in KAI_SUPERSEDES:
        prior_rel = find_existing_rel(*sup["supersedes"])
        rid = add_rel(
            sup["source"],
            sup["target"],
            sup["category"],
            sup["label"],
            ["kai"],
            direction=sup["direction"],
            weight=sup["weight"],
            supersedes_id=prior_rel["id"],
            note=sup.get("note", ""),
        )
        assert rid is not None, f"Failed to add KAI_SUPERSEDES: {sup}"

    # 11B. Cross-Arc Backstory Relations (active in multi-arc & All-Zemuria views without polluting single-arc purity)
    add_rel("赛克托军武", "阿玛塔", "hierarchy", "秘密军火合作与追查遗产", ["kuro", "kuro2"], "bidirectional", 4)
    add_rel("杰拉尔·丹提斯", "伊克斯", "family", "父亲（亚尔达里翁血脉遗孤）", ["kuro", "kuro2", "kai"], "directed", 5)
    add_rel("杰拉尔·丹提斯", "约尔妲", "family", "父亲（亚尔达里翁血脉遗孤）", ["kuro", "kuro2", "kai"], "directed", 5)
    extend_cody_rocksmith = find_existing_rel("柯迪·马克米兰", "洛克史密斯", "hierarchy", "前贴身护卫 · 深敬前总统")
    extend_cody_rocksmith["arcs"] = ["kai", "kuro", "kuro2"]

    # Sort entities cleanly by type then name
    type_order = {"nation": 0, "organization": 1, "family": 2, "school": 3, "character": 4}
    entities_list = sorted(
        entities_by_name.values(),
        key=lambda x: (type_order.get(x["entityType"], 9), x["canonicalName"]),
    )

    # Clean empty optional fields to keep static JSON compact & pristine
    cleaned_entities = []
    for ent in entities_list:
        obj = {
            "id": ent["id"],
            "canonicalName": ent["canonicalName"],
            "entityType": ent["entityType"],
            "importance": ent["importance"],
            "arcs": sorted(set(ent["arcs"])),
            "bio": ent["bio"],
        }
        if ent.get("nameEn"):
            obj["nameEn"] = ent["nameEn"]
        if ent.get("subtype"):
            obj["subtype"] = ent["subtype"]
        if ent.get("nationId"):
            obj["nationId"] = ent["nationId"]
        if ent.get("defaultGroupId"):
            obj["defaultGroupId"] = ent["defaultGroupId"]
        if ent.get("defaultTitle"):
            obj["defaultTitle"] = ent["defaultTitle"]
        if ent.get("wpPostId"):
            obj["wpPostId"] = ent["wpPostId"]
        if ent.get("defaultAvatarUrl"):
            obj["defaultAvatarUrl"] = ent["defaultAvatarUrl"]
        if ent.get("wikiUrl"):
            obj["wikiUrl"] = ent["wikiUrl"]
        if ent.get("aliases"):
            obj["aliases"] = ent["aliases"]
        if ent.get("arcOverrides"):
            obj["arcOverrides"] = ent["arcOverrides"]
        if ent.get("scriptMoments"):
            obj["scriptMoments"] = ent["scriptMoments"]
        cleaned_entities.append(obj)

    arcs_def = [
        {
            "id": "sora",
            "name": "空之轨迹",
            "shortName": "空轨",
            "subtitle": "利贝尔王国篇 · S.1202–1203",
            "order": 10,
            "accent": "#34d399",
        },
        {
            "id": "zero_ao",
            "name": "零/碧之轨迹",
            "shortName": "零碧",
            "subtitle": "克洛斯贝尔自治州篇 · S.1204–1205",
            "order": 20,
            "accent": "#60a5fa",
        },
        {
            "id": "sen",
            "name": "闪/创之轨迹",
            "shortName": "闪轨",
            "subtitle": "埃雷波尼亚帝国篇 · S.1204–1207",
            "order": 30,
            "accent": "#f59e0b",
        },
        {
            "id": "kuro",
            "name": "黎之轨迹",
            "shortName": "黎轨",
            "subtitle": "卡尔瓦德共和国篇 · S.1208",
            "order": 40,
            "accent": "#38bdf8",
        },
        dict(KURO2_ARC_DEF),
        dict(KAI_ARC_DEF),
    ]

    # Strict 6-Arc + All-Zemuria Integrity & Lore Verification Suite
    arc_order_map = {a["id"]: a["order"] for a in arcs_def}
    ent_by_id = {e["id"]: e for e in cleaned_entities}
    assert len(ent_by_id) == len(cleaned_entities), "Duplicate entity IDs!"
    assert not slug_collisions, f"Slug collision (-2/-3) detected: {slug_collisions}"
    wp_seen = {}
    for e in cleaned_entities:
        assert e["entityType"] in VALID_ENTITY_TYPES, f"Invalid entityType {e['entityType']} on {e['canonicalName']}"
        assert e["canonicalName"] not in FORBIDDEN_ARTIFACT_NAMES, f"Forbidden artifact node {e['canonicalName']}"
        assert not re.search(r"-[2-9]$", e["id"]), f"Slug collision suffix (-2/-3) detected on {e['canonicalName']}: {e['id']}"
        if any(a in e["arcs"] for a in ("kuro", "kuro2", "kai")):
            assert not e["id"].startswith(("ent-", "node-")), f"Fallback non-semantic slug on {e['canonicalName']}: {e['id']}"
        if "wpPostId" in e:
            pid = e["wpPostId"]
            assert pid in wp_by_id, f"Dead wpPostId {pid} on {e['canonicalName']}"
            assert pid not in KAI_NORTHERN_WAR_EXCLUSIONS, f"Northern War spin-off post {pid} leaked on {e['canonicalName']}"
            assert pid not in wp_seen, f"Duplicate wpPostId {pid} on {wp_seen[pid]} and {e['canonicalName']}"
            wp_seen[pid] = e["canonicalName"]
        if "nationId" in e:
            assert e["entityType"] != "nation", f"Nation {e['canonicalName']} cannot have nationId!"
            assert e["nationId"] in ent_by_id and ent_by_id[e["nationId"]]["entityType"] == "nation", f"Invalid nationId on {e['canonicalName']}"
        if "defaultGroupId" in e:
            gid = e["defaultGroupId"]
            assert gid in ent_by_id and ent_by_id[gid]["entityType"] in ("organization", "family", "school"), f"Invalid defaultGroupId on {e['canonicalName']}"
        assert "?p=" not in e.get("wikiUrl", ""), f"Unpretty ?p= wikiUrl on {e['canonicalName']}"
        for aid, ov in e.get("arcOverrides", {}).items():
            assert aid in arc_order_map, f"Unknown arc {aid} in arcOverrides on {e['canonicalName']}"
            assert aid in e["arcs"], f"Override arc {aid} not in entity arcs for {e['canonicalName']}"
            pg = ov.get("primaryGroupId")
            if pg:
                assert pg in ent_by_id, f"Missing primaryGroupId {pg} on {e['canonicalName']}"
                assert aid in ent_by_id[pg]["arcs"], f"primaryGroupId {pg} ({ent_by_id[pg]['canonicalName']}) not active in arc {aid} for {e['canonicalName']}"
        for aid in e["arcs"]:
            assert aid in arc_order_map, f"Unknown arc {aid} on {e['canonicalName']}"
            pg = e.get("arcOverrides", {}).get(aid, {}).get("primaryGroupId") or e.get("defaultGroupId")
            if pg:
                assert aid in ent_by_id[pg]["arcs"], f"Resolved group {pg} ({ent_by_id[pg]['canonicalName']}) not active in arc {aid} for {e['canonicalName']}"

    # Verify verbatim Kuro II quotes if docs/kuro2 is available
    if os.path.isdir(KURO2_DOCS_DIR):
        k2_doc_texts = {}
        for md_path in glob.glob(os.path.join(KURO2_DOCS_DIR, "*.md")):
            bn = os.path.splitext(os.path.basename(md_path))[0]
            with open(md_path, "r", encoding="utf-8") as mf:
                k2_doc_texts[bn] = mf.read()
        for cname_q, mlist in KURO2_SCRIPT_MOMENTS.items():
            for m in mlist:
                ch_key = m["chapter"].split("·")[-1].strip()
                assert m["quote"] in k2_doc_texts.get(ch_key, ""), f"Non-verbatim Kuro II quote on {cname_q}: {m}"

    rel_by_id = {r["id"]: r for r in relations}
    assert len(rel_by_id) == len(relations), "Duplicate relation IDs!"
    for r in relations:
        assert r["source"] in ent_by_id, f"Missing source {r['source']}"
        assert r["target"] in ent_by_id, f"Missing target {r['target']}"
        assert r["source"] != r["target"], f"Self loop on {r['source']}"
        assert "?" not in r["label"] and "？" not in r["label"] and "lolicon" not in r["label"].lower(), f"Draft label on {r['id']}: {r['label']}"
        s_ent_arcs = set(ent_by_id[r["source"]]["arcs"])
        t_ent_arcs = set(ent_by_id[r["target"]]["arcs"])
        assert set(r["arcs"]) <= (s_ent_arcs | t_ent_arcs), f"Rel {r['id']} arcs {r['arcs']} outside endpoints!"
        assert set(r["arcs"]) & s_ent_arcs, f"Rel {r['id']} has zero arc overlap with source {r['source']}"
        assert set(r["arcs"]) & t_ent_arcs, f"Rel {r['id']} has zero arc overlap with target {r['target']}"
        if "supersedesId" in r:
            assert r["supersedesId"] in rel_by_id, f"Missing supersedesId {r['supersedesId']}"
            seen_chain = {r["id"]}
            step = r.get("supersedesId")
            while step:
                assert step not in seen_chain, f"Cycle in supersedesId chain starting at {r['id']}"
                seen_chain.add(step)
                step = rel_by_id[step].get("supersedesId")

    tier_rank = {"core": 1, "supporting": 2, "minor": 3}

    def simulate_resolve_graph(selected_arcs: list, max_tier: str):
        active_set = set(selected_arcs)
        ordered_arcs = sorted(selected_arcs, key=lambda a: arc_order_map[a])
        active_ids = set()
        for e in cleaned_entities:
            if not any(a in active_set for a in e["arcs"]):
                continue
            eff_imp = e["importance"]
            if e.get("arcOverrides"):
                for a in ordered_arcs:
                    ov = e["arcOverrides"].get(a)
                    if ov and ov.get("importance"):
                        eff_imp = ov["importance"]
            if tier_rank[eff_imp] <= tier_rank[max_tier]:
                active_ids.add(e["id"])

        cand_rels = [
            r for r in relations
            if r["source"] in active_ids and r["target"] in active_ids and any(a in active_set for a in r["arcs"])
        ]
        cand_map = {r["id"]: r for r in cand_rels}
        superseded_in_view = set()
        for r in cand_rels:
            curr_id = r.get("supersedesId")
            visited = {r["id"]}
            while curr_id and curr_id not in visited:
                visited.add(curr_id)
                if curr_id in cand_map:
                    superseded_in_view.add(curr_id)
                curr_id = rel_by_id[curr_id].get("supersedesId") if curr_id in rel_by_id else None

        kept_rels = [r for r in cand_rels if r["id"] not in superseded_in_view]
        deg = Counter()
        pair_buckets = defaultdict(list)
        for r in kept_rels:
            deg[r["source"]] += 1
            deg[r["target"]] += 1
            pair_buckets[tuple(sorted([r["source"], r["target"]]))].append(r)

        for pair, rlist in pair_buckets.items():
            if len(rlist) > 1:
                cats = [r["category"] for r in rlist]
                assert len(set(cats)) == len(cats), (
                    f"Duplicate same-category parallel edges in arcs={selected_arcs} tier={max_tier} on {pair}: {rlist}"
                )

        orphans = [ent_by_id[nid]["canonicalName"] for nid in active_ids if deg[nid] == 0]
        return len(active_ids), len(kept_rels), orphans

    # Assert 0 orphans & 0 duplicate parallel edges across all 21 subgraphs (6 arcs + ALL × 3 tiers)
    all_arc_ids = [a["id"] for a in arcs_def]
    subgraph_stats = {}
    for label_key, arc_sel in [(a["id"], [a["id"]]) for a in arcs_def] + [("all", all_arc_ids)]:
        subgraph_stats[label_key] = {}
        for max_tier in ["core", "supporting", "minor"]:
            ncnt, lcnt, orphans = simulate_resolve_graph(arc_sel, max_tier)
            assert not orphans, f"Orphan entities in view={label_key} tier={max_tier}: {orphans}"
            subgraph_stats[label_key][max_tier] = (ncnt, lcnt)

    # Exhaustively verify ALL (2^6 - 1) * 3 = 189 non-empty Shift+Click multi-arc subset × tier subgraphs!
    for subset_len in range(2, len(all_arc_ids)):
        for combo in itertools.combinations(all_arc_ids, subset_len):
            for max_tier in ["core", "supporting", "minor"]:
                _nc, _lc, combo_orphans = simulate_resolve_graph(list(combo), max_tier)
                assert not combo_orphans, f"Orphan entities in multi-arc combo={combo} tier={max_tier}: {combo_orphans}"

    dataset = {
        "schemaVersion": 1,
        "version": 1,
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "updatedBy": "seed-builder",
        "arcs": arcs_def,
        "entities": cleaned_entities,
        "relations": relations,
    }

    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(dataset, f, ensure_ascii=False, indent=2)

    size_kb = os.path.getsize(OUT_JSON) / 1024
    print(f"=== Generated {OUT_JSON} ({size_kb:.1f} KB) ===")
    print("Total entities:", len(cleaned_entities), "| Total relations:", len(relations))
    print("By entityType:", Counter(e["entityType"] for e in cleaned_entities))
    print("By importance:", Counter(e["importance"] for e in cleaned_entities))
    print(
        "With defaultGroupId:", sum(1 for e in cleaned_entities if e.get("defaultGroupId")),
        "| With avatar:", sum(1 for e in cleaned_entities if e.get("defaultAvatarUrl")),
        "| With wikiUrl:", sum(1 for e in cleaned_entities if e.get("wikiUrl")),
        "| With scriptMoments:", sum(1 for e in cleaned_entities if e.get("scriptMoments")),
    )
    print("\n=== 21-Subgraph Verification Matrix (0 Orphans, 0 Parallel Collisions) ===")
    for label_key in [a["id"] for a in arcs_def] + ["all"]:
        c_n, c_l = subgraph_stats[label_key]["core"]
        s_n, s_l = subgraph_stats[label_key]["supporting"]
        m_n, m_l = subgraph_stats[label_key]["minor"]
        print(
            f"  [{label_key:7s}] core: {c_n:3d}N/{c_l:4d}E | "
            f"supporting: {s_n:3d}N/{s_l:4d}E | minor: {m_n:3d}N/{m_l:4d}E"
        )


if __name__ == "__main__":
    main()
