import { useEffect, useRef, useState } from 'react'
import { bus } from './bus.js'

const PUBLIC_WS = 'wss://api.derivws.com/trading/v1/options/ws/public'
const MKTS = [
  ['R_10', 'Volatility 10'], ['R_25', 'Volatility 25'], ['R_50', 'Volatility 50'],
  ['R_75', 'Volatility 75'], ['R_100', 'Volatility 100'],
  ['1HZ10V', 'Vol 10 (1s)'], ['1HZ25V', 'Vol 25 (1s)'], ['1HZ50V', 'Vol 50 (1s)'],
  ['1HZ75V', 'Vol 75 (1s)'], ['1HZ100V', 'Vol 100 (1s)'],
  ['frxEURUSD', 'EUR/USD'], ['frxGBPUSD', 'GBP/USD'], ['frxUSDJPY', 'USD/JPY'],
  ['frxXAUUSD', 'Gold'], ['cryBTCUSD', 'Bitcoin'],
]
const MN = Object.fromEntries(MKTS)
const TFS = [[60, '1m'], [120, '2m'], [180, '3m'], [300, '5m'], [600, '10m'], [900, '15m'], [1800, '30m'], [3600, '1h']]
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const DEF = {
  sym: 'R_100', gran: 300, zones: true, zig: true, hl: true, pats: true, rt: true,
  swing: 3, tol: 0.5, minTouch: 2, armN: 3, wick: 2, sound: true,
  hold: 2, stake: 1, sl: 10, tp: 10,
}
const loadCfg = () => {
  try { return { ...DEF, ...JSON.parse(localStorage.bbfx_rf || '{}') } } catch (e) { return DEF }
}
const parseC = (c) => ({ t: Number(c.epoch ?? c.open_time), o: Number(c.open), h: Number(c.high), l: Number(c.low), c: Number(c.close) })
const validC = (c) => [c.t, c.o, c.h, c.l, c.c].every(Number.isFinite)
const isDone = (c) => !!c && (Boolean(c.is_sold) || c.status === 'won' || c.status === 'lost')
const pnl = (c) => {
  if (c.profit !== undefined && c.profit !== null && c.profit !== '') {
    const p = Number(c.profit)
    if (!Number.isNaN(p)) return p
  }
  const buy = Number(c.buy_price)
  const pay = Number(c.payout)
  if (c.status === 'won' && isFinite(buy) && isFinite(pay)) return pay - buy
  if (c.status === 'lost' && isFinite(buy)) return -buy
  return NaN
}

// ---------- analysis ----------
const atrOf = (cs, upTo, n = 14) => {
  let s = 0
  let k = 0
  for (let i = Math.max(1, upTo - n + 1); i <= upTo; i++) {
    s += Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c))
    k += 1
  }
  return k ? s / k : 0
}
const findSwings = (cs, N) => {
  const out = []
  for (let i = N; i < cs.length - N; i++) {
    let hi = true
    let lo = true
    for (let j = 1; j <= N; j++) {
      if (cs[i - j].h >= cs[i].h || cs[i + j].h > cs[i].h) hi = false
      if (cs[i - j].l <= cs[i].l || cs[i + j].l < cs[i].l) lo = false
    }
    if (hi) out.push({ i, p: cs[i].h, type: 'H', conf: i + N })
    if (lo) out.push({ i, p: cs[i].l, type: 'L', conf: i + N })
  }
  return out
}
const zigzag = (sw) => {
  const out = []
  sw.slice().sort((a, b) => a.i - b.i).forEach((s) => {
    const last = out[out.length - 1]
    if (last && last.type === s.type) {
      if ((s.type === 'H' && s.p > last.p) || (s.type === 'L' && s.p < last.p)) out[out.length - 1] = s
    } else out.push(s)
  })
  let ph = null
  let pl = null
  return out.map((z) => {
    let lab
    if (z.type === 'H') { lab = ph === null ? 'H' : z.p > ph ? 'HH' : 'LH'; ph = z.p }
    else { lab = pl === null ? 'L' : z.p < pl ? 'LL' : 'HL'; pl = z.p }
    return { ...z, lab }
  })
}
const buildZones = (sw, atr, price, minTouch, tolMul) => {
  if (!(atr > 0)) return []
  const tol = atr * tolMul
  const pts = sw.map((s) => ({ p: s.p, i: s.i })).sort((a, b) => a.p - b.p)
  const groups = []
  pts.forEach((pt) => {
    const g = groups[groups.length - 1]
    if (g && pt.p - g.lo <= tol) { g.hi = pt.p; g.n += 1; g.last = Math.max(g.last, pt.i); g.first = Math.min(g.first, pt.i) }
    else groups.push({ lo: pt.p, hi: pt.p, n: 1, last: pt.i, first: pt.i })
  })
  const pad = atr * 0.08
  return groups.filter((g) => g.n >= minTouch)
    .map((g) => ({ lo: g.lo - pad, hi: g.hi + pad, mid: (g.lo + g.hi) / 2, n: g.n, first: g.first, last: g.last }))
    .sort((a, b) => Math.abs(a.mid - price) - Math.abs(b.mid - price))
    .slice(0, 6)
}
// a zone price closed through and later came back to touch
const retestOf = (cs, z) => {
  const ev = []
  let side = 0
  let brokenAt = -1
  for (let k = z.last + 1; k < cs.length; k++) {
    const c = cs[k]
    if (c.c > z.hi) {
      if (side !== 1) { side = 1; brokenAt = k }
      else if (brokenAt >= 0 && k > brokenAt && c.l <= z.hi) { ev.push({ i: k, dir: 'up' }); brokenAt = -1 }
    } else if (c.c < z.lo) {
      if (side !== -1) { side = -1; brokenAt = k }
      else if (brokenAt >= 0 && k > brokenAt && c.h >= z.lo) { ev.push({ i: k, dir: 'down' }); brokenAt = -1 }
    }
  }
  return ev
}
const patternAt = (cs, i, atr, wickR) => {
  const c = cs[i]
  const p = cs[i - 1]
  if (!p) return []
  const out = []
  const body = Math.abs(c.c - c.o)
  const rng = Math.max(c.h - c.l, 1e-9)
  const pb = Math.abs(p.c - p.o)
  if (c.c > c.o && p.c < p.o && c.o <= p.c && c.c >= p.o && body >= 0.3 * atr && body > pb) out.push({ kind: 'engulf', dir: 'up' })
  if (c.c < c.o && p.c > p.o && c.o >= p.c && c.c <= p.o && body >= 0.3 * atr && body > pb) out.push({ kind: 'engulf', dir: 'down' })
  const upW = c.h - Math.max(c.o, c.c)
  const loW = Math.min(c.o, c.c) - c.l
  const b2 = Math.max(body, 0.08 * rng)
  const p2 = cs[i - 2] || p
  if (loW >= wickR * b2 && loW >= 0.55 * rng && upW <= 0.25 * rng && c.l < Math.min(p.l, p2.l) && rng >= 0.5 * atr) out.push({ kind: 'kangaroo', dir: 'up' })
  if (upW >= wickR * b2 && upW >= 0.55 * rng && loW <= 0.25 * rng && c.h > Math.max(p.h, p2.h) && rng >= 0.5 * atr) out.push({ kind: 'kangaroo', dir: 'down' })
  return out
}
// closed candles only: zones, patterns, signals, and how those signals did
const analyseClosed = (cs, cfg) => {
  const N = clamp(Math.round(+cfg.swing || 3), 2, 8)
  const minT = clamp(Math.round(+cfg.minTouch || 2), 2, 5)
  const tolM = clamp(+cfg.tol || 0.5, 0.15, 2)
  const armN = clamp(Math.round(+cfg.armN || 3), 1, 8)
  const wickR = clamp(+cfg.wick || 2, 1.2, 6)
  const hold = clamp(Math.round(+cfg.hold || 2), 1, 20)
  const sw = findSwings(cs, N)
  const sigs = []
  const pats = []
  let armed = []
  for (let i = 16; i < cs.length; i++) {
    const c = cs[i]
    const prevC = cs[i - 1].c
    const atr = atrOf(cs, i)
    const zones = buildZones(sw.filter((s) => s.conf <= i), atr, c.c, minT, tolM)
    armed = armed.filter((a) => i - a.k <= armN)
    zones.forEach((z) => {
      if (prevC < z.lo && c.h >= z.lo && c.c <= z.hi) armed.push({ dir: 'down', z, k: i })
      else if (prevC > z.hi && c.l <= z.hi && c.c >= z.lo) armed.push({ dir: 'up', z, k: i })
    })
    patternAt(cs, i, atr, wickR).forEach((p) => {
      const hit = armed.find((a) => a.dir === p.dir)
      const rec = { i, t: c.t, kind: p.kind, dir: p.dir, sig: false }
      const dir = p.dir === 'up' ? 'rise' : 'fall'
      if (hit && !sigs.some((s) => s.i === i && s.dir === dir)) {
        rec.sig = true
        sigs.push({ i, t: c.t, dir, kind: p.kind, price: c.c, z: hit.z })
        armed = armed.filter((a) => a.z !== hit.z)
      }
      pats.push(rec)
    })
  }
  const last = cs[cs.length - 1]
  const atr = atrOf(cs, cs.length - 1)
  const zz = zigzag(sw)
  const zones = buildZones(sw, atr, last.c, minT, tolM)
  const rts = []
  zones.forEach((z) => {
    const ev = retestOf(cs, z)
    z.retest = ev.length ? ev[ev.length - 1] : null
    ev.forEach((e) => rts.push({ ...e, z }))
  })
  let done = 0
  let wins = 0
  sigs.forEach((s) => {
    const j = s.i + hold
    if (j < cs.length) {
      done += 1
      s.win = s.dir === 'rise' ? cs[j].c > cs[s.i].c : cs[j].c < cs[s.i].c
      if (s.win) wins += 1
    }
  })
  const lastH = [...zz].reverse().find((z) => z.type === 'H')
  const lastL = [...zz].reverse().find((z) => z.type === 'L')
  return { zz, zones, sigs, pats, rts, atr, lastH, lastL, armedEnd: armed, bt: { n: sigs.length, done, wins, hold, bars: cs.length } }
}
// the candle still forming: is price touching a zone right now?
const liveStatus = (base, cs) => {
  const fc = cs[cs.length - 1]
  const pc = cs[cs.length - 2].c
  const out = []
  base.zones.forEach((z) => {
    if (pc < z.lo && fc.h >= z.lo && fc.c <= z.hi) out.push({ dir: 'down', z, live: true })
    else if (pc > z.hi && fc.l <= z.hi && fc.c >= z.lo) out.push({ dir: 'up', z, live: true })
  })
  base.armedEnd.forEach((a) => { if (!out.some((o) => o.z === a.z && o.dir === a.dir)) out.push({ dir: a.dir, z: a.z, live: false }) })
  return out
}

// ---------- chart ----------
const PAD = 3
const geom = (W, H, view, len) => {
  const axisW = 60
  const timeH = 18
  const plotW = W - axisW
  const plotH = H - timeH
  const barW = view.barW
  const off = clamp(view.off, 0, Math.max(0, len - 8))
  const endIdx = len - 1 - Math.round(off)
  const n = Math.ceil(plotW / barW) + 2
  const start = Math.max(0, endIdx - n + 1)
  const x = (i) => plotW - (endIdx - i + PAD) * barW + barW / 2
  return { axisW, timeH, plotW, plotH, barW, endIdx, start, x }
}
const fmtT = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const draw = (cv, W, H, cs, an, cfg, view) => {
  const dpr = window.devicePixelRatio || 1
  cv.width = Math.round(W * dpr)
  cv.height = Math.round(H * dpr)
  const g = cv.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.fillStyle = '#060d1f'
  g.fillRect(0, 0, W, H)
  if (!cs.length) {
    g.fillStyle = '#7f95bf'
    g.font = '13px sans-serif'
    g.fillText('Loading candles…', 16, 28)
    return
  }
  const gm = geom(W, H, view, cs.length)
  const { plotW, plotH, barW, endIdx, start, x } = gm
  let hi = -Infinity
  let lo = Infinity
  for (let i = start; i <= endIdx; i++) {
    if (cs[i].h > hi) hi = cs[i].h
    if (cs[i].l < lo) lo = cs[i].l
  }
  if (!isFinite(hi)) return
  const span = Math.max(hi - lo, 1e-9)
  hi += span * 0.1
  lo -= span * 0.1
  const y = (p) => plotH - ((p - lo) / (hi - lo)) * plotH
  const dec = clamp(3 - Math.floor(Math.log10(span)), 2, 5)
  const fmt = (p) => p.toFixed(dec)
  const lastP = cs[cs.length - 1].c
  g.font = '10px sans-serif'
  g.textBaseline = 'middle'
  for (let k = 0; k <= 5; k++) {
    const p = lo + ((hi - lo) * k) / 5
    const yy = y(p)
    g.strokeStyle = 'rgba(124,196,255,.08)'
    g.beginPath(); g.moveTo(0, yy); g.lineTo(plotW, yy); g.stroke()
    g.fillStyle = '#7f95bf'
    g.fillText(fmt(p), plotW + 5, yy)
  }
  g.save()
  g.beginPath(); g.rect(0, 0, plotW, plotH); g.clip()
  if (cfg.zones && an) {
    an.base.zones.forEach((z) => {
      const res = z.mid > lastP
      const x0 = Math.max(0, x(z.first) - barW / 2)
      const yT = y(z.hi)
      const yB = y(z.lo)
      const hgt = Math.max(3, yB - yT)
      g.fillStyle = res ? 'rgba(255,77,94,.16)' : 'rgba(25,195,126,.16)'
      g.fillRect(x0, yT, plotW - x0, hgt)
      g.strokeStyle = z.retest && cfg.rt ? '#ffc43c' : res ? 'rgba(255,77,94,.7)' : 'rgba(25,195,126,.7)'
      g.lineWidth = 1
      g.setLineDash(z.retest && cfg.rt ? [5, 4] : [])
      g.beginPath(); g.moveTo(x0, yT); g.lineTo(plotW, yT); g.moveTo(x0, yT + hgt); g.lineTo(plotW, yT + hgt); g.stroke()
      g.setLineDash([])
      g.fillStyle = res ? '#ff9aa8' : '#7dffb8'
      g.fillText((res ? 'R ' : 'S ') + fmt(z.mid) + ' ×' + z.n + (z.retest && cfg.rt ? ' RT' : ''), x0 + 4, yT + Math.min(hgt, 12) / 2 + 2)
    })
  }
  if (cfg.hl && an) {
    const hl = (z, col, label) => {
      if (!z) return
      const yy = y(z.p)
      g.strokeStyle = col
      g.setLineDash([2, 4])
      g.beginPath(); g.moveTo(Math.max(0, x(z.i)), yy); g.lineTo(plotW, yy); g.stroke()
      g.setLineDash([])
      g.fillStyle = col
      g.fillText(label + ' ' + fmt(z.p), plotW - 96, yy - 7)
    }
    hl(an.base.lastH, '#9d8cff', 'Last high')
    hl(an.base.lastL, '#4cc9f0', 'Last low')
  }
  if (cfg.zig && an && an.base.zz.length > 1) {
    g.strokeStyle = 'rgba(190,160,255,.85)'
    g.lineWidth = 1.6
    g.beginPath()
    an.base.zz.forEach((z, k) => { if (k === 0) g.moveTo(x(z.i), y(z.p)); else g.lineTo(x(z.i), y(z.p)) })
    g.stroke()
    g.lineWidth = 1
    an.base.zz.forEach((z) => {
      if (z.i < start || z.i > endIdx) return
      const up = z.lab === 'HH' || z.lab === 'HL'
      g.fillStyle = up ? '#7dffb8' : z.lab === 'LL' || z.lab === 'LH' ? '#ff9aa8' : '#cdb8ff'
      g.fillText(z.lab, x(z.i) - 7, z.type === 'H' ? y(z.p) - 10 : y(z.p) + 12)
    })
  }
  for (let i = start; i <= endIdx; i++) {
    const c = cs[i]
    const up = c.c >= c.o
    const xx = x(i)
    g.strokeStyle = up ? '#19c37e' : '#ff4d5e'
    g.fillStyle = up ? '#19c37e' : '#ff4d5e'
    g.beginPath(); g.moveTo(xx, y(c.h)); g.lineTo(xx, y(c.l)); g.stroke()
    const bw = Math.max(1, barW * 0.68)
    const top = y(Math.max(c.o, c.c))
    g.fillRect(xx - bw / 2, top, bw, Math.max(1, y(Math.min(c.o, c.c)) - top))
  }
  if (an) {
    if (cfg.pats) {
      an.base.pats.forEach((p) => {
        if (p.i < start || p.i > endIdx) return
        const c = cs[p.i]
        const upd = p.dir === 'up'
        g.fillStyle = upd ? '#7dffb8' : '#ff9aa8'
        g.font = p.sig ? '11px sans-serif' : '9px sans-serif'
        g.fillText((upd ? '▲' : '▼') + (p.kind === 'engulf' ? 'E' : 'K'), x(p.i) - 8, upd ? y(c.l) + 12 : y(c.h) - 12)
      })
      g.font = '10px sans-serif'
    }
    if (cfg.rt) {
      an.base.rts.forEach((r) => {
        if (r.i < start || r.i > endIdx) return
        g.fillStyle = '#ffc43c'
        g.fillText('RT', x(r.i) - 6, r.dir === 'up' ? y(cs[r.i].l) + 24 : y(cs[r.i].h) - 24)
      })
    }
    an.base.sigs.forEach((s) => {
      if (s.i < start || s.i > endIdx) return
      const c = cs[s.i]
      const rise = s.dir === 'rise'
      const yy = rise ? y(c.l) + 26 : y(c.h) - 26
      g.fillStyle = rise ? '#19c37e' : '#ff4d5e'
      const w = 40
      g.beginPath()
      if (g.roundRect) g.roundRect(x(s.i) - w / 2, yy - 8, w, 16, 8); else g.rect(x(s.i) - w / 2, yy - 8, w, 16)
      g.fill()
      g.fillStyle = '#fff'
      g.font = 'bold 9px sans-serif'
      g.fillText(rise ? 'RISE' : 'FALL', x(s.i) - 12, yy)
      g.font = '10px sans-serif'
    })
  }
  const fi = cs.length - 1
  if (fi >= start && fi <= endIdx) {
    g.strokeStyle = 'rgba(255,255,255,.55)'
    g.strokeRect(x(fi) - barW / 2, y(cs[fi].h), barW, Math.max(2, y(cs[fi].l) - y(cs[fi].h)))
  }
  const py = y(lastP)
  g.strokeStyle = 'rgba(255,255,255,.4)'
  g.setLineDash([4, 4])
  g.beginPath(); g.moveTo(0, py); g.lineTo(plotW, py); g.stroke()
  g.setLineDash([])
  if (view.cross >= 0 && view.cross < cs.length) {
    const xx = x(view.cross)
    g.strokeStyle = 'rgba(255,255,255,.35)'
    g.beginPath(); g.moveTo(xx, 0); g.lineTo(xx, plotH); g.stroke()
  }
  g.restore()
  const up = lastP >= cs[cs.length - 1].o
  g.fillStyle = up ? '#19c37e' : '#ff4d5e'
  g.fillRect(plotW, py - 8, 60, 16)
  g.fillStyle = '#fff'
  g.fillText(fmt(lastP), plotW + 4, py)
  g.fillStyle = '#7f95bf'
  const stepN = Math.max(1, Math.round(90 / barW))
  for (let i = endIdx; i >= start; i -= stepN) g.fillText(fmtT(cs[i].t), x(i) - 14, plotH + 10)
  if (view.cross >= 0 && view.cross < cs.length) {
    const c = cs[view.cross]
    const txt = fmtT(c.t) + '  O ' + fmt(c.o) + '  H ' + fmt(c.h) + '  L ' + fmt(c.l) + '  C ' + fmt(c.c)
    g.fillStyle = 'rgba(8,18,38,.9)'
    g.fillRect(6, 6, g.measureText(txt).width + 14, 20)
    g.fillStyle = '#e9f1ff'
    g.fillText(txt, 13, 16)
  }
}

function RfChart({ cs, an, cfg, view, onView }) {
  const wrap = useRef(null)
  const cv = useRef(null)
  const [sz, setSz] = useState({ w: 320, h: 360 })
  const ptr = useRef(new Map())
  const drag = useRef(null)
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const set = () => setSz({ w: Math.max(200, el.clientWidth), h: Math.max(200, el.clientHeight) })
    set()
    let ro
    if (window.ResizeObserver) { ro = new ResizeObserver(set); ro.observe(el) }
    return () => { if (ro) ro.disconnect() }
  }, [])
  useEffect(() => { if (cv.current) draw(cv.current, sz.w, sz.h, cs, an, cfg, view) })
  const down = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    ptr.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (ptr.current.size === 1) drag.current = { x: e.clientX, off: view.off, moved: 0 }
    else if (ptr.current.size === 2) {
      const [a, b] = [...ptr.current.values()]
      drag.current = { pd: Math.hypot(a.x - b.x, a.y - b.y), bw: view.barW, moved: 99 }
    }
  }
  const move = (e) => {
    if (!ptr.current.has(e.pointerId)) return
    ptr.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const d = drag.current
    if (!d) return
    if (ptr.current.size >= 2 && d.pd) {
      const [a, b] = [...ptr.current.values()]
      view.barW = clamp((d.bw * Math.hypot(a.x - b.x, a.y - b.y)) / d.pd, 3, 32)
    } else if (ptr.current.size === 1 && d.off !== undefined) {
      const dx = e.clientX - d.x
      d.moved = Math.max(d.moved, Math.abs(dx))
      view.off = clamp(d.off + dx / view.barW, 0, Math.max(0, cs.length - 8))
    }
    onView()
  }
  const up = (e) => {
    const d = drag.current
    const had = ptr.current.get(e.pointerId)
    ptr.current.delete(e.pointerId)
    if (d && d.moved < 6 && d.off !== undefined && had) {
      const rect = e.currentTarget.getBoundingClientRect()
      const gm = geom(sz.w, sz.h, view, cs.length)
      const i = gm.endIdx - Math.round((gm.plotW - PAD * gm.barW + gm.barW / 2 - (e.clientX - rect.left)) / gm.barW)
      view.cross = i >= 0 && i < cs.length && view.cross !== i ? i : -1
      onView()
    }
    if (ptr.current.size === 0) drag.current = null
  }
  const wheel = (e) => { view.barW = clamp(view.barW * (e.deltaY < 0 ? 1.1 : 0.9), 3, 32); onView() }
  return (
    <div className="rf-cwrap" ref={wrap}>
      <canvas
        ref={cv} style={{ width: sz.w, height: sz.h, touchAction: 'none', display: 'block' }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel}
      />
    </div>
  )
}

export default function RiseFall({ active, tradeOn, send, cur, demo, addHist, updHist }) {
  const [cfg, setCfg] = useState(loadCfg)
  const [, force] = useState(0)
  const [full, setFull] = useState(false)
  const [sigLog, setSigLog] = useState([])
  const [flash, setFlash] = useState(null)
  const [running, setRunning] = useState(false)
  const [stats, setStats] = useState({ net: 0, trades: 0, wins: 0, losses: 0 })
  const [log, setLog] = useState([])
  const [msg, setMsg] = useState('')
  const [feedErr, setFeedErr] = useState('')

  const cfgRef = useRef(cfg)
  const csRef = useRef([])
  const anRef = useRef(null)
  const baseRef = useRef(null)
  const baseKey = useRef('')
  const baseT = useRef(0)
  const view = useRef({ barW: 9, off: 0, cross: -1 })
  const raf = useRef(0)
  const audio = useRef(null)
  const flashTimer = useRef(null)
  const runRef = useRef(false)
  const netRef = useRef(0)
  const reqs = useRef({})
  const openMap = useRef({})
  const seq = useRef(1300000)
  const pollAt = useRef({})
  const rateUntil = useRef(0)
  const sendRef = useRef(send)
  const tradeOnRef = useRef(tradeOn)
  const curRef = useRef(cur)
  const helpers = useRef({})
  const feedOn = !!active || running
  cfgRef.current = cfg
  sendRef.current = send
  tradeOnRef.current = tradeOn
  curRef.current = cur
  helpers.current = { addHist, updHist }

  useEffect(() => { localStorage.bbfx_rf = JSON.stringify(cfg) }, [cfg])
  const setC = (p) => setCfg((c) => ({ ...c, ...p }))
  const addLog = (t) => setLog((l) => [t, ...l].slice(0, 12))
  const redraw = () => force((x) => x + 1)
  const cfgKey = [cfg.swing, cfg.tol, cfg.minTouch, cfg.armN, cfg.wick, cfg.hold].join('|')

  const unlock = () => {
    try {
      if (!audio.current) audio.current = new (window.AudioContext || window.webkitAudioContext)()
      audio.current.resume()
    } catch (e) { /* ignore */ }
  }
  const ring = () => {
    const ctx = audio.current
    if (ctx && cfgRef.current.sound) {
      const now = ctx.currentTime
      ;[0, 0.22, 0.44].forEach((d, i) => {
        const o = ctx.createOscillator()
        const gn = ctx.createGain()
        o.frequency.value = [880, 1175, 1568][i]
        gn.gain.setValueAtTime(0.0001, now + d)
        gn.gain.exponentialRampToValueAtTime(0.35, now + d + 0.02)
        gn.gain.exponentialRampToValueAtTime(0.0001, now + d + 0.2)
        o.connect(gn); gn.connect(ctx.destination)
        o.start(now + d); o.stop(now + d + 0.21)
      })
    }
    if (navigator.vibrate) navigator.vibrate([200, 100, 200])
  }

  // ---------- trading ----------
  const placeRF = (dir, why) => {
    const c = cfgRef.current
    if (!tradeOnRef.current) { setMsg('Log in first'); return }
    if (Date.now() < rateUntil.current) { setMsg('Deriv asked to slow down, try again in a moment'); return }
    const stake = +c.stake
    if (!(stake >= 0.35)) { setMsg('Stake must be at least 0.35'); return }
    if (netRef.current - stake <= -Math.abs(+c.sl)) {
      if (runRef.current) { runRef.current = false; setRunning(false) }
      setMsg('Stake ' + stake + ' could pass your stop loss, stopped')
      return
    }
    const mins = Math.max(1, Math.round((clamp(+c.hold || 1, 1, 20) * c.gran) / 60))
    const meta = { dir, stake, mins, sym: c.sym, why, t0: Date.now() }
    const rid = ++seq.current
    reqs.current[rid] = { kind: 'proposal', meta, t: Date.now() }
    sendRef.current({
      proposal: 1, subscribe: 1, req_id: rid, amount: stake, basis: 'stake',
      contract_type: dir === 'rise' ? 'CALL' : 'PUT', currency: curRef.current || 'USD',
      duration: mins, duration_unit: 'm', underlying_symbol: c.sym,
    })
    setMsg((dir === 'rise' ? 'RISE' : 'FALL') + ' requested · ' + mins + ' min')
  }
  const finish = (c, o) => {
    delete openMap.current[String(c.contract_id)]
    const profit = pnl(c)
    if (Number.isNaN(profit)) return
    helpers.current.updHist(c.contract_id, { status: profit >= 0 ? 'win' : 'loss', profit })
    netRef.current += profit
    setStats((st) => ({
      net: netRef.current, trades: st.trades + 1, wins: st.wins + (profit >= 0 ? 1 : 0), losses: st.losses + (profit < 0 ? 1 : 0),
    }))
    addLog((profit >= 0 ? '✅ ' : '❌ ') + MN[o.meta.sym] + ' ' + (o.meta.dir === 'rise' ? 'Rise' : 'Fall') + ' · stake ' + o.meta.stake + ' · ' + (profit >= 0 ? '+' : '') + profit.toFixed(2) + ' (' + o.meta.why + ')')
    const c2 = cfgRef.current
    if (runRef.current) {
      if (netRef.current <= -Math.abs(+c2.sl)) { runRef.current = false; setRunning(false); setMsg('Stop loss reached, auto-trade stopped') }
      else if (+c2.tp > 0 && netRef.current >= +c2.tp) { runRef.current = false; setRunning(false); setMsg('Take profit reached, auto-trade stopped') }
    }
  }
  useEffect(() => {
    const isRate = (e) => e.code === 'RateLimit' || /rate limit/i.test(e.message || '')
    const h = (m) => {
      if (m.msg_type === 'proposal_open_contract') {
        const c = m.proposal_open_contract
        if (c && isDone(c)) {
          const o = openMap.current[String(c.contract_id)]
          if (m.subscription) sendRef.current({ forget: m.subscription.id })
          if (o) finish(c, o)
        }
        return
      }
      const rid = m.req_id || (m.echo_req && m.echo_req.req_id)
      if (!rid || rid < 1300000) return
      const r = reqs.current[rid]
      if (!r) return
      if (m.error) {
        if (isRate(m.error)) { rateUntil.current = Date.now() + 5000; addLog('Deriv rate limit, slowing down'); return }
        addLog('⚠ ' + (m.error.code || '') + ' ' + m.error.message)
        setMsg(m.error.message)
        return
      }
      if (m.msg_type === 'proposal' && r.kind === 'proposal') {
        if (r.done) return
        r.done = true
        const brid = ++seq.current
        reqs.current[brid] = { kind: 'buy', meta: r.meta, subId: m.subscription && m.subscription.id, t: Date.now() }
        sendRef.current({ buy: m.proposal.id, price: Number(m.proposal.ask_price) || r.meta.stake, req_id: brid })
      } else if (m.msg_type === 'buy' && r.kind === 'buy') {
        const id = m.buy.contract_id
        openMap.current[String(id)] = { meta: r.meta, t: Date.now() }
        sendRef.current({ proposal_open_contract: 1, contract_id: id, subscribe: 1, req_id: ++seq.current })
        helpers.current.addHist({
          id, t: Date.now(), symbol: r.meta.sym, type: r.meta.dir === 'rise' ? 'Rise' : 'Fall', barrier: null,
          stake: Number(m.buy.buy_price), status: 'open',
        })
        if (r.subId) sendRef.current({ forget: r.subId })
        setMsg((r.meta.dir === 'rise' ? 'RISE' : 'FALL') + ' bought · ' + r.meta.mins + ' min')
        redraw()
      }
    }
    bus.fns.add(h)
    return () => bus.fns.delete(h)
  }, [])
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now()
      Object.entries(openMap.current).forEach(([id, o]) => {
        const age = now - o.t
        if (age > (o.meta.mins * 60 + 20) * 1000 && now - (pollAt.current[id] || 0) > 5000) {
          pollAt.current[id] = now
          sendRef.current({ proposal_open_contract: 1, contract_id: Number(id), req_id: ++seq.current })
        }
      })
    }, 5000)
    return () => clearInterval(t)
  }, [])

  // ---------- candles ----------
  const notify = (s) => {
    setSigLog((l) => [{ ...s, at: Date.now() }, ...l].slice(0, 30))
    setFlash({ dir: s.dir, kind: s.kind, price: s.price })
    clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 9000)
    ring()
    if (runRef.current && tradeOnRef.current) placeRF(s.dir, s.kind === 'engulf' ? 'engulfing' : 'kangaroo tail')
  }
  const recompute = () => {
    const cs = csRef.current
    if (cs.length < 30) { anRef.current = null; redraw(); return }
    const closed = cs.slice(0, -1)
    const key = closed[closed.length - 1].t + '|' + closed.length + '|' + cfgKey
    if (baseKey.current !== key) {
      baseKey.current = key
      baseRef.current = analyseClosed(closed, cfgRef.current)
      const lastI = closed.length - 1
      baseRef.current.sigs.filter((s) => s.i === lastI && s.t > baseT.current).forEach(notify)
    }
    anRef.current = { base: baseRef.current, live: liveStatus(baseRef.current, cs) }
    redraw()
  }
  const schedule = () => {
    if (raf.current) return
    raf.current = requestAnimationFrame(() => { raf.current = 0; recompute() })
  }
  useEffect(() => { baseKey.current = ''; schedule() }, [cfgKey])
  useEffect(() => {
    if (!feedOn) return
    let dead = false
    let retry
    let sock
    let lastMsg = Date.now()
    csRef.current = []
    anRef.current = null
    baseKey.current = ''
    baseT.current = 0
    setFeedErr('')
    const sym = cfg.sym
    const connect = () => {
      sock = new WebSocket(PUBLIC_WS)
      sock.onopen = () => {
        lastMsg = Date.now()
        sock.send(JSON.stringify({ ticks_history: sym, adjust_start_time: 1, count: 300, end: 'latest', style: 'candles', granularity: cfg.gran, subscribe: 1 }))
      }
      sock.onclose = () => { if (!dead) retry = setTimeout(connect, 2000) }
      sock.onmessage = (e) => {
        lastMsg = Date.now()
        const m = JSON.parse(e.data)
        if (m.error) { setFeedErr(m.error.message || 'Could not load candles'); return }
        if (m.msg_type === 'candles' && Array.isArray(m.candles)) {
          const arr = m.candles.map(parseC).filter(validC)
          csRef.current = arr
          if (!baseT.current && arr.length > 1) baseT.current = arr[arr.length - 2].t
          setFeedErr('')
          schedule()
        } else if (m.msg_type === 'ohlc' && m.ohlc) {
          const o = m.ohlc
          if (o.symbol && o.symbol !== sym) return
          const cd = parseC({ epoch: o.open_time, open: o.open, high: o.high, low: o.low, close: o.close })
          if (!validC(cd)) return
          const cs = csRef.current
          const last = cs[cs.length - 1]
          if (last && cd.t === last.t) cs[cs.length - 1] = cd
          else if (!last || cd.t > last.t) { cs.push(cd); if (cs.length > 600) cs.shift() }
          schedule()
        }
      }
    }
    connect()
    const stale = setInterval(() => {
      if (document.visibilityState === 'visible' && sock && sock.readyState === 1 && Date.now() - lastMsg > 45000) sock.close()
    }, 5000)
    const vis = () => { if (document.visibilityState === 'visible' && sock) sock.close() }
    document.addEventListener('visibilitychange', vis)
    return () => {
      dead = true
      clearTimeout(retry)
      clearInterval(stale)
      document.removeEventListener('visibilitychange', vis)
      if (sock) sock.close()
    }
  }, [feedOn, cfg.sym, cfg.gran])

  const startAuto = () => {
    const c = cfgRef.current
    if (!tradeOnRef.current) return setMsg('Log in first')
    if (!(+c.stake >= 0.35)) return setMsg('Stake must be at least 0.35')
    if (!(+c.sl > 0)) return setMsg('Set a stop loss above 0')
    if (!demo && !confirm('REAL account. The bot will trade every signal automatically with real money. Start?')) return
    netRef.current = 0
    setStats({ net: 0, trades: 0, wins: 0, losses: 0 })
    runRef.current = true
    setRunning(true)
    setMsg('Auto-trading new signals')
  }
  const stopAuto = () => { runRef.current = false; setRunning(false); setMsg('Auto-trade stopped') }

  // ---------- screen ----------
  const cs = csRef.current
  const an = anRef.current
  const last = cs.length ? cs[cs.length - 1] : null
  const live = an ? an.live : []
  const liveTouch = live.find((x) => x.live) || live[0]
  const bt = an ? an.base.bt : null
  const pct = bt && bt.done ? Math.round((bt.wins / bt.done) * 100) : null
  const hint = liveTouch
    ? (liveTouch.dir === 'down' ? 'Touching resistance ' : 'Touching support ') + liveTouch.z.mid.toFixed(2) +
      ' · waiting for a ' + (liveTouch.dir === 'down' ? 'bearish' : 'bullish') + ' engulfing or kangaroo tail'
    : 'No zone touched yet · watching'
  const tools = (
    <div className="rf-tools">
      <select value={cfg.sym} onChange={(e) => setC({ sym: e.target.value })}>
        {MKTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <div className="rf-tf">
        {TFS.map(([g, l]) => <button key={g} className={cfg.gran === g ? 'on' : ''} onClick={() => setC({ gran: g })}>{l}</button>)}
      </div>
      <div className="rf-tg">
        {[['zones', 'Zones'], ['zig', 'Zigzag'], ['hl', 'High/Low'], ['pats', 'Patterns'], ['rt', 'Retest']].map(([k, l]) => (
          <button key={k} className={cfg[k] ? 'on' : ''} onClick={() => setC({ [k]: !cfg[k] })}>{l}</button>
        ))}
      </div>
    </div>
  )
  const chart = <RfChart cs={cs} an={an} cfg={cfg} view={view.current} onView={redraw} />
  const banner = flash && (
    <div className={'rf-flash ' + flash.dir}>
      <b>{flash.dir === 'rise' ? '▲ RISE SIGNAL' : '▼ FALL SIGNAL'}</b>
      <span>{flash.kind === 'engulf' ? 'Engulfing' : 'Kangaroo tail'} at {flash.price.toFixed(2)}</span>
    </div>
  )
  const buttons = (
    <div className="rf-buy">
      <button className="rise" onClick={() => placeRF('rise', 'manual')}>▲ RISE</button>
      <button className="fall" onClick={() => placeRF('fall', 'manual')}>▼ FALL</button>
    </div>
  )

  return (
    <div className="rf" onPointerDown={unlock}>
      <section className="rf-hero">
        <div>
          <div className="rf-eye">RISE / FALL · CANDLE ANALYST</div>
          <div className="rf-title">{MN[cfg.sym]} <small>{(TFS.find((x) => x[0] === cfg.gran) || [0, ''])[1]}</small></div>
          <div className="rf-price">{last ? last.c.toFixed(clamp(3 - Math.floor(Math.log10(Math.max(1e-9, last.h - last.l || 1))), 2, 5)) : '…'}</div>
        </div>
        <div className="rf-st">
          <span className={'rf-chip ' + (liveTouch ? (liveTouch.dir === 'down' ? 'bear' : 'bull') : '')}>
            {liveTouch ? (liveTouch.dir === 'down' ? 'AT RESISTANCE' : 'AT SUPPORT') : 'SCANNING'}
          </span>
          <span className="rf-chip">{an ? an.base.zones.length + ' zones' : '…'}</span>
        </div>
      </section>

      <section className="card rf-chartcard">
        {tools}
        <div className="rf-chartbox">
          {chart}
          {banner}
          <div className="rf-fab">
            <button onClick={() => { view.current.off = 0; redraw() }} aria-label="Latest">⏭</button>
            <button onClick={() => setFull(true)} aria-label="Full screen">⤢</button>
          </div>
        </div>
        {feedErr && <div className="muted">⚠ {feedErr}</div>}
        <div className="rf-legend">
          <span className="r">Resistance</span><span className="s">Support</span><span className="t">Retest RT</span>
          <span className="z">Zigzag HH/HL/LH/LL</span><span className="e">E engulfing</span><span className="k">K kangaroo tail</span>
        </div>
        <div className="muted left">{hint}. Drag to move, pinch to zoom, tap a candle for its prices.</div>
      </section>

      <section className="card">
        <div className="sech"><b>SIGNALS</b><span className="sub">fired on closed candles only</span></div>
        {sigLog.length ? sigLog.slice(0, 6).map((s, i) => (
          <div className={'rf-sig ' + s.dir} key={s.t + s.dir + i}>
            <b>{s.dir === 'rise' ? '▲ RISE' : '▼ FALL'}</b>
            <span>{s.kind === 'engulf' ? 'Engulfing' : 'Kangaroo tail'} · {MN[cfg.sym]} · {s.price.toFixed(2)}</span>
            <small>{new Date(s.at).toLocaleTimeString()}</small>
          </div>
        )) : <div className="muted">No new signal yet. Alerts appear here when a candle touches a zone and a reversal candle closes.</div>}
        {bt && (
          <div className="rf-bt">
            <b>Backtest on the {bt.bars} loaded candles</b>
            <div>{bt.n} signals · after {bt.hold} candle{bt.hold > 1 ? 's' : ''}: {bt.wins} of {bt.done} moved the right way{pct !== null ? ' (' + pct + '%)' : ''}</div>
            <small>Rise/Fall pays about 90 to 95% of the stake on a win, so it needs roughly 52 to 53% to break even. Volatility indices are random, so expect close to 50%.</small>
          </div>
        )}
      </section>

      <section className="card">
        <div className="sech"><b>TRADE</b><span className="sub">one-tap Rise or Fall</span></div>
        {buttons}
        <div className="row">
          <label>Stake
            <input type="number" min="0.35" step="0.05" value={cfg.stake} onChange={(e) => setC({ stake: e.target.value })} />
          </label>
          <label>Hold for (candles)
            <input type="number" min="1" max="20" value={cfg.hold} onChange={(e) => setC({ hold: e.target.value })} />
          </label>
        </div>
        <div className="row">
          <label>Stop loss
            <input type="number" min="0" step="0.5" disabled={running} value={cfg.sl} onChange={(e) => setC({ sl: e.target.value })} />
          </label>
          <label>Take profit (0 = off)
            <input type="number" min="0" step="0.5" disabled={running} value={cfg.tp} onChange={(e) => setC({ tp: e.target.value })} />
          </label>
        </div>
        <button className={'buy ' + (running ? 'odd' : 'even')} onClick={running ? stopAuto : startAuto}>
          {running ? 'STOP AUTO-TRADE' : 'START AUTO-TRADE ON SIGNALS'}
        </button>
        {msg && <div className="muted">{msg}</div>}
        <div className="sum">
          <div><small>Net P/L</small><b className={stats.net >= 0 ? 'win' : 'loss'}>{stats.net >= 0 ? '+' : ''}{stats.net.toFixed(2)}</b></div>
          <div><small>Win / Loss</small><b>{stats.wins} / {stats.losses}</b></div>
          <div><small>Open</small><b>{Object.keys(openMap.current).length}</b></div>
        </div>
        <div className="muted">A trade lasts {Math.max(1, Math.round((clamp(+cfg.hold || 1, 1, 20) * cfg.gran) / 60))} min. Auto-trade places one trade per new signal. Try it on DEMO first.</div>
      </section>

      <section className="card">
        <div className="sech"><b>ANALYSIS SETTINGS</b></div>
        <div className="row">
          <label>Swing strength (candles each side)
            <input type="number" min="2" max="8" value={cfg.swing} onChange={(e) => setC({ swing: e.target.value })} />
          </label>
          <label>Zone thickness (× ATR)
            <input type="number" min="0.15" max="2" step="0.05" value={cfg.tol} onChange={(e) => setC({ tol: e.target.value })} />
          </label>
        </div>
        <div className="row">
          <label>Touches to make a zone
            <input type="number" min="2" max="5" value={cfg.minTouch} onChange={(e) => setC({ minTouch: e.target.value })} />
          </label>
          <label>Reversal window (candles)
            <input type="number" min="1" max="8" value={cfg.armN} onChange={(e) => setC({ armN: e.target.value })} />
          </label>
        </div>
        <div className="row">
          <label>Kangaroo tail wick ÷ body
            <input type="number" min="1.2" max="6" step="0.1" value={cfg.wick} onChange={(e) => setC({ wick: e.target.value })} />
          </label>
          <label>Sound and vibration
            <select value={cfg.sound ? 'on' : 'off'} onChange={(e) => setC({ sound: e.target.value === 'on' })}>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </label>
        </div>
        <div className="muted left">A zone is a cluster of swing highs or lows. When a candle touches one, the bot waits up to the reversal window for an engulfing candle or kangaroo tail pointing away from it, then signals on that candle's close.</div>
      </section>

      {log.length > 0 && (
        <section className="card">
          <div className="muted">Trade activity</div>
          {log.map((l, i) => <div className="log" key={i}>{l}</div>)}
        </section>
      )}

      {full && (
        <div className="rf-full">
          <div className="rf-ftop">
            {tools}
            <div className="rf-frow">
              <span className={'rf-chip ' + (liveTouch ? (liveTouch.dir === 'down' ? 'bear' : 'bull') : '')}>{hint}</span>
              <button className="rf-min" onClick={() => setFull(false)}>⤡ Minimise</button>
            </div>
          </div>
          <div className="rf-fchart">
            {chart}
            {banner}
            <div className="rf-fab">
              <button onClick={() => { view.current.off = 0; redraw() }} aria-label="Latest">⏭</button>
            </div>
          </div>
          <div className="rf-fbar">{buttons}</div>
        </div>
      )}
    </div>
  )
}
