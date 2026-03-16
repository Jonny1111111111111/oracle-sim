# Oracle Sim — DeFi Liquidation Radar (Pyth)

Tagline: **Know before you get liquidated**

Monorepo:
- `apps/web` — React + Vite (UI ported 1:1 from the provided HTML)
- `apps/api` — FastAPI (stubs; next: wire to Pyth Hermes + Aave V3 Base subgraph)

## Dev

### Web
```bash
cd apps/web
npm install
npm run dev
```

### API
```bash
cd apps/api
python -m venv .venv
.venv\\Scripts\\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```
