from __future__ import annotations

import os
import time
import json
from typing import Literal, Dict, Any, List

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="Oracle Sim API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---- Config ----

PYTH_HERMES_URL = os.getenv("PYTH_HERMES_URL", "https://hermes.pyth.network")

# NOTE: The old hosted-service endpoint (api.thegraph.com/subgraphs/name/...) may be removed.
# Use a Studio/gateway endpoint + API key if required.
AAVE_V3_BASE_SUBGRAPH = os.getenv(
    "AAVE_V3_BASE_SUBGRAPH",
    # Aave V3 Base subgraph (Graph Studio gateway). Confirmed working URL provided by operator.
    "https://gateway.thegraph.com/api/subgraphs/id/GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF",
)
THEGRAPH_API_KEY = os.getenv("THEGRAPH_API_KEY")


@app.get("/")
def root():
    # Railway default healthcheck hits "/".
    return {
        "ok": True,
        "service": "oracle-sim-api",
        "version": app.version,
        "ts": int(time.time()),
    }


@app.get("/health")
def health():
    return {"ok": True, "service": "oracle-sim-api", "version": app.version, "ts": int(time.time())}


# ---- Pyth Hermes ----

# Minimal mapping for MVP. If a symbol is missing, we try to resolve via Hermes price_feeds search.
# These IDs must match Hermes price feed IDs.
PYTH_FEED_IDS: Dict[str, str] = {
    # Crypto
    # NOTE: Hermes returns IDs without the leading "0x" in the parsed response.
    # We normalize IDs to *no* "0x" internally.
    "ETH": "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    "BTC": "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    "SOL": "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
}


async def resolve_pyth_feed_id(symbol: str) -> str | None:
    """Best-effort resolver for a symbol using Hermes /v2/price_feeds?query=...

    We prefer feeds whose attributes include the symbol and end with /USD.
    """
    sym = symbol.upper().strip()
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{PYTH_HERMES_URL}/v2/price_feeds", params={"query": sym})
        if r.status_code != 200:
            return None
        feeds = r.json() or []
        # Each entry is like {id, attributes:{base,quote, ...}} depending on Hermes version.
        # We'll handle both shapes.
        def score(feed: Dict[str, Any]) -> int:
            attrs = feed.get("attributes") or {}
            base = (attrs.get("base") or "").upper()
            quote = (attrs.get("quote") or "").upper()
            # highest preference: exact base match and USD quote
            s = 0
            if base == sym:
                s += 10
            if quote == "USD":
                s += 5
            # fallback: symbol appears in any string
            hay = json.dumps(feed).upper()
            if sym in hay:
                s += 1
            return s

        feeds_sorted = sorted(feeds, key=score, reverse=True)
        if not feeds_sorted:
            return None
        fid = feeds_sorted[0].get("id")
        if isinstance(fid, str) and fid.startswith("0x"):
            fid = fid[2:]
        return fid
    except Exception:
        return None


@app.get("/pyth/prices")
async def pyth_prices(assets: str = "ETH,BTC,SOL,USDC,DAI"):
    syms = [a.strip().upper() for a in assets.split(",") if a.strip()]

    ids: List[str | None] = []
    for s in syms:
        fid = PYTH_FEED_IDS.get(s)
        if not fid:
            fid = await resolve_pyth_feed_id(s)
        ids.append(fid)

    params: List[tuple[str, str]] = [("parsed", "true")]
    for i in ids:
        if not i:
            continue
        fid = i[2:] if i.startswith("0x") else i
        params.append(("ids[]", fid))

    if not any(ids):
        return {"ok": True, "ts": int(time.time()), "prices": {s: None for s in syms}}

    url = f"{PYTH_HERMES_URL}/v2/updates/price/latest"

    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(url, params=params)

    if r.status_code != 200:
        raise HTTPException(status_code=502, detail={"error": "pyth_hermes_error", "status": r.status_code, "body": r.text[:500]})

    data = r.json()
    out: Dict[str, Any] = {}

    # Hermes returns `parsed` items with `id`, `price` object {price, conf, expo, publish_time}
    parsed = data.get("parsed", [])
    def norm_id(x: str | None) -> str | None:
        if not x or not isinstance(x, str):
            return None
        return x[2:] if x.startswith("0x") else x

    by_id = {norm_id(p.get("id")): p for p in parsed}

    for sym, feed_id in zip(syms, ids):
        fid = norm_id(feed_id)
        if not fid or fid not in by_id:
            out[sym] = None
            continue
        p = by_id[fid].get("price", {})
        price_i = p.get("price")
        conf_i = p.get("conf")
        expo = p.get("expo")
        publish_time = p.get("publish_time")
        if price_i is None or expo is None:
            out[sym] = None
            continue

        # Convert to float using expo
        expo_i = int(expo)
        price = float(price_i) * (10 ** expo_i)
        conf = float(conf_i) * (10 ** expo_i) if conf_i is not None else None

        out[sym] = {
            "symbol": sym,
            "feedId": feed_id,
            "price": price,
            "conf": conf,
            "expo": expo,
            "publishTime": publish_time,
        }

    return {"ok": True, "ts": int(time.time()), "prices": out}


# ---- Aave V3 Base Subgraph ----

async def gql(query: str, variables: Dict[str, Any] | None = None) -> Dict[str, Any]:
    headers = {"content-type": "application/json"}

    # TheGraph Gateway auth:
    # In practice, gateway endpoints often require the API key in the URL path:
    #   https://gateway.thegraph.com/api/<API_KEY>/subgraphs/id/<SUBGRAPH_ID>
    # Some setups also accept an Authorization header, but we default to the path form.
    url = AAVE_V3_BASE_SUBGRAPH
    if THEGRAPH_API_KEY and "gateway.thegraph.com/api/subgraphs/id/" in url:
        url = url.replace("gateway.thegraph.com/api/subgraphs/id/", f"gateway.thegraph.com/api/{THEGRAPH_API_KEY}/subgraphs/id/")

    async with httpx.AsyncClient(timeout=25) as client:
        r = await client.post(url, json={"query": query, "variables": variables or {}}, headers=headers)

    if r.status_code != 200:
        raise HTTPException(status_code=502, detail={"error": "subgraph_http_error", "status": r.status_code, "body": r.text[:800]})

    j = r.json()
    if "errors" in j:
        raise HTTPException(status_code=502, detail={"error": "subgraph_gql_error", "errors": j["errors"]})

    return j["data"]


@app.get("/aave/radar")
async def aave_radar(threshold: float = 1.15, limit: int = 50):
    # NOTE: Aave subgraph schemas vary by version/provider.
    # We implement a safe, schema-light query for users + their healthFactor if present.
    # If the endpoint is removed (hosted service sunset), you must set AAVE_V3_BASE_SUBGRAPH to a working gateway URL.

    q = """
    query Radar($first:Int!) {
      users(first:$first, orderBy: borrowedReservesCount, orderDirection: desc) {
        id
        borrowedReservesCount
        collateralBalanceUSD
        borrowedBalanceUSD
        healthFactor
      }
    }
    """

    data = await gql(q, {"first": 500})
    users = data.get("users") or []

    items = []
    for u in users:
        hf = u.get("healthFactor")
        if hf is None:
            continue
        try:
            hf_f = float(hf)
        except Exception:
            continue
        if hf_f >= threshold:
            continue
        items.append({
            "wallet": u.get("id"),
            "healthFactor": hf_f,
            "collateralUsd": float(u.get("collateralBalanceUSD") or 0),
            "debtUsd": float(u.get("borrowedBalanceUSD") or 0),
        })

    items.sort(key=lambda x: x["healthFactor"])
    return {"ok": True, "threshold": threshold, "items": items[:limit], "ts": int(time.time())}


@app.get("/aave/wallet/{address}")
async def aave_wallet(address: str):
    addr = address.lower()

    q = """
    query Wallet($id: ID!) {
      user(id: $id) {
        id
        collateralBalanceUSD
        borrowedBalanceUSD
        healthFactor
        borrowedReservesCount
        suppliedReservesCount
      }
    }
    """

    data = await gql(q, {"id": addr})
    user = data.get("user")
    if not user:
        return {"ok": True, "address": addr, "found": False, "positions": [], "computed": {}, "ts": int(time.time())}

    hf = float(user.get("healthFactor") or 0)
    collateral = float(user.get("collateralBalanceUSD") or 0)
    debt = float(user.get("borrowedBalanceUSD") or 0)

    # Risk score per your formula: (hf - 1)/0.5 * 100 capped at 100, floor at 0
    score = max(0.0, min(100.0, ((hf - 1.0) / 0.5) * 100.0))

    # Labels first (MVP)
    if hf < 1.05:
        ttl = "< 2 HRS"
    elif hf < 1.15:
        ttl = "2–8 HRS"
    elif hf < 1.3:
        ttl = "1–3 DAYS"
    else:
        ttl = "> 7 DAYS"

    return {
        "ok": True,
        "address": addr,
        "found": True,
        "positions": [],
        "computed": {
            "healthFactor": hf,
            "riskScore": score,
            "collateralUsd": collateral,
            "debtUsd": debt,
            "timeToLiqLabel": ttl,
        },
        "ts": int(time.time()),
    }


# ---- Monte Carlo (placeholder) ----

class MonteCarloRequest(BaseModel):
    asset: Literal["ETH"] = "ETH"
    n: int = 1000
    horizonHours: int = 24
    dtMinutes: int = 5


@app.post("/sim/montecarlo")
def sim_montecarlo(req: MonteCarloRequest):
    # TODO: implement GBM using realized volatility derived from Hermes history.
    return {"ok": True, "req": req.model_dump(), "summary": {}, "ts": int(time.time())}
