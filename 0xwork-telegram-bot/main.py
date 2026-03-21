import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

API_URL = os.getenv("OXWORK_API_URL", "https://api.0xwork.org").rstrip("/")
BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

CATEGORIES = [c.strip() for c in os.getenv("CATEGORIES", "Code,Research,Writing,Data,Creative,Social").split(",") if c.strip()]
MIN_BOUNTY = os.getenv("MIN_BOUNTY")
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "300"))

STATE_PATH = Path(os.getenv("STATE_PATH", "./state.json"))


def _load_state() -> Dict[str, Any]:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _save_state(st: Dict[str, Any]) -> None:
    STATE_PATH.write_text(json.dumps(st, indent=2, sort_keys=True), encoding="utf-8")


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


def tg_send(text: str) -> None:
    if not BOT_TOKEN or not CHAT_ID:
        # allow running without telegram for testing
        print(text)
        return

    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": CHAT_ID,
        "text": text,
        "disable_web_page_preview": True,
    }
    r = requests.post(url, json=payload, timeout=20)
    r.raise_for_status()


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


def main() -> None:
    st = _load_state()
    seen = set(map(str, st.get("seen", [])))

    tg_send(f"0xWork monitor started. Categories={', '.join(CATEGORIES)}. Poll={POLL_SECONDS}s")

    while True:
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

            # sort by id asc when possible
            def _k(x: Dict[str, Any]) -> int:
                try:
                    return int(x.get("chain_task_id") or x.get("id") or 0)
                except Exception:
                    return 0

            new_tasks.sort(key=_k)

            if new_tasks:
                for t in new_tasks:
                    tg_send(format_task(t))

                st["seen"] = list(seen)[-5000:]  # cap state
                st["last_alert_ts"] = int(time.time())
                _save_state(st)

        except Exception as e:
            # keep going; alert once per loop
            tg_send(f"0xWork monitor error: {type(e).__name__}: {e}")

        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
