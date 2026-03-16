from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Literal, Optional, Dict, Any
import time

app = FastAPI(title="Oracle Sim API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True, "ts": int(time.time())}


# --- Placeholder endpoints (wire to Pyth Hermes + Aave Subgraph next) ---

@app.get("/pyth/prices")
def pyth_prices(assets: str = "ETH,BTC,SOL,USDC,DAI"):
    # TODO: fetch from public Hermes and normalize
    syms = [a.strip().upper() for a in assets.split(",") if a.strip()]
    return {
        "ok": True,
        "ts": int(time.time()),
        "prices": {s: {"price": None, "conf": None, "publishTime": None} for s in syms},
    }


@app.get("/aave/radar")
def aave_radar(threshold: float = 1.15, limit: int = 50):
    # TODO: query Aave V3 Base subgraph
    return {"ok": True, "threshold": threshold, "items": [], "limit": limit, "ts": int(time.time())}


@app.get("/aave/wallet/{address}")
def aave_wallet(address: str):
    # TODO: compute healthFactor, liquidation price, etc.
    return {"ok": True, "address": address, "positions": [], "computed": {}, "ts": int(time.time())}


class MonteCarloRequest(BaseModel):
    asset: Literal["ETH"] = "ETH"
    n: int = 1000
    horizonHours: int = 24
    dtMinutes: int = 5


@app.post("/sim/montecarlo")
def sim_montecarlo(req: MonteCarloRequest):
    # TODO: implement GBM using live volatility from Pyth-derived realized vol
    return {"ok": True, "req": req.model_dump(), "summary": {}, "ts": int(time.time())}
