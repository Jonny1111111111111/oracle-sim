import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './oracle-sim.css'

type PriceSym = 'BTC' | 'ETH' | 'SOL'

type WalletRow = {
  addr: string
  proto: 'Aave V3' | 'Compound' | 'Morpho'
  h: number
  col: number
  liq: number
}

type RiskBand = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'SAFE'

function fmtUsd(n: number, maxFrac = 0) {
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: maxFrac })
}

function shortAddr(addr: string) {
  if (addr.length < 10) return addr
  return addr.slice(0, 6) + '...' + addr.slice(-4)
}

function riskFromHF(hf: number): { band: RiskBand; colorVar: string; badgeClass: string } {
  if (hf < 1.05) return { band: 'CRITICAL', colorVar: 'var(--red)', badgeClass: 'b-crit' }
  if (hf < 1.15) return { band: 'HIGH', colorVar: 'var(--orange)', badgeClass: 'b-high' }
  if (hf < 1.3) return { band: 'MEDIUM', colorVar: 'var(--yellow)', badgeClass: 'b-med' }
  return { band: 'SAFE', colorVar: 'var(--green)', badgeClass: 'b-safe' }
}

// --- Background: Dropping lines canvas (ported 1:1) ---
function DroppingLines() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const lcEl = canvasRef.current
    if (!lcEl) return
    const lc = lcEl
    const lx = lc.getContext('2d')!

    function rsz() {
      lc.width = window.innerWidth
      lc.height = window.innerHeight
    }
    rsz()
    window.addEventListener('resize', rsz)

    const LC = [
      'rgba(41,121,255,',
      'rgba(0,229,255,',
      'rgba(29,233,182,',
      'rgba(213,0,249,',
      'rgba(255,109,0,',
    ]

    function mkL(n: number) {
      return Array.from({ length: n }, () => ({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight - window.innerHeight,
        spd: Math.random() * 2.5 + 0.8,
        len: Math.random() * 90 + 30,
        op: Math.random() * 0.3 + 0.08,
        col: LC[Math.floor(Math.random() * LC.length)],
        w: Math.random() * 1.5 + 0.4,
      }))
    }

    let LS = mkL(130)
    let raf = 0

    function drawL() {
      lx.clearRect(0, 0, lc.width, lc.height)
      LS.forEach((l) => {
        l.y += l.spd
        if (l.y > lc.height + l.len) {
          l.y = -l.len
          l.x = Math.random() * lc.width
          l.spd = Math.random() * 2.5 + 0.8
        }
        const g = lx.createLinearGradient(l.x, l.y - l.len, l.x, l.y)
        g.addColorStop(0, l.col + '0)')
        g.addColorStop(0.4, l.col + l.op + ')')
        g.addColorStop(1, l.col + '0)')

        lx.beginPath()
        lx.moveTo(l.x, l.y - l.len)
        lx.lineTo(l.x, l.y)
        lx.strokeStyle = g
        lx.lineWidth = l.w
        lx.stroke()

        lx.beginPath()
        lx.arc(l.x, l.y, l.w * 1.5, 0, Math.PI * 2)
        lx.fillStyle = l.col + l.op * 1.5 + ')'
        lx.fill()
      })
      raf = requestAnimationFrame(drawL)
    }

    drawL()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', rsz)
    }
  }, [])

  return <canvas id="lines-canvas" ref={canvasRef} />
}

// --- Section 3: mini Monte Carlo canvas (ported 1:1) ---
function MiniMonteCarlo({ ethPrice }: { ethPrice: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [riskText, setRiskText] = useState<string>('— CASCADE RISK')

  const draw = useCallback(() => {
    const mmc = canvasRef.current
    if (!mmc) return
    const mmx = mmc.getContext('2d')!

    const rect = mmc.parentElement?.getBoundingClientRect()
    if (!rect) return

    mmc.width = rect.width - 44
    mmc.height = 120

    const W = mmc.width
    const H = mmc.height

    mmx.clearRect(0, 0, W, H)
    mmx.fillStyle = 'rgba(0,0,0,0.25)'
    mmx.fillRect(0, 0, W, H)

    const p0 = ethPrice || 3200

    const paths = Array.from({ length: 80 }, () => {
      let p = p0
      const path = [p]
      const at = Math.floor(Math.random() * 10)
      for (let t = 1; t <= 40; t++) {
        const r = (Math.random() + Math.random() + Math.random() - 1.5) * Math.sqrt(1 / 3)
        let ret = -0.0001 + 0.022 * r
        if (t === at) ret += -0.1 * (0.4 + Math.random() * 0.8)
        p = p * Math.exp(ret)
        path.push(p)
      }
      return path
    })

    const all = paths.flat()
    const mn = Math.min(...all) * 0.98
    const mx2 = Math.max(...all) * 1.02

    const steps = paths[0].length

    const tx = (i: number) => (i / (steps - 1)) * (W - 10) + 5
    const ty = (v: number) => H - ((v - mn) / (mx2 - mn)) * (H - 10) - 5

    paths.forEach((path) => {
      const fin = path[path.length - 1]
      mmx.beginPath()
      path.forEach((v, i) => {
        const x = tx(i)
        const y = ty(v)
        if (i === 0) mmx.moveTo(x, y)
        else mmx.lineTo(x, y)
      })
      mmx.strokeStyle = fin < p0 * 0.9 ? 'rgba(255,23,68,0.1)' : 'rgba(0,230,118,0.07)'
      mmx.lineWidth = 0.9
      mmx.stroke()
    })

    const lY = ty(p0 * 0.825)
    mmx.beginPath()
    mmx.moveTo(5, lY)
    mmx.lineTo(W - 5, lY)
    mmx.strokeStyle = 'rgba(255,23,68,0.55)'
    mmx.lineWidth = 1
    mmx.setLineDash([2, 3])
    mmx.stroke()
    mmx.setLineDash([])

    const casc = ((paths.filter((p) => p[p.length - 1] < p0 * 0.825).length / paths.length) * 100).toFixed(1)
    setRiskText(`${casc}% CASCADE RISK`)
  }, [ethPrice])

  useEffect(() => {
    draw()
    const t = setInterval(draw, 10000)
    return () => clearInterval(t)
  }, [draw])

  return (
    <>
      <canvas id="mini-mc" ref={canvasRef} />
      <div className="mc-foot">
        <span>PYTH NETWORK LIVE FEEDS</span>
        <span style={{ color: 'var(--red)' }} id="mc-risk">
          {riskText}
        </span>
      </div>
    </>
  )
}

export default function App() {
  // Scroll + dots
  const scrollWrapRef = useRef<HTMLDivElement | null>(null)
  const [activeSection, setActiveSection] = useState(0)

  // Prices (topbar)
  const [PX, setPX] = useState<Record<PriceSym, number>>({ BTC: 85000, ETH: 3200, SOL: 150 })
  const [PP, setPP] = useState<Record<PriceSym, number>>({ BTC: 85000, ETH: 3200, SOL: 150 })

  // Wallets and pagination (radar)
  const [allWallets, setAllWallets] = useState<WalletRow[]>([])
  const [page, setPage] = useState(1)
  const PER_PAGE = 10

  // Full checker
  const [checkAddr, setCheckAddr] = useState('')
  const [result, setResult] = useState<null | {
    short: string
    ts: string
    score: number
    colorVar: string
    status: string
    gauge: { widthPct: number; background: string }
    collateral: string
    debt: string
    liq: string
    time: string
    alertClass: string
    alertText: string
  }>(null)

  const sectionsCount = 3

  const slice = useMemo(() => {
    const start = (page - 1) * PER_PAGE
    return allWallets.slice(start, start + PER_PAGE)
  }, [allWallets, page])

  const critCount = useMemo(() => allWallets.filter((w) => w.h < 1.05).length, [allWallets])

  const atRiskUsd = useMemo(() => {
    return allWallets.filter((w) => w.h < 1.3).reduce((s, w) => s + w.col, 0)
  }, [allWallets])

  const pctBands = useMemo(() => {
    const n = Math.max(1, allWallets.length)
    const c = (allWallets.filter((w) => w.h < 1.05).length / n) * 100
    const hi = (allWallets.filter((w) => w.h >= 1.05 && w.h < 1.15).length / n) * 100
    const md = (allWallets.filter((w) => w.h >= 1.15 && w.h < 1.3).length / n) * 100
    return { c, hi, md }
  }, [allWallets])

  const atRiskStr = useMemo(() => '$' + Math.round((atRiskUsd / 1e6) * 10) / 10 + 'M', [atRiskUsd])

  const pageInfoText = useMemo(() => {
    const start = (page - 1) * PER_PAGE
    const total = allWallets.length
    return `Showing ${start + 1}–${Math.min(start + PER_PAGE, total)} of ${total}`
  }, [allWallets.length, page])

  const sidebarTime = useMemo(() => {
    const d = new Date()
    return d.toLocaleTimeString('en-US', { hour12: false })
  }, [allWallets])

  const scrollToIndex = useCallback((i: number) => {
    const sw = scrollWrapRef.current
    if (!sw) return
    sw.scrollTo({ top: i * (window.innerHeight - 60), behavior: 'smooth' })
  }, [])

  useEffect(() => {
    const sw = scrollWrapRef.current
    if (!sw) return

    const onScroll = () => {
      const idx = Math.round(sw.scrollTop / (window.innerHeight - 60))
      setActiveSection(Math.max(0, Math.min(sectionsCount - 1, idx)))
    }

    sw.addEventListener('scroll', onScroll)
    return () => sw.removeEventListener('scroll', onScroll)
  }, [])

  const API = (import.meta as any).env?.VITE_API_URL || 'https://considerate-success-production-8c54.up.railway.app'

  // Prices fetch (from our API -> Pyth Hermes)
  const fetchPrices = useCallback(async () => {
    try {
      const r = await fetch(`${API}/pyth/prices?assets=BTC,ETH,SOL`)
      const d = await r.json()
      const p = d.prices || {}

      setPP((prev) => ({ ...prev, ...PX }))
      setPX((prev) => {
        const next = { ...prev }
        ;(['BTC', 'ETH', 'SOL'] as PriceSym[]).forEach((s) => {
          const row = p[s]
          if (row?.price != null) next[s] = Number(row.price)
        })
        return next
      })
    } catch {
      // fallback: tiny random walk
      setPP((prev) => ({ ...prev, ...PX }))
      setPX((prev) => {
        const next = { ...prev }
        ;(['BTC', 'ETH', 'SOL'] as PriceSym[]).forEach((s) => {
          next[s] = next[s] * (1 + (Math.random() - 0.5) * 0.001)
        })
        return next
      })
    }
  }, [PX])

  useEffect(() => {
    fetchPrices()
    const t = setInterval(fetchPrices, 5000)
    return () => clearInterval(t)
  }, [fetchPrices])

  // Wallets (real Aave V3 Base data via our API)
  const rebuildWallets = useCallback(async () => {
    try {
      const r = await fetch(`${API}/aave/radar?threshold=1.15&limit=50`)
      const d = await r.json()
      const items = (d.items || []) as Array<{ wallet: string; healthFactor: number; collateralUsd: number; debtUsd: number }>

      const wallets: WalletRow[] = items
        .map((it) => {
          const hf = Number(it.healthFactor)
          const eth = Number(PX.ETH || 3200)
          // Heuristic: for HF=1, liq ~ current; higher HF => liq further below current.
          const liq = hf > 0 ? eth / hf : eth

          return {
            addr: it.wallet,
            proto: 'Aave V3' as const,
            h: hf,
            col: Number(it.collateralUsd || 0),
            liq,
          }
        })
        .sort((a, b) => a.h - b.h)

      setAllWallets(wallets)
      setPage(1)
    } catch {
      // If the subgraph is temporarily unavailable, keep last state.
    }
  }, [API, PX.ETH])

  useEffect(() => {
    rebuildWallets()
    const t = setInterval(rebuildWallets, 15000)
    return () => clearInterval(t)
  }, [rebuildWallets])

  const doCheck = useCallback(async () => {
    const addr = (checkAddr || '').trim()
    if (!addr) return

    try {
      const r = await fetch(`${API}/aave/wallet/${addr}`)
      const d = await r.json()

      const hf = Number(d?.computed?.healthFactor)
      const score = Number(d?.computed?.riskScore)
      const col = Number(d?.computed?.collateralUsd)
      const debt = Number(d?.computed?.debtUsd)
      const time = String(d?.computed?.timeToLiqLabel || '—')

      if (!Number.isFinite(hf) || !Number.isFinite(score)) throw new Error('bad_response')

      const colorVar = hf < 1.05 ? 'var(--red)' : hf < 1.15 ? 'var(--orange)' : hf < 1.3 ? 'var(--yellow)' : 'var(--green)'

      const status =
        hf < 1.05
          ? '⚠ CRITICAL — LIQUIDATION IMMINENT'
          : hf < 1.15
            ? '⚡ HIGH RISK — ACT NOW'
            : hf < 1.3
              ? '⚠ ELEVATED RISK'
              : '✓ POSITION IS HEALTHY'

      const gaugeBg =
        hf < 1.05
          ? 'var(--red)'
          : hf < 1.15
            ? 'linear-gradient(90deg,var(--red),var(--orange))'
            : hf < 1.3
              ? 'linear-gradient(90deg,var(--orange),var(--yellow))'
              : 'linear-gradient(90deg,var(--yellow),var(--green))'

      let alertClass = 'alert-strip a-safe'
      let alertText = '✓ Position healthy.'

      if (hf < 1.05) {
        alertClass = 'alert-strip a-danger'
        alertText = '🚨 CRITICAL: Health Factor extremely low. Add collateral / reduce debt immediately.'
      } else if (hf < 1.15) {
        alertClass = 'alert-strip a-warn'
        alertText = '⚠ HIGH RISK: Health Factor close to liquidation. Consider reducing exposure.'
      }

      setResult({
        short: shortAddr(addr),
        ts: new Date().toLocaleTimeString('en-US', { hour12: false }),
        score: Number(score.toFixed(0)),
        colorVar,
        status,
        gauge: { widthPct: score, background: gaugeBg },
        collateral: fmtUsd(Number.isFinite(col) ? col : 0, 0),
        debt: fmtUsd(Number.isFinite(debt) ? debt : 0, 0),
        liq: '—',
        time,
        alertClass,
        alertText,
      })
    } catch {
      setResult({
        short: shortAddr(addr),
        ts: new Date().toLocaleTimeString('en-US', { hour12: false }),
        score: 0,
        colorVar: 'var(--t3)',
        status: 'API ERROR',
        gauge: { widthPct: 0, background: 'var(--t3)' },
        collateral: '—',
        debt: '—',
        liq: '—',
        time: '—',
        alertClass: 'alert-strip a-warn',
        alertText: 'Could not fetch wallet data from API.',
      })
    }
  }, [API, checkAddr])

  const onFullKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') doCheck()
    },
    [doCheck],
  )

  const priceChip = (sym: PriceSym) => {
    const price = PX[sym]
    const prev = PP[sym]
    const chg = prev ? ((price - prev) / prev) * 100 : 0

    const priceText = price >= 1000 ? '$' + price.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '$' + price.toFixed(2)
    const chgText = (chg >= 0 ? '+' : '') + chg.toFixed(3) + '%'

    return (
      <div className="price-chip">
        <div className="pc-sym">{sym}</div>
        <div className="pc-price">{priceText}</div>
        <div className={'pc-chg ' + (chg >= 0 ? 'up' : 'dn')}>{chgText}</div>
      </div>
    )
  }

  const total = allWallets.length
  const start = (page - 1) * PER_PAGE

  return (
    <>
      <DroppingLines />

      {/* FIXED TOPBAR */}
      <div className="topbar">
        <div className="logo">
          <div className="logo-icon">⚡</div>
          ORACLE<em>SIM</em>
        </div>
        <div className="pill pill-green">
          <span className="blink blink-g" />PYTH LIVE
        </div>
        <div className="pill pill-red">
          <span className="blink blink-r" />
          <span id="danger-count">{critCount}</span>&nbsp;AT RISK
        </div>
        <div className="tb-right">
          {priceChip('BTC')}
          {priceChip('ETH')}
          {priceChip('SOL')}
        </div>
      </div>

      {/* NAV DOTS */}
      <div className="nav-dots">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className={'nav-dot ' + (activeSection === i ? 'active' : '')}
            onClick={() => scrollToIndex(i)}
            title={i === 0 ? 'Liquidation Radar' : i === 1 ? 'Wallet Checker' : 'Risk Stats'}
          />
        ))}
      </div>

      {/* SCROLL HINT */}
      <div className="scroll-hint" id="scroll-hint" style={{ opacity: activeSection === sectionsCount - 1 ? 0 : 1 }}>
        <div className="scroll-hint-arrow">↓</div>
        <span>SCROLL</span>
      </div>

      {/* SCROLL CONTAINER */}
      <div className="scroll-wrap" id="scroll-wrap" ref={scrollWrapRef}>
        {/* SECTION 1 */}
        <div className="section" id="sec-radar">
          <div className="sec-eyebrow">
            <span />SECTION 01<span />
          </div>
          <div className="sec-title">
            🔴 Live Liquidation <em style={{ color: 'var(--blue)' }}>Radar</em>
          </div>

          <div className="radar-grid" style={{ flex: 1, minHeight: 0 }}>
            {/* Feed */}
            <div className="card feed-card">
              <div className="feed-head">
                <div>
                  <div className="fh-title">WALLETS AT RISK</div>
                  <div className="fh-sub">AAVE V3 · BASE · POWERED BY PYTH NETWORK · LIVE</div>
                </div>
                <div className="crit-badge">
                  <div className="cb-num" id="crit-num">
                    {critCount}
                  </div>
                  <div className="cb-lbl">CRITICAL</div>
                </div>
              </div>

              <div className="feed-cols">
                <span>WALLET</span>
                <span>COLLATERAL</span>
                <span>HEALTH</span>
                <span>LIQ PRICE</span>
                <span>RISK</span>
              </div>

              <div className="feed-rows-wrap" id="feed-rows">
                {slice.map((w) => {
                  const r = riskFromHF(w.h)
                  return (
                    <div className="feed-row" key={w.addr + w.proto}>
                      <div className="fr-info">
                        <div className="fr-dot" style={{ background: r.colorVar, boxShadow: `0 0 7px ${r.colorVar}` }} />
                        <div>
                          <div className="fr-addr">{w.addr}</div>
                          <div className="fr-proto">{w.proto}</div>
                        </div>
                      </div>
                      <div className="fr-col">{fmtUsd(w.col, 0)}</div>
                      <div className="fr-health" style={{ color: r.colorVar }}>
                        {w.h.toFixed(3)}
                      </div>
                      <div className="fr-liq">{fmtUsd(w.liq, 0)}</div>
                      <div className={'badge ' + r.badgeClass}>{r.band}</div>
                    </div>
                  )
                })}
              </div>

              <div className="pagination">
                <div className="page-info" id="page-info">
                  {pageInfoText}
                </div>
                <div className="page-btns">
                  <button className="page-btn" id="btn-prev" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
                    ← PREV
                  </button>
                  {[1, 2, 3, 4, 5].map((p) => (
                    <button key={p} className={'page-btn ' + (p === page ? 'active' : '')} id={`btn-p${p}`} onClick={() => setPage(p)}>
                      {p}
                    </button>
                  ))}
                  <button
                    className="page-btn"
                    id="btn-next"
                    onClick={() => setPage((p) => Math.min(5, p + 1))}
                    disabled={start + PER_PAGE >= total}
                  >
                    NEXT →
                  </button>
                </div>
              </div>
            </div>

            {/* Sidebar */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
              <div className="card" style={{ ['--c-top' as any]: 'linear-gradient(90deg,var(--purple),var(--blue))', padding: 18, flex: 1 }}>
                <div style={{ fontSize: 9, letterSpacing: '0.2em', color: 'var(--t3)', marginBottom: 10 }}>PROTOCOL STATS</div>
                <div style={{ fontSize: 11, color: 'var(--t2)', lineHeight: 2.2 }}>
                  Total collateral: <span style={{ color: 'var(--t1)', fontFamily: "'JetBrains Mono',monospace" }}>$2.4B</span>
                  <br />
                  At-risk value: <span style={{ color: 'var(--orange)', fontFamily: "'JetBrains Mono',monospace" }} id="sidebar-atrisk">
                    {atRiskStr}
                  </span>
                  <br />
                  Critical wallets:{' '}
                  <span style={{ color: 'var(--red)', fontFamily: "'JetBrains Mono',monospace" }} id="sidebar-crit">
                    {critCount} wallets
                  </span>
                  <br />
                  Last updated:{' '}
                  <span style={{ color: 'var(--t3)', fontFamily: "'JetBrains Mono',monospace" }} id="sidebar-time">
                    {sidebarTime}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* SECTION 2 */}
        <div className="section" id="sec-checker" style={{ justifyContent: 'center', alignItems: 'center' }}>
          <div style={{ width: '100%', maxWidth: 600 }}>
            <div className="sec-eyebrow" style={{ justifyContent: 'center' }}>
              <span />SECTION 02<span />
            </div>
            <div className="sec-title" style={{ textAlign: 'center' }}>
              Wallet <em style={{ color: 'var(--cyan)' }}>Health Check</em>
            </div>

            <div className="card ck-card" style={{ marginBottom: 16 }}>
              <div className="ck-h">PASTE ANY WALLET ADDRESS</div>
              <div className="ck-s">
                Get an instant liquidation risk score powered by Pyth Network live price feeds. Works on Aave, Compound and Morpho Blue.
              </div>
              <input
                className="w-input"
                id="w-input"
                placeholder="0x... paste wallet address"
                maxLength={42}
                value={checkAddr}
                onChange={(e) => setCheckAddr(e.target.value)}
                onKeyDown={onFullKey}
              />
              <select className="w-select" defaultValue="AAVE V3 — BASE">
                <option>AAVE V3 — BASE</option>
                <option>COMPOUND V3</option>
                <option>MORPHO BLUE</option>
              </select>
              <button className="analyze-btn" onClick={doCheck}>
                ⚡ ANALYZE RISK NOW
              </button>
            </div>

            <div className={'card result-card ' + (result ? 'show' : '')} id="result-card">
              <div className="rr-meta">
                <div className="rr-addr" id="rr-addr">
                  {result?.short || '—'}
                </div>
                <div className="rr-ts" id="rr-ts">
                  {result?.ts || '—'}
                </div>
              </div>

              <div className="score-center">
                <div className="score-lbl">HEALTH SCORE</div>
                <div className="score-num" id="rr-score" style={{ color: result ? result.colorVar : undefined }}>
                  {result?.score ?? '—'}
                </div>
                <div className="score-status" id="rr-status" style={{ color: result ? result.colorVar : undefined }}>
                  {result?.status || '—'}
                </div>
              </div>

              <div className="gauge-wrap">
                <div className="gauge-bar">
                  <div className="gauge-fill" id="g-fill" style={{ width: `${result?.gauge.widthPct ?? 0}%`, background: result?.gauge.background }} />
                </div>
                <div className="gauge-labels">
                  <span style={{ color: 'var(--red)' }}>CRITICAL</span>
                  <span style={{ color: 'var(--orange)' }}>HIGH</span>
                  <span style={{ color: 'var(--yellow)' }}>MED</span>
                  <span style={{ color: 'var(--green)' }}>SAFE</span>
                </div>
              </div>

              <div className="stats-grid">
                <div className="stat-box">
                  <div className="sb-lbl">COLLATERAL</div>
                  <div className="sb-val" id="sb-col">
                    {result?.collateral || '—'}
                  </div>
                  <div className="sb-sub">USD locked</div>
                </div>
                <div className="stat-box">
                  <div className="sb-lbl">DEBT</div>
                  <div className="sb-val" id="sb-debt">
                    {result?.debt || '—'}
                  </div>
                  <div className="sb-sub">total borrowed</div>
                </div>
                <div className="stat-box">
                  <div className="sb-lbl">LIQ PRICE</div>
                  <div className="sb-val" id="sb-liq">
                    {result?.liq || '—'}
                  </div>
                  <div className="sb-sub">ETH trigger</div>
                </div>
                <div className="stat-box">
                  <div className="sb-lbl">TIME TO LIQ</div>
                  <div className="sb-val" id="sb-time">
                    {result?.time || '—'}
                  </div>
                  <div className="sb-sub">at current rate</div>
                </div>
              </div>

              <div className={result?.alertClass || 'alert-strip'} id="alert-strip">
                {result?.alertText || '—'}
              </div>
            </div>

            {result ? (
              <button
                className="analyze-btn"
                style={{ marginTop: 12 }}
                onClick={() => {
                  setResult(null)
                  setCheckAddr('')
                  // try to bring focus back to the input
                  setTimeout(() => document.getElementById('w-input')?.focus(), 0)
                }}
              >
                CHECK ANOTHER WALLET
              </button>
            ) : null}
          </div>
        </div>

        {/* SECTION 3 */}
        <div className="section" id="sec-stats">
          <div className="sec-eyebrow">
            <span />SECTION 03<span />
          </div>
          <div className="sec-title">
            Market <em style={{ color: 'var(--orange)' }}>Risk Stats</em>
          </div>

          <div className="stats-row">
            <div className="card b-card" style={{ ['--c-top' as any]: 'linear-gradient(90deg,var(--red),var(--orange))' }}>
              <div className="bc-h">TOTAL AT RISK</div>
              <div className="bc-s">Near-liquidation positions across protocols</div>
              <div className="big-num" style={{ color: 'var(--red)' }} id="b-atrisk">
                {atRiskStr}
              </div>
              <div className="big-sub">in danger zone right now</div>

              <div className="rbar">
                <div className="rbar-top">
                  <span style={{ color: 'var(--red)' }}>CRITICAL &lt;1.05</span>
                  <span className="rbar-pct" id="pct-c">
                    {pctBands.c.toFixed(1)}%
                  </span>
                </div>
                <div className="rbar-track">
                  <div className="rbar-fill" id="rb-c" style={{ width: `${pctBands.c}%`, background: 'var(--red)' }} />
                </div>
              </div>

              <div className="rbar">
                <div className="rbar-top">
                  <span style={{ color: 'var(--orange)' }}>HIGH &lt;1.15</span>
                  <span className="rbar-pct" id="pct-h">
                    {pctBands.hi.toFixed(1)}%
                  </span>
                </div>
                <div className="rbar-track">
                  <div className="rbar-fill" id="rb-h" style={{ width: `${pctBands.hi}%`, background: 'var(--orange)' }} />
                </div>
              </div>

              <div className="rbar">
                <div className="rbar-top">
                  <span style={{ color: 'var(--yellow)' }}>MEDIUM &lt;1.3</span>
                  <span className="rbar-pct" id="pct-m">
                    {pctBands.md.toFixed(1)}%
                  </span>
                </div>
                <div className="rbar-track">
                  <div className="rbar-fill" id="rb-m" style={{ width: `${pctBands.md}%`, background: 'var(--yellow)' }} />
                </div>
              </div>
            </div>

            <div className="card b-card" style={{ ['--c-top' as any]: 'linear-gradient(90deg,var(--blue),var(--cyan))' }}>
              <div className="bc-h">MONTE CARLO</div>
              <div className="bc-s">1,000 simulated ETH price paths via Pyth</div>
              <MiniMonteCarlo ethPrice={PX.ETH} />
            </div>

            <div className="card b-card" style={{ ['--c-top' as any]: 'linear-gradient(90deg,var(--teal),var(--green))' }}>
              <div className="bc-h">PROTOCOL BREAKDOWN</div>
              <div className="bc-s">At-risk collateral by lending protocol</div>
              <table className="proto-table">
                <tbody>
                  <tr>
                    <td>Aave V3</td>
                    <td style={{ color: 'var(--red)' }}>$340M</td>
                  </tr>
                  <tr>
                    <td>Compound V3</td>
                    <td style={{ color: 'var(--orange)' }}>$180M</td>
                  </tr>
                  <tr>
                    <td>Morpho Blue</td>
                    <td style={{ color: 'var(--yellow)' }}>$95M</td>
                  </tr>
                  <tr>
                    <td>Others</td>
                    <td style={{ color: 'var(--t2)' }}>$62M</td>
                  </tr>
                  <tr className="proto-total">
                    <td>TOTAL AT RISK</td>
                    <td style={{ color: 'var(--red)' }}>$677M</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
