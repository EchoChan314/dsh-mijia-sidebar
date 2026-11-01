"""One-shot device state / zh-spec dump for dsh-mijia-sidebar.

Modes (default state):
  list   Dump the device list as JSON (did/name/model/spec_type/online/icon —
         the icon field is passed through; the current cloud payload has none,
         so the panel falls back to built-in category glyphs).
  state  Read EVERY readable property of one device with a single mijia cloud
         call (the CLI `get` only does one property per process). Prints:
           {"did": ..., "name": ..., "model": ..., "states": {prop: value}}
  spec   Fetch one device's spec (cached by mijiaAPI) and translate property
         and enum descriptions to Chinese. Primary source: the official
         miot-spec multiLanguage service
         (https://miot-spec.org/instance/v2/multiLanguage?urn=..., cached
         locally for a week); entries it lacks fall back to a curated map
         (mijiaAPI itself serves English only).
Prints exactly one JSON document on stdout.

Failures print ONE json line on stderr and exit with a code the host half
branches on (3 credentials missing, 4 credentials expired, 5 mijiaAPI not
installed), so a first run produces a guide in the panel instead of a
traceback:  {"code": "auth-missing", "message": ..., "auth_path": ...}
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path

# Distinct exit codes are the coarse signal; the stderr line carries the detail.
EXIT_BY_CODE = {
    "auth-missing": 3,
    "auth-expired": 4,
    "dependency-missing": 5,
    "error": 1,
}


def fail(code, message, **extra):
    """Report a first-run condition as one stderr line and stop.

    stdout stays reserved for the single JSON document, so the host never has
    to guess whether what it read was data or logging.
    """
    payload = {"code": code, "message": message}
    payload.update(extra)
    print(json.dumps(payload, ensure_ascii=False), file=sys.stderr, flush=True)
    sys.exit(EXIT_BY_CODE.get(code, 1))


def default_auth_path():
    return Path.home() / ".config" / "mijia-api" / "auth.json"


def check_auth(auth_path):
    """Preflight: every mode needs the stored credential before anything else."""
    if not Path(auth_path).exists():
        fail(
            "auth-missing",
            "还没有米家登录凭证，请先运行：{0} -m mijiaAPI login，再用米家 APP 扫码".format(
                sys.executable
            ),
            auth_path=str(auth_path),
        )


AUTH_HINTS = ("401", "unauthorized", "access_token", "invalid token", "登录", "not logged in")


def is_auth_expired(error):
    """mijiaAPI reports an expired session as text or as a status on the error."""
    status = getattr(error, "status_code", None) or getattr(error, "code", None)
    text = str(error).lower()
    return status == 401 or any(hint in text for hint in AUTH_HINTS)


# mijiaAPI (and requests) are optional at import time: a missing package is a
# first-run condition — `pip install mijiaAPI` — not a crash, so the import
# sits behind the JSON error contract.
try:
    import requests
    from mijiaAPI import mijiaAPI, mijiaDevice
    from mijiaAPI.devices import DevProp, get_device_info
except ImportError:
    try:  # older package layouts
        import requests
        from mijiaAPI.apis import mijiaAPI
        from mijiaAPI.devices import DevProp, get_device_info, mijiaDevice
    except ImportError as error:
        fail(
            "dependency-missing",
            "当前 Python 缺少 mijiaAPI 依赖，请运行：{0} -m pip install mijiaAPI".format(
                sys.executable
            ),
            detail=str(error),
        )

# Common miot-spec property descriptions, English → Chinese. Keyed by the
# English description mijiaAPI's normalized spec carries (which mirrors the
# standard property urn names). Unlisted entries stay English.
PROP_DESC_ZH = {
    "Switch": "开关",
    "Switch Status": "开关状态",
    "Mode": "模式",
    "Gear Fan Level": "风速档位",
    "Fan Level": "风速档位",
    "Horizontal Swing": "水平摆头",
    "Horizontal Swing Included Angle": "摆头角度",
    "Horizontal Angle": "水平角度",
    "Vertical Swing": "垂直摆头",
    "Physical Control Locked": "童锁",
    "Alarm": "提示音",
    "Alarm Switch": "告警开关",
    "Countdown Time": "倒计时",
    "Off Delay Time": "延时关机时间",
    "Brightness": "亮度",
    "Brightness Absolute": "绝对亮度",
    "Color": "颜色",
    "Color Temperature": "色温",
    "Humidity": "湿度",
    "Relative Humidity": "相对湿度",
    "Temperature": "温度",
    "Target Temperature": "目标温度",
    "Indoor Temperature": "室内温度",
    "Outdoor Temperature": "室外温度",
    "Status": "状态",
    "Fault": "故障",
    "Battery Level": "电量",
    "Charging State": "充电状态",
    "Left Time": "剩余时间",
    "Start Time": "开始时间",
    "End Time": "结束时间",
    "Indicator Light": "指示灯",
    "Name": "名称",
    "On Power": "通电开机",
    "Power": "功率",
    "Electric Power": "电功率",
    "Power Consumption": "耗电量",
    "Voltage": "电压",
    "Current": "电流",
    "Anion": "负离子",
    "Sleep Mode": "睡眠模式",
    "Keep Warm": "保温",
    "Warm": "保温",
    "Cook Mode": "烹饪模式",
    "Cooking Time": "烹饪时长",
    "Start Cook": "开始烹饪",
    "Cancel Cooking": "取消烹饪",
    "Wifi Signal": "Wi-Fi 信号",
    "RSSI": "信号强度",
    "IP Address": "IP 地址",
}

VALUE_DESC_ZH = {
    "Natural Wind": "自然风",
    "Straight Wind": "直风",
    "On": "开",
    "Off": "关",
    "Auto": "自动",
    "Manual": "手动",
    "Idle": "待机",
    "Cooking": "烹饪中",
    "Keep Warm": "保温",
    "Pause": "暂停",
    "Delayed": "预约",
    "Completed": "已完成",
    "Normal": "正常",
    "Sleep": "睡眠",
    "None": "无",
    "Low": "低",
    "Medium": "中",
    "High": "高",
    "Locked": "已锁定",
    "Unlocked": "未锁定",
}


def zh_desc(desc):
    if desc is None:
        return desc
    return PROP_DESC_ZH.get(desc, desc)


def zh_value_desc(desc):
    if desc is None:
        return desc
    match = re.match(r"^Level\s*(\d+)$", str(desc))
    if match:
        return f"{match.group(1)} 档"
    return VALUE_DESC_ZH.get(desc, desc)


def spec_lang_key(siid, piid=None, aiid=None, viid=None):
    """miot-spec multiLanguage key layout (same as hass-xiaomi-miot)."""
    key = f"service:{siid:03}"
    if aiid is not None:
        return f"{key}:action:{aiid:03}"
    if piid is not None:
        key = f"{key}:property:{piid:03}"
    if viid is not None:
        key = f"{key}:valuelist:{viid:03}"
    return key


def fetch_translations(spec_type, cache_dir, ttl_days=7):
    """Official miot-spec translations keyed by spec_lang_key, per language."""
    cache = Path(cache_dir) / (spec_type.replace(":", "_") + ".lang.json")
    now = int(time.time())
    try:
        cached = json.loads(cache.read_text(encoding="utf-8"))
        if now - cached.get("_ts", 0) < ttl_days * 86400 and cached.get("langs"):
            return cached["langs"]
    except (OSError, ValueError):
        pass
    langs = {}
    for host in ("https://miot-spec.org", "https://spec.miot-spec.com"):
        try:
            response = requests.get(
                f"{host}/instance/v2/multiLanguage",
                params={"urn": spec_type},
                timeout=15,
            )
            if response.status_code == 200:
                langs = (response.json() or {}).get("data") or {}
                break
        except requests.RequestException:
            continue
    if langs:
        try:
            cache.write_text(
                json.dumps({"_ts": now, "langs": langs}, ensure_ascii=False),
                encoding="utf-8",
            )
        except OSError:
            pass
    return langs


def apply_translations(info, langs):
    zh = langs.get("zh_cn") or {}
    for prop in info.get("properties", []):
        method = prop.get("method") or {}
        desc = zh.get(spec_lang_key(method.get("siid"), piid=method.get("piid")))
        if desc:
            prop["description"] = desc
        else:
            prop["description"] = zh_desc(prop.get("description"))
        for index, item in enumerate(prop.get("value-list") or []):
            vdesc = zh.get(spec_lang_key(method.get("siid"), piid=method.get("piid"), viid=index))
            if vdesc is not None:
                item["description"] = vdesc
            else:
                item["description"] = zh_value_desc(item.get("description"))
    for action in info.get("actions", []):
        method = action.get("method") or {}
        desc = zh.get(spec_lang_key(method.get("siid"), aiid=method.get("aiid")))
        if desc:
            action["description"] = desc
        else:
            action["description"] = zh_desc(action.get("description"))
    return info


def canonical_props(prop_list):
    """prop_list carries '_' aliases for '-' names; keep canonical entries only."""
    props = {}
    for name, prop in prop_list.items():
        if "_" in name and name.replace("_", "-") in prop_list:
            continue
        props[name] = prop
    return props


def props_from_spec(spec_type, cache_dir):
    """Build the property table straight from the cached spec.

    `mijiaDevice(api, did=...)` fetches the whole device list again just to
    resolve a did we already have — a needless cloud round trip that dominates
    the cost of expanding a device (measured 0.6-2.9s). The spec is already on
    disk from the previous `spec` call, so this path is pure local work.
    """
    info = get_device_info(spec_type, cache_path=str(cache_dir))
    prop_list = {}
    for prop_dict in info.get("properties", []):
        prop = DevProp(prop_dict)
        name = prop_dict["name"]
        prop_list[name] = prop
        if "-" in name:
            prop_list[name.replace("-", "_")] = prop
    return prop_list


def mode_state(auth_path, did, spec_type=None):
    api = mijiaAPI(auth_path)
    if spec_type:
        prop_list = props_from_spec(spec_type, Path(auth_path).parent)
        name, model = None, None
    else:
        # Fallback when the caller has no spec_type to hand: pay for the list.
        device = mijiaDevice(api, did=did)
        prop_list = device.prop_list
        did, name, model = device.did, device.name, device.model

    names, methods = [], []
    for prop_name, prop in canonical_props(prop_list).items():
        if "r" not in prop.rw:
            continue
        method = dict(prop.method)
        method["did"] = did
        names.append(prop_name)
        methods.append(method)

    states = {name_: None for name_ in names}
    if methods:
        result = api.get_devices_prop(methods)
        if isinstance(result, dict):  # single-entry response shape
            result = [result]
        for prop_name, item in zip(names, result):
            if isinstance(item, dict) and item.get("code") == 0 and "value" in item:
                states[prop_name] = item["value"]

    json.dump(
        {"did": did, "name": name, "model": model, "states": states},
        sys.stdout,
        ensure_ascii=False,
    )


def mode_list(auth_path):
    api = mijiaAPI(auth_path)
    devices = []
    for d in api.get_devices_list():
        devices.append(
            {
                "did": str(d.get("did")),
                "name": d.get("name"),
                "model": d.get("model"),
                "spec_type": d.get("spec_type"),
                "online": bool(d.get("isOnline")),
                "icon": d.get("icon"),
            }
        )
    json.dump({"devices": devices}, sys.stdout, ensure_ascii=False)


def mode_spec(auth_path, spec_type):
    info = get_device_info(spec_type, cache_path=str(Path(auth_path).parent))
    langs = fetch_translations(spec_type, Path(auth_path).parent)
    apply_translations(info, langs)
    json.dump(info, sys.stdout, ensure_ascii=False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--auth_path", default=str(default_auth_path()))
    parser.add_argument("--mode", choices=["state", "spec", "list"], default="state")
    parser.add_argument("--did")
    parser.add_argument("--spec_type")
    args = parser.parse_args()

    check_auth(args.auth_path)
    try:
        if args.mode == "spec":
            if not args.spec_type:
                parser.error("spec 模式需要 --spec_type")
            mode_spec(args.auth_path, args.spec_type)
        elif args.mode == "list":
            mode_list(args.auth_path)
        else:
            if not args.did:
                parser.error("state 模式需要 --did")
            mode_state(args.auth_path, args.did, args.spec_type)
    except Exception as error:  # the host needs a code, not a traceback
        if is_auth_expired(error):
            fail(
                "auth-expired",
                "米家登录已过期，请重新运行：{0} -m mijiaAPI login 扫码登录".format(
                    sys.executable
                ),
                auth_path=str(args.auth_path),
            )
        fail("error", "读取米家数据失败：{0}".format(error))


if __name__ == "__main__":
    main()
