#!/usr/bin/env python3
"""生成文言（lzh）词典：以 zh-Hant 为底，按「古化词典」做词级替换 +
高可见键手工雅化。产出 frontend/i18n/lzh.json（与 zh-Hant 键集逐一对应）。

用法：python3 scripts/gen-lzh-locale.py
说明：替换按「长词优先」顺序做子串替换；手工覆盖表（HAND）对高可见面
（导航/按钮/分区标题/弹框标题）成键雅化。浅近文言口径——不求先秦语法，
求「翻上去一眼就是古语」。
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "frontend/i18n/zh-Hant.json"
OUT = ROOT / "frontend/i18n/lzh.json"

# 词级古化词典（长词在前，子串替换）。只收「替换后在任何上下文都成立」的词；
# 语境敏感的走 HAND 手工覆盖。
DICT = [
    ("通知中心", "報館"),
    ("快捷鍵", "捷鍵"),
    ("快捷命令", "捷令"),
    ("重新命名", "易名"),
    ("重命名", "易名"),
    ("立即同步", "即刻同步"),
    ("立即鎖定", "即刻上鎖"),
    ("立即巡檢", "即刻巡閱"),
    ("檢查更新", "察新"),
    ("檢查連接", "察連"),
    ("測試連接", "試連"),
    ("自動檢查", "自察"),
    ("自動", "自"),
    ("更新頻率", "察新之期"),
    ("使用者", "用者"),
    ("用戶端", "客端"),
    ("伺服器", "伺"),
    ("伺服", "伺"),
    ("剪貼簿", "Clipboard"),
    ("應用程式", "应用"),
    ("應用", "施"),
    ("程式", "式"),
    ("資料夾", "檔匭"),
    ("資料", "資"),
    ("檔案", "檔"),
    ("資訊", "訊"),
    ("訊息", "訊"),
    ("偏好設定", "所好"),
    ("偏好", "所好"),
    ("設定", "設"),
    ("設置", "設"),
    ("搜尋", "尋"),
    ("搜尋中", "尋中"),
    ("刪除", "削"),
    ("移除", "去"),
    ("儲存", "藏"),
    ("保存", "藏"),
    ("取消", "罷"),
    ("確認", "諾"),
    ("確定", "諾"),
    ("確認密碼", "覆驗密語"),
    ("關閉", "闔"),
    ("開啟", "啟"),
    ("打開", "啟"),
    ("關於", "自敘"),
    ("複製", "謄"),
    ("貼上", "黏"),
    ("剪下", "削出"),
    ("選取", "擇"),
    ("選擇", "擇"),
    ("全選", "悉擇"),
    ("清除", "滌"),
    ("清空", "滌"),
    ("清空剪貼", "滌Clipboard"),
    ("連接", "連"),
    ("已連接", "既連"),
    ("未連接", "未連"),
    ("連線", "連"),
    ("斷線", "線絕"),
    ("斷開", "絕"),
    ("斷開連接", "絕連"),
    ("重試", "再試"),
    ("重新連接", "再連"),
    ("重新", "再"),
    ("載入中", "取中"),
    ("載入", "取"),
    ("下載", "取"),
    ("上傳", "呈"),
    ("安裝", "安"),
    ("解除安裝", "去安"),
    ("執行", "行"),
    ("運行", "行"),
    ("執行中", "行中"),
    ("停止", "止"),
    ("啟動", "啟"),
    ("啟用", "啟"),
    ("停用", "廢"),
    ("禁用", "禁"),
    ("檢視", "觀"),
    ("查看", "觀"),
    ("預覽", "覽"),
    ("說明", "釋"),
    ("幫助", "佐"),
    ("目錄", "錄"),
    ("路徑", "徑"),
    ("名稱", "名"),
    ("標題", "題"),
    ("內容", "文"),
    ("新增", "增"),
    ("新建", "創"),
    ("建立", "創"),
    ("編輯", "輯"),
    ("目前", "今"),
    ("當前", "今"),
    ("現在", "今"),
    ("此電腦", "本機"),
    ("電腦", "機"),
    ("本機", "本機"),
    ("遠端", "遠"),
    ("遠端主機", "遠機"),
    ("主機", "機"),
    ("全部", "悉"),
    ("所有", "諸"),
    ("請稍候", "請少候"),
    ("稍候", "少候"),
    ("稍後", "少頃"),
    ("正在", "方"),
    ("無法", "未能"),
    ("成功", "成"),
    ("失敗", "敗"),
    ("錯誤", "誤"),
    ("警告", "誡"),
    ("提示", "示"),
    ("注意", "慎"),
    ("必須", "必"),
    ("需要", "須"),
    ("或者", "或"),
    ("如果", "若"),
    ("以及", "及"),
    ("并且", "且"),
    ("並", "且"),
    ("但是", "然"),
    ("因此", "故"),
    ("因為", "因"),
    ("已經", "既"),
    ("將會", "將"),
    ("可以", "可"),
    ("之後", "後"),
    ("之前", "前"),
    ("以上", "上"),
    ("以下", "下"),
    ("你", "汝"),
    ("您", "君"),
    ("我們", "吾儕"),
    ("這裡", "此間"),
    ("這個", "此"),
    ("這些", "此"),
    ("那個", "彼"),
    ("什麼", "何"),
    ("怎麼", "何"),
    ("是否", "是否"),
    ("開始", "始"),
    ("結束", "終"),
    ("完成", "畢"),
    ("等待", "俟"),
    ("逾時", "逾期"),
    ("超時", "逾期"),
    ("密碼", "密語"),
    ("口令", "密語"),
    ("金鑰", "鑰"),
    ("私鑰", "私鑰"),
    ("公鑰", "公鑰"),
    ("指紋", "指紋"),
    ("憑證", "信物"),
    ("憑據", "信物"),
    ("記錄", "籍"),
    ("歷史", "史"),
    ("日誌", "誌"),
    ("錄製", "錄"),
    ("錄製中", "錄中"),
    ("播放", "奏"),
    ("回放", "復奏"),
    ("工作階段", "席"),
    ("會話", "席"),
    ("分屏", "分屏"),
    ("終端", "終端"),
    ("命令", "令"),
    ("腳本", " script "),
]

# 高可见键手工雅化（覆盖词典机械替换；键名 = 扁平 a.b.c）。
HAND = {
    # 通用动词/状态
    "common.ok": "諾",
    "common.cancel": "罷",
    "common.save": "藏",
    "common.delete": "削",
    "common.edit": "輯",
    "common.close": "闔",
    "common.add": "增",
    "common.copy": "謄",
    "common.connect": "連",
    "common.back": "返",
    "common.apply": "施",
    "common.retry": "再試",
    "common.confirm": "諾",
    "common.continue": "續",
    "common.done": "畢",
    "common.none": "無",
    "common.unknown": "未知",
    "common.loading": "取中",
    "common.enable": "啟",
    "common.disable": "廢",
    "common.refresh": "漱",
    "common.open": "啟",
    "common.expand": "展",
    "common.collapse": "斂",
    # 导航
    "nav.overview": "總覽",
    "nav.cron": "漏刻",
    "nav.notifications": "報館",
    "nav.hosts": "諸機",
    "nav.settings": "設",
    "nav.credentials": "信物",
    "nav.mcp": "MCP",
    "nav.history": "史乘",
    "nav.forwards": "隧道",
    "nav.jumpchains": "跳板",
    "nav.local": "本機",
    "nav.themeCycle": "易色",
    "nav.terminal": "終端",
    # 设置分区
    "settings.sectionGeneral": "常規",
    "settings.groupStartup": "啟程",
    "settings.groupStorage": "儲藏",
    "settings.sectionSecurity": "守",
    "settings.sectionSync": "同步",
    "settings.sectionAlerts": "警",
    "settings.sectionMcp": "MCP",
    "settings.sectionAppearance": "容色",
    "settings.sectionShortcuts": "捷鍵",
    "settings.sectionAi": "智",
    "settings.sectionAbout": "自敘",
    "settings.softwareUpdate": "察新",
    "settings.langZh": "簡體中文",
    "settings.langHant": "繁體中文",
    "settings.langEn": "English",
    "settings.langLzh": "文言",
    # 语言自主名称 = 原文惯例（简体「简体中文」不随文言词典转字形）
    "settings.langZh": "简体中文",
    "settings.langHant": "繁體中文",
    "settings.aboutSlogan": "如獺穿行於伺服器之間。",
    "settings.shellIntegration": "Shell 集成注入",
    "settings.recordingSaveDir": "錄檔之所",
    "settings.recordingSaveDirDefault": "預設（下載目錄/Ottr 錄檔）",
    "settings.recordingSaveDirHint": "止錄之際，自將 .cast 檔副本遞入此所；留空則用預設。",
    # 更新
    "update.autoCheck": "自察新",
    "update.autoCheck_off": "不察",
    "update.autoCheck_startup": "啟時一察",
    "update.autoCheck_interval": "每 {{hours}} 時一察",
    "update.check": "察新",
    "update.checking": "察之…",
    "update.uptodate": "已是最新。",
    # 同步
    "sync.now": "即刻同步",
    "sync.dialog.title": "同步",
    "sync.dialog.donePush": "已呈雲端，基線既立。",
    "sync.dialog.donePull": "已自雲端取回。",
    "sync.dialog.rebaseline": "重立基線",
    # MCP
    "mcp.snippetCopy": "謄配置",
    "mcp.snippetCopied": "既謄",
    # AI
    "ai.title": "智",
    "ai.panelDiagnose": "診",
    "ai.panelExplain": "釋",
    "ai.exitCodeBadge": "退出碼 {{code}}",
    "ai.stop": "止",
    "ai.thinking": "思之…",
    "ai.retry": "再試",
    "ai.openSettings": "往設",
    # 终端横幅
    "terminal.reconnectHint": "按回車，或雙擊左側諸機以連",
    "terminal.reconnectExhausted": "再連 {{max}} 次皆敗，已止。按回車，或雙擊左側諸機可再連。",
    "terminal.restoredHint": "既復上回之席（未連）。按回車、雙擊左側諸機，或點「連」以啟。",
    "terminal.notConnected": "未連",
}

PREFIXES = ("",)


def flat(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            out.update(flat(v, key))
        else:
            out[key] = v
    return out


def unflat(d):
    out = {}
    for k, v in d.items():
        parts = k.split(".")
        cur = out
        for p in parts[:-1]:
            cur = cur.setdefault(p, {})
        cur[parts[-1]] = v
    return out


def classicalize(s: str) -> str:
    for old, new in DICT:
        if old in s:
            s = s.replace(old, new)
    # 词典替换可能引入多余空格（script 词条自带的空格装饰）
    s = re.sub(r"\s+", " ", s).replace(" .", ".").strip()
    return s


def main() -> None:
    hant = json.loads(SRC.read_text(encoding="utf-8"))
    flat_hant = flat(hant)
    flat_lzh = {}
    for key, value in flat_hant.items():
        if not isinstance(value, str):
            flat_lzh[key] = value
            continue
        base = classicalize(value)
        flat_lzh[key] = HAND.get(key, base)
    # 手工覆盖也要过一遍词典兜底（HAND 未覆盖的复合句仍沾繁体白话词——可接受，
    # 浅近文言口径）。占位符插值 {{x}} 不受替换影响（词典不含花括号词）。
    OUT.write_text(
        json.dumps(unflat(flat_lzh), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"lzh.json written: {len(flat_lzh)} keys")


if __name__ == "__main__":
    main()
