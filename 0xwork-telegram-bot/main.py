import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import requests

API_URL = os.getenv("OXWORK_API_URL", "https://api.0xwork.org").rstrip("/")
BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")

# Back-compat: if TELEGRAM_CHAT_ID is provided, we auto-subscribe it on boot.
LEGACY_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

CATEGORIES = [c.strip() for c in os.getenv("CATEGORIES", "Code,Research,Writing,Data,Creative,Social").split(",") if c.strip()]
MIN_BOUNTY = os.getenv("MIN_BOUNTY")
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "300"))
TG_POLL_SECONDS = int(os.getenv("TG_POLL_SECONDS", "2"))

STATE_PATH = Path(os.getenv("STATE_PATH", "./state.json"))
SUBSCRIBERS_PATH = Path(os.getenv("SUBSCRIBERS_PATH", "./subscribers.json"))


def _load_json(path: Path, default: Any) -> Any:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return default
    return default


def _save_json(path: Path, obj: Any) -> None:
    path.write_text(json.dumps(obj, indent=2, sort_keys=True), encoding="utf-8")


def _load_state() -> Dict[str, Any]:
    st = _load_json(STATE_PATH, {})
    return st if isinstance(st, dict) else {}


def _save_state(st: Dict[str, Any]) -> None:
    _save_json(STATE_PATH, st)


def _load_subscribers() -> Set[str]:
    data = _load_json(SUBSCRIBERS_PATH, [])
    if isinstance(data, list):
        return set(str(x) for x in data if str(x).strip())
    if isinstance(data, dict) and isinstance(data.get("subscribers"), list):
        return set(str(x) for x in data["subscribers"] if str(x).strip())
    return set()


def _save_subscribers(subs: Set[str]) -> None:
    # store as a simple list for easy manual edits
    _save_json(SUBSCRIBERS_PATH, sorted(subs))


def fetch_open_tasks(category: str, limit: int = 50) -> List[Dict[str, Any]]:
    params = {
        "status": "Open",
        "category": category,
        "limit": str(limit),
    }
    if MIN_BOUNTY:
        params["min_bounty"] = str(MIN_BOUNTY)

    r = requests.get(f"{API_URL}/tasks", params=params, timeout=20)
    r.raise_for_status()
    data = r.json()

    # API may return {tasks:[...]}
    if isinstance(data, dict) and isinstance(data.get("tasks"), list):
        return data["tasks"]
    if isinstance(data, list):
        return data
    return []


def tg_send(chat_id: str, text: str) -> None:
    if not BOT_TOKEN:
        # allow running without telegram for testing
        print(f"[tg disabled] -> {chat_id}: {text}")
        return

    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": True,
    }
    r = requests.post(url, json=payload, timeout=20)
    r.raise_for_status()


def tg_broadcast(chat_ids: Set[str], text: str) -> None:
    for cid in sorted(chat_ids):
        try:
            tg_send(cid, text)
        except Exception as e:
            # don't crash the whole bot because one chat is invalid
            print(f"tg_send failed for {cid}: {type(e).__name__}: {e}")


def tg_get_updates(offset: Optional[int], timeout_s: int = 20) -> List[Dict[str, Any]]:
    if not BOT_TOKEN:
        return []

    url = f"https://api.telegram.org/bot{BOT_TOKEN}/getUpdates"
    params: Dict[str, Any] = {
        "timeout": timeout_s,
        "allowed_updates": json.dumps(["message"]),
    }
    if offset is not None:
        params["offset"] = str(offset)

    r = requests.get(url, params=params, timeout=timeout_s + 5)
    r.raise_for_status()
    data = r.json()
    if not isinstance(data, dict) or not data.get("ok"):
        return []
    res = data.get("result")
    return res if isinstance(res, list) else []


def format_task(t: Dict[str, Any]) -> str:
    tid = t.get("chain_task_id") or t.get("id")
    bounty = t.get("bounty_amount") or t.get("bounty")
    cat = t.get("category") or "—"
    desc = (t.get("description") or "").strip()
    desc = desc if len(desc) <= 600 else desc[:600] + "…"

    return (
        f"New 0xWork task #{tid}\n"
        f"Category: {cat}\n"
        f"Bounty: ${bounty}\n\n"
        f"{desc}\n\n"
        f"CLI: 0xwork.cmd task {tid}"
    )


def _summarize_open_tasks(limit: int = 10) -> Tuple[str, List[Dict[str, Any]]]:
    merged: Dict[str, Dict[str, Any]] = {}
    for cat in CATEGORIES:
        for t in fetch_open_tasks(cat, limit=50):
            tid = t.get("chain_task_id") or t.get("id")
            if tid is None:
                continue
            merged[str(tid)] = t

    tasks = list(merged.values())

    def _bounty(x: Dict[str, Any]) -> float:
        b = x.get("bounty_amount") or x.get("bounty") or 0
        try:
            return float(b)
        except Exception:
            return 0.0

    tasks.sort(key=_bounty, reverse=True)
    tasks = tasks[: max(0, int(limit))]

    if not tasks:
        return "No open tasks found.", []

    lines: List[str] = [f"Open tasks (top {len(tasks)} by bounty):"]
    for t in tasks:
        tid = t.get("chain_task_id") or t.get("id")
        cat = t.get("category") or "—"
        bounty = t.get("bounty_amount") or t.get("bounty") or "?"
        desc = (t.get("description") or "").strip().replace("\n", " ")
        desc = desc if len(desc) <= 120 else desc[:120] + "…"
        lines.append(f"• #{tid}  ${bounty}  [{cat}]  {desc}")

    lines.append("\nUse: 0xwork.cmd task <id>")
    return "\n".join(lines), tasks


def _handle_command(chat_id: str, text: str, subs: Set[str]) -> Optional[str]:
    cmd = (text or "").strip().split()[0].lower()

    if cmd == "/start":
        if chat_id not in subs:
            subs.add(chat_id)
            _save_subscribers(subs)
        return "Subscribed. You'll receive new 0xWork task alerts here.\n\nCommands: /tasks, /stop"

    if cmd == "/stop":
        if chat_id in subs:
            subs.remove(chat_id)
            _save_subscribers(subs)
        return "Unsubscribed. Send /start to subscribe again."

    if cmd == "/tasks":
        msg, _ = _summarize_open_tasks(limit=10)
        return msg

    return None


def main() -> None:
    st = _load_state()
    seen = set(map(str, st.get("seen", [])))

    subs = _load_subscribers()
    if LEGACY_CHAT_ID:
        subs.add(str(LEGACY_CHAT_ID))
        _save_subscribers(subs)

    # Telegram update offset so we don't re-process old messages
    tg_offset = st.get("tg_offset")
    tg_offset = int(tg_offset) if isinstance(tg_offset, int) or (isinstance(tg_offset, str) and str(tg_offset).isdigit()) else None

    # announce boot to subscribers
    tg_broadcast(subs, f"0xWork monitor started. Categories={', '.join(CATEGORIES)}. Poll={POLL_SECONDS}s")

    next_task_check = 0.0

    while True:
        now = time.time()

        # 1) Handle Telegram commands
        try:
            updates = tg_get_updates(offset=tg_offset, timeout_s=20)
            for u in updates:
                try:
                    upd_id = u.get("update_id")
                    if isinstance(upd_id, int):
                        tg_offset = upd_id + 1

                    msg = u.get("message") or {}
                    chat = msg.get("chat") or {}
                    chat_id = str(chat.get("id") or "").strip()
                    text = msg.get("text") or ""
                    if not chat_id or not text.startswith("/"):
                        continue

                    resp = _handle_command(chat_id, text, subs)
                    if resp:
                        tg_send(chat_id, resp)
                except Exception as e:
                    print(f"tg update handling error: {type(e).__name__}: {e}")

            if tg_offset is not None:
                st["tg_offset"] = tg_offset
                _save_state(st)

        except Exception as e:
            print(f"tg_get_updates error: {type(e).__name__}: {e}")

        # 2) Poll 0xWork tasks on schedule
        if now >= next_task_check:
            next_task_check = now + POLL_SECONDS
            try:
                new_tasks: List[Dict[str, Any]] = []

                for cat in CATEGORIES:
                    tasks = fetch_open_tasks(cat, limit=50)
                    for t in tasks:
                        tid = t.get("chain_task_id") or t.get("id")
                        if tid is None:
                            continue
                        tid_s = str(tid)
                        if tid_s not in seen:
                            seen.add(tid_s)
                            new_tasks.append(t)

                def _k(x: Dict[str, Any]) -> int:
                    try:
                        return int(x.get("chain_task_id") or x.get("id") or 0)
                    except Exception:
                        return 0

                new_tasks.sort(key=_k)

                if new_tasks:
                    for t in new_tasks:
                        tg_broadcast(subs, format_task(t))

                    st["seen"] = list(seen)[-5000:]
                    st["last_alert_ts"] = int(time.time())
                    _save_state(st)

            except Exception as e:
                tg_broadcast(subs, f"0xWork monitor error: {type(e).__name__}: {e}")

        time.sleep(TG_POLL_SECONDS)


if __name__ == "__main__":
    main()
