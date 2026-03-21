# 0xWork → Telegram Monitor (Railway)

Polls the 0xWork API every 5 minutes and sends a Telegram message when new tasks appear.

## Env Vars
- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `TELEGRAM_CHAT_ID` — your chat/user id (or a group id)
- `OXWORK_API_URL` — default `https://api.0xwork.org`
- `CATEGORIES` — comma-separated (default: `Code,Research,Writing,Data,Creative,Social`)
- `MIN_BOUNTY` — optional (number)
- `POLL_SECONDS` — default `300`

## Run locally
```bash
pip install -r requirements.txt
python main.py
```
