import { useEffect, useRef, useState } from 'react'
import { bus } from './bus.js'

const PUBLIC_WS = 'wss://api.derivws.com/trading/v1/options/ws/public'
const SYMS = [
  ['R_10', 'Volatility 10'], ['R_25', 'Volatility 25'], ['R_50', 'Volatility 50'],
  ['R_75', 'Volatility 75'], ['R_100', 'Volatility 100'],
  ['1HZ10V', 'Vol 10 (1s)'], ['1HZ25V', 'Vol 25 (1s)'], ['1HZ50V', 'Vol 50 (1s)'],
  ['1HZ75V', 'Vol 75 (1s)'], ['1HZ100V', 'Vol 100 (1s)'],
]
const SYMN = Object.fromEntries(SYMS)
const SHORT = {
  R_10: 'V10', R_25: 'V25', R_50: 'V50', R_75: 'V75', R_100: 'V100',
  '1HZ10V': 'V10·1s', '1HZ25V': 'V25·1s', '1HZ50V': 'V50·1s', '1HZ75V': 'V75·1s', '1HZ100V': 'V100·1s',
}
const ALL = SYMS.map((x) => x[0])
const D10 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const TN = {
  DIGITMATCH: 'Matches', DIGITDIFF: 'Differs', DIGITOVER: 'Over',
  DIGITUNDER: 'Under', DIGITEVEN: 'Even', DIGITODD: 'Odd',
}
const hasB = (t) => t === 'DIGITMATCH' || t === 'DIGITDIFF' || t === 'DIGITOVER' || t === 'DIGITUNDER'
const winOf = (type, d, b) =>
  type === 'DIGITMATCH' ? d === b
  : type === 'DIGITDIFF' ? d !== b
  : type === 'DIGITOVER' ? d > b
  : type === 'DIGITUNDER' ? d < b
  : type === 'DIGITEVEN' ? d % 2 === 0
  : d % 2 === 1
const nameOf = (c) => TN[c.type] + (c.barrier !== null && c.barrier !== undefined ? ' ' + c.barrier : '')

const DEF = {
  fam: 'md', kind: 'both', mkt: 'any', digit: 'any', model: 'ens', win: 1000,
  auto: false, stake: 1, dur: 1, minEdge: 1, zmode: 'normal', cool: 8, sl: 10, tp: 10, instant: true,
}
const loadCfg = () => {
  try { return { ...DEF, ...JSON.parse(localStorage.bbfx_scanner || '{}') } } catch (e) { return DEF }
}
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

// ---------- statistics ----------
const gammln = (x) => {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]
  let y = x
  let tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let ser = 1.000000000190015
  for (let j = 0; j < 6; j++) { y += 1; ser += c[j] / y }
  return -tmp + Math.log((2.5066282746310005 * ser) / x)
}
const gser = (a, x) => {
  let ap = a
  let del = 1 / a
  let sum = del
  for (let n = 0; n < 200; n++) {
    ap += 1
    del *= x / ap
    sum += del
    if (Math.abs(del) < Math.abs(sum) * 1e-10) break
  }
  return sum * Math.exp(-x + a * Math.log(x) - gammln(a))
}
const gcf = (a, x) => {
  let b = x + 1 - a
  let c = 1 / 1e-30
  let d = 1 / b
  let h = d
  for (let i = 1; i <= 200; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < 1e-30) d = 1e-30
    c = b + an / c
    if (Math.abs(c) < 1e-30) c = 1e-30
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-10) break
  }
  return Math.exp(-x + a * Math.log(x) - gammln(a)) * h
}
const chiP = (chi2, df) => {
  if (!(chi2 > 0)) return 1
  const a = df / 2
  const x = chi2 / 2
  return x < a + 1 ? 1 - gser(a, x) : gcf(a, x)
}
const invNorm = (p) => {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01]
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
  const pl = 0.02425
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  const q = p - 0.5
  const r = q * q
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

// one market: shares, three next-digit estimators, tests, and every candidate contract
const analyseMarket = (w, c) => {
  const n = w.length
  const cnt = Array(10).fill(0)
  w.forEach((d) => { cnt[d] += 1 })
  const M = Math.min(100, n)
  const cr = Array(10).fill(0)
  for (let i = n - M; i < n; i++) cr[w[i]] += 1
  const L = w[n - 1]
  const tr = Array(10).fill(0)
  let m = 0
  const tab = Array.from({ length: 10 }, () => Array(10).fill(0))
  for (let i = 0; i < n - 1; i++) {
    tab[w[i]][w[i + 1]] += 1
    if (w[i] === L) { tr[w[i + 1]] += 1; m += 1 }
  }
  const sh = (a, tot, K) => a.map((x) => (x + 0.1 * K) / (tot + K))
  const p1 = sh(cnt, n, 200)
  const p2 = sh(cr, M, 50)
  const p3 = sh(tr, m, 100)
  const p = c.model === 'freq' ? p1 : c.model === 'recent' ? p2 : c.model === 'markov' ? p3
    : p1.map((x, i) => 0.5 * x + 0.2 * p2[i] + 0.3 * p3[i])
  const share = cnt.map((x) => x / n)
  const zd = cnt.map((x) => (x - n * 0.1) / Math.sqrt(n * 0.09))
  let chi = 0
  cnt.forEach((x) => { chi += ((x - n / 10) ** 2) / (n / 10) })
  const chiPv = chiP(chi, 9)
  let mkP = null
  if (n >= 1000) {
    const row = tab.map((r) => r.reduce((a, b) => a + b, 0))
    const col = Array(10).fill(0)
    tab.forEach((r) => r.forEach((x, j) => { col[j] += x }))
    const tot = n - 1
    let c2 = 0
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 10; j++) {
        const e = (row[i] * col[j]) / tot
        if (e > 0) c2 += ((tab[i][j] - e) ** 2) / e
      }
    }
    mkP = chiP(c2, 81)
  }
  const cands = []
  const useM = c.model === 'markov'
  const trials = useM ? m : n
  const obsArr = useM ? tr : cnt
  const add = (type, barrier, set, base) => {
    const est = set.reduce((a, d) => a + p[d], 0)
    const obs = set.reduce((a, d) => a + obsArr[d], 0)
    const z = trials > 0 ? (obs - trials * base) / Math.sqrt(trials * base * (1 - base)) : 0
    cands.push({ type, barrier, est, base, edge: (est - base) * 100, z })
  }
  const dsel = c.digit === 'any' ? null : +c.digit
  if (c.fam === 'md') {
    D10.forEach((d) => {
      if (dsel !== null && d !== dsel) return
      if (c.kind !== 'differs') add('DIGITMATCH', d, [d], 0.1)
      if (c.kind !== 'matches') add('DIGITDIFF', d, D10.filter((x) => x !== d), 0.9)
    })
  } else if (c.fam === 'ou') {
    for (let b = 0; b <= 9; b++) {
      if (dsel !== null && b !== dsel) continue
      if (b <= 8 && c.kind !== 'under') add('DIGITOVER', b, D10.filter((x) => x > b), (9 - b) / 10)
      if (b >= 1 && c.kind !== 'over') add('DIGITUNDER', b, D10.filter((x) => x < b), b / 10)
    }
  } else {
    if (c.kind !== 'odd') add('DIGITEVEN', null, [0, 2, 4, 6, 8], 0.5)
    if (c.kind !== 'even') add('DIGITODD', null, [1, 3, 5, 7, 9], 0.5)
  }
  return { n, cnt, share, zd, p, chi, chiPv, mkP, cands, last: L }
}

export default function Scanner({ active, tradeOn, send, cur, demo, addHist, updHist }) {
  const [cfg, setCfg] = useState(loadCfg)
  const [running, setRunning] = useState(false)
  const [stats, setStats] = useState({ net: 0, trades: 0, wins: 0, losses: 0 })
  const [log, setLog] = useState([])
  const [msg, setMsg] = useState('')
  const [watch, setWatch] = useState('')
  const [an, setAn] = useState(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [, force] = useState(0)

  const cfgRef = useRef(cfg)
  const runRef = useRef(false)
  const netRef = useRef(0)
  const errs = useRef(0)
  const digs = useRef({})
  const pip = useRef({})
  const reqs = useRef({})
  const pend = useRef(new Set())
  const openMap = useRef({})
  const seq = useRef(1100000)
  const raf = useRef(0)
  const holds = useRef(0)
  const tickAt = useRef({})
  const paused = useRef(false)
  const pauseTimer = useRef(null)
  const pollAt = useRef({})
  const settled = useRef({})
  const tb = useRef({})
  const lastEp = useRef({})
  const lastTradeAt = useRef(0)
  const rateUntil = useRef(0)
  const sendRef = useRef(send)
  const tradeOnRef = useRef(tradeOn)
  const curRef = useRef(cur)
  const helpers = useRef({})
  const feedOn = !!active || running
  const winN = clamp(Math.round(+cfg.win || 1000), 200, 5000)
  const monSyms = cfg.mkt === 'any' ? ALL : [cfg.mkt]
  cfgRef.current = cfg
  sendRef.current = send
  tradeOnRef.current = tradeOn
  curRef.current = cur
  helpers.current = { addHist, updHist }

  useEffect(() => { localStorage.bbfx_scanner = JSON.stringify(cfg) }, [cfg])
  const setC = (p) => setCfg((c) => ({ ...c, ...p }))
  const setFam = (fam) => setC({ fam, kind: 'both', digit: 'any' })
  const addLog = (t) => setLog((l) => [t, ...l].slice(0, 14))
  const bump = () => {
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      force((x) => x + 1)
    })
  }
  const slots = () => Object.keys(openMap.current).length + pend.current.size + holds.current
  const forget = (id) => { if (id) sendRef.current({ forget: id }) }

  const stopBot = (why) => {
    paused.current = false
    clearTimeout(pauseTimer.current)
    runRef.current = false
    setRunning(false)
    pend.current.clear()
    setMsg(why ? '■ ' + why : 'Stopped')
    if (why) addLog('■ ' + why)
  }

  // ---------- trading ----------
  const slow = (meta, retried) => {
    const rid = ++seq.current
    reqs.current[rid] = { kind: 'proposal', meta, retried, t: Date.now() }
    pend.current.add(rid)
    const p = {
      proposal: 1, subscribe: 1, req_id: rid, amount: meta.stake, basis: 'stake',
      contract_type: meta.type, currency: curRef.current || 'USD', duration: meta.dur,
      duration_unit: 't', underlying_symbol: meta.sym,
    }
    if (hasB(meta.type)) p.barrier = String(meta.barrier)
    sendRef.current(p)
  }
  const placeTrade = (cand) => {
    const c = cfgRef.current
    const stake = +c.stake
    if (netRef.current - stake <= -Math.abs(+c.sl)) {
      stopBot('Stake ' + stake + ' could pass your stop loss, stopped')
      return
    }
    const meta = {
      sym: cand.sym, stake, type: cand.type, barrier: hasB(cand.type) ? cand.barrier : null,
      dur: +c.dur || 1, tag: 'SC',
    }
    meta.t0 = Date.now()
    meta.trig = 'est ' + (cand.est * 100).toFixed(1) + '% z ' + cand.z.toFixed(1)
    lastTradeAt.current = Date.now()
    slow(meta, false)
  }

  const finish = (c, o, prov) => {
    const cid = String(c.contract_id)
    delete openMap.current[cid]
    const profit = pnl(c)
    if (Number.isNaN(profit)) return
    if (prov) settled.current[cid] = { meta: o.meta, profit, win: profit >= 0, t: Date.now() }
    const ex = prov ? c.exit_digit
      : typeof c.exit_tick_display_value === 'string' ? +c.exit_tick_display_value.slice(-1) : NaN
    helpers.current.updHist(c.contract_id, {
      status: profit >= 0 ? 'win' : 'loss', profit, exit: Number.isNaN(ex) ? undefined : ex,
    })
    netRef.current += profit
    setStats((st) => ({
      net: netRef.current, trades: st.trades + 1, wins: st.wins + (profit >= 0 ? 1 : 0),
      losses: st.losses + (profit < 0 ? 1 : 0),
    }))
    addLog(
      (profit >= 0 ? '✅ ' : '❌ ') + SYMN[o.meta.sym] + ' ' + nameOf(o.meta) + ' · stake ' + o.meta.stake +
      (o.meta.trig ? ' · ' + o.meta.trig : '') + (ex == null || Number.isNaN(ex) ? '' : ' · exit ' + ex) +
      (o.lat != null ? ' · ' + o.lat + 'ms' : '') + ' · ' + (profit >= 0 ? '+' : '') + profit.toFixed(2)
    )
    if (!runRef.current) return
    const c2 = cfgRef.current
    if (netRef.current <= -Math.abs(+c2.sl)) return stopBot('Stop loss reached')
    if (+c2.tp > 0 && netRef.current >= +c2.tp) return stopBot('Take profit reached')
  }

  // ---------- instant results from the tick feed ----------
  const tryTick = (o, id, ep, d) => {
    if (cfgRef.current.instant === false) return
    if (o.noProv || !o.pt || !(o.payout > 0) || !(o.cost > 0)) return
    if (!(Number(ep) > o.pt)) return
    if (o.seen === 0 && Number(ep) - o.pt > 6) { o.noProv = true; return }
    o.seen += 1
    if (o.seen < (o.meta.dur || 1)) return
    const win = winOf(o.meta.type, d, o.meta.barrier)
    finish({ contract_id: id, profit: win ? o.payout - o.cost : -o.cost, exit_digit: d }, o, true)
  }
  const settleByTick = (sym, ep, d) => {
    const now = Date.now()
    Object.keys(settled.current).forEach((k) => { if (now - settled.current[k].t > 120000) delete settled.current[k] })
    const buf = (tb.current[sym] = (tb.current[sym] || []).slice(-12))
    buf.push({ ep: Number(ep), d })
    Object.keys(openMap.current).forEach((id) => {
      const o = openMap.current[id]
      if (!o || o.meta.sym !== sym) return
      tryTick(o, id, ep, d)
    })
  }
  const replayTicks = (id) => {
    const o = openMap.current[id]
    if (!o) return
    const buf = (tb.current[o.meta.sym] || []).slice()
    for (let i = 0; i < buf.length; i++) {
      if (!openMap.current[id]) return
      tryTick(o, id, buf[i].ep, buf[i].d)
    }
  }
  const reconcile = (c) => {
    const id = String(c.contract_id)
    const sm = settled.current[id]
    if (!sm) return
    delete settled.current[id]
    const real = pnl(c)
    if (Number.isNaN(real)) return
    const flip = (real >= 0) !== sm.win
    const ex = typeof c.exit_tick_display_value === 'string' ? +c.exit_tick_display_value.slice(-1) : NaN
    netRef.current += real - sm.profit
    helpers.current.updHist(id, {
      status: real >= 0 ? 'win' : 'loss', profit: real, exit: Number.isNaN(ex) ? undefined : ex,
    })
    setStats((st) => ({
      ...st,
      net: netRef.current,
      wins: st.wins + (flip ? (real >= 0 ? 1 : -1) : 0),
      losses: st.losses + (flip ? (real >= 0 ? -1 : 1) : 0),
    }))
    if (flip) addLog('⚠ Deriv corrected ' + SYMN[sm.meta.sym] + ' ' + nameOf(sm.meta) + ' to ' + (real >= 0 ? 'WIN ' : 'LOSS ') + real.toFixed(2))
    if (!runRef.current) return
    const c2 = cfgRef.current
    if (netRef.current <= -Math.abs(+c2.sl)) stopBot('Stop loss reached')
    else if (+c2.tp > 0 && netRef.current >= +c2.tp) stopBot('Take profit reached')
  }

  // ---------- messages from the trading socket ----------
  useEffect(() => {
    const already = (e) => e.code === 'AlreadySubscribed' || /already subscribed/i.test(e.message || '')
    const isRate = (e) => e.code === 'RateLimit' || /rate limit/i.test(e.message || '')
    const h = (m) => {
      if (m.msg_type === 'proposal_open_contract') {
        const c = m.proposal_open_contract
        if (c && isDone(c)) {
          const cid = String(c.contract_id)
          const o = openMap.current[cid]
          if (m.subscription) forget(m.subscription.id)
          if (o) finish(c, o)
          else if (settled.current[cid]) reconcile(c)
        }
        return
      }
      const rid = m.req_id || (m.echo_req && m.echo_req.req_id)
      if (!rid || rid < 1100000) return
      const r = reqs.current[rid]
      if (!r) return
      if (m.error) {
        pend.current.delete(rid)
        if (isRate(m.error)) {
          if (Date.now() > rateUntil.current) addLog('Deriv rate limit, slowing down for a few seconds')
          rateUntil.current = Date.now() + 5000
          return
        }
        if (r.kind === 'proposal' && already(m.error) && (r.meta.tries || 0) < 4) {
          holds.current += 1
          r.meta.tries = (r.meta.tries || 0) + 1
          setTimeout(() => {
            holds.current -= 1
            if (runRef.current) slow(r.meta, r.retried)
          }, 450)
          return
        }
        addLog('⚠ ' + (m.error.code || '') + ' ' + m.error.message)
        errs.current += 1
        if (errs.current >= 3) stopBot('Stopped after repeated errors')
        return
      }
      if (m.msg_type === 'proposal' && r.kind === 'proposal') {
        if (r.done) return
        r.done = true
        pend.current.delete(rid)
        const brid = ++seq.current
        reqs.current[brid] = { kind: 'buy', meta: r.meta, subId: m.subscription && m.subscription.id, t: Date.now() }
        pend.current.add(brid)
        sendRef.current({ buy: m.proposal.id, price: Number(m.proposal.ask_price) || r.meta.stake, req_id: brid })
      } else if (m.msg_type === 'buy' && r.kind === 'buy') {
        pend.current.delete(rid)
        errs.current = 0
        const id = m.buy.contract_id
        openMap.current[String(id)] = {
          meta: r.meta, t: Date.now(), pt: Number(m.buy.purchase_time) || 0, seen: 0,
          lat: Date.now() - (r.meta.t0 || Date.now()),
          payout: Number(m.buy.payout), cost: Number(m.buy.buy_price),
        }
        sendRef.current({ proposal_open_contract: 1, contract_id: id, subscribe: 1, req_id: ++seq.current })
        helpers.current.addHist({
          id, t: Date.now(), symbol: r.meta.sym, type: r.meta.type, barrier: r.meta.barrier,
          stake: Number(m.buy.buy_price), status: 'open',
        })
        forget(r.subId)
        replayTicks(String(id))
        bump()
      }
    }
    bus.fns.add(h)
    return () => bus.fns.delete(h)
  }, [])

  // ---------- watchdog ----------
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => {
      const now = Date.now()
      pend.current.forEach((rid) => {
        const r = reqs.current[rid]
        if (!r || now - r.t > 8000) {
          pend.current.delete(rid)
          addLog('No reply to a trade request, skipped')
        }
      })
      Object.entries(openMap.current).forEach(([id, o]) => {
        const age = now - o.t
        const expect = ((o.meta.dur || 1) * 2.5 + 5) * 1000
        if (age > expect && now - (pollAt.current[id] || 0) > 3000 && !paused.current) {
          pollAt.current[id] = now
          sendRef.current({ proposal_open_contract: 1, contract_id: Number(id), req_id: ++seq.current })
        }
        if (age > 90000) {
          delete openMap.current[id]
          stopBot('No result received for a trade, stopped for safety')
        }
      })
    }, 2000)
    return () => clearInterval(t)
  }, [running])

  // ---------- tick feed (only while the tab is open or the bot is running) ----------
  useEffect(() => {
    if (!feedOn) return
    const syms = monSyms
    if (!syms.length) return
    let dead = false
    let retry
    let sock
    const connect = () => {
      sock = new WebSocket(PUBLIC_WS)
      const subd = new Set()
      const sub = (sym) => {
        if (subd.has(sym) || sock.readyState !== 1) return
        subd.add(sym)
        sock.send(JSON.stringify({ ticks: sym, subscribe: 1 }))
      }
      sock.onopen = () => {
        tickAt.current = { __open: Date.now() }
        lastEp.current = {}
        tb.current = {}
        digs.current = {}
        syms.forEach((sym) => {
          sock.send(JSON.stringify({ ticks_history: sym, count: winN, end: 'latest', style: 'ticks' }))
          setTimeout(() => sub(sym), 4000)
        })
      }
      sock.onclose = () => { if (!dead) retry = setTimeout(connect, 2000) }
      sock.onmessage = (e) => {
        const m = JSON.parse(e.data)
        if (m.msg_type === 'history') {
          const sym = m.echo_req && m.echo_req.ticks_history
          if (!sym) return
          const hh = m.history || {}
          const pp = m.pip_size ?? hh.pip_size ?? pip.current[sym] ?? 2
          pip.current[sym] = pp
          digs.current[sym] = (hh.prices || []).map((p) => +Number(p).toFixed(pp).slice(-1)).slice(-winN)
          sub(sym)
          return
        }
        if (m.error) {
          const sym = m.echo_req && m.echo_req.ticks_history
          if (sym) sub(sym)
          return
        }
        if (m.msg_type === 'tick') {
          const t = m.tick
          const sym = t.symbol ?? t.underlying_symbol ?? (m.echo_req && m.echo_req.ticks)
          if (!sym) return
          const ep0 = Number(t.epoch)
          if (ep0 && lastEp.current[sym] && ep0 <= lastEp.current[sym]) return
          if (ep0) lastEp.current[sym] = ep0
          pip.current[sym] = t.pip_size
          const d = +t.quote.toFixed(t.pip_size).slice(-1)
          digs.current[sym] = [...(digs.current[sym] || []).slice(-(winN - 1)), d]
          tickAt.current[sym] = Date.now()
          settleByTick(sym, t.epoch, d)
        }
      }
    }
    connect()
    const stale = setInterval(() => {
      if (document.visibilityState !== 'visible' || !sock || sock.readyState !== 1) return
      const now = Date.now()
      const opened = tickAt.current.__open || now
      if (syms.some((sym) => now - (tickAt.current[sym] || opened) > 12000)) {
        addLog('Tick feed stalled, reconnecting')
        sock.close()
      }
    }, 3000)
    const vis = () => { if (document.visibilityState === 'visible' && sock) sock.close() }
    document.addEventListener('visibilitychange', vis)
    return () => {
      dead = true
      clearTimeout(retry)
      clearInterval(stale)
      document.removeEventListener('visibilitychange', vis)
      if (sock) sock.close()
    }
  }, [feedOn, monSyms.join(','), winN])

  // ---------- the scan: once a second ----------
  useEffect(() => {
    if (!feedOn) return
    const scan = () => {
      const c = cfgRef.current
      const N = clamp(Math.round(+c.win || 1000), 200, 5000)
      const syms = c.mkt === 'any' ? ALL : [c.mkt]
      const per = {}
      const cands = []
      syms.forEach((sym) => {
        const a = digs.current[sym] || []
        if (a.length < Math.min(150, N)) { per[sym] = null; return }
        const mres = analyseMarket(a.slice(-N), c)
        per[sym] = mres
        mres.cands.forEach((cd) => cands.push({ ...cd, sym }))
      })
      cands.sort((x, y) => y.edge - x.edge)
      const nT = Math.max(1, cands.length)
      const res = {
        per, cands: cands.slice(0, 6), best: cands[0] || null, nT,
        zc: invNorm(1 - 0.025 / nT), ts: Date.now(),
        ready: Object.values(per).filter(Boolean).length, total: syms.length,
      }
      setAn(res)
      // auto trade
      const best = res.best
      if (!best || !runRef.current || !c.auto || !tradeOnRef.current || paused.current) return
      if (slots() >= 1) return
      if (Date.now() < rateUntil.current) return
      if (Date.now() - lastTradeAt.current < Math.max(1, +c.cool || 1) * 1000) return
      if (!(best.edge >= +c.minEdge)) return
      const zok = c.zmode === 'loose' ? true : c.zmode === 'strict' ? best.z >= res.zc : best.z >= 2
      if (!zok) return
      if (Date.now() - (tickAt.current[best.sym] || 0) > 6000) return
      placeTrade(best)
    }
    scan()
    const t = setInterval(scan, 1000)
    return () => clearInterval(t)
  }, [feedOn])

  // pause when the trading connection drops, resume by itself
  useEffect(() => {
    if (!runRef.current) return
    if (!tradeOn) {
      paused.current = true
      pend.current.clear()
      setMsg('Connection lost, reconnecting… the bot resumes by itself')
      addLog('Connection lost, waiting to reconnect')
      pauseTimer.current = setTimeout(() => {
        if (runRef.current && paused.current) stopBot('Could not reconnect in 60 seconds, bot stopped')
      }, 60000)
    } else if (paused.current) {
      paused.current = false
      clearTimeout(pauseTimer.current)
      setMsg('Running')
      addLog('Reconnected, resuming')
    }
  }, [tradeOn])

  useEffect(() => {
    if (!running) return
    let lock
    const get = () => {
      if (navigator.wakeLock) navigator.wakeLock.request('screen').then((l) => { lock = l }).catch(() => {})
    }
    get()
    const v = () => { if (document.visibilityState === 'visible') get() }
    document.addEventListener('visibilitychange', v)
    return () => {
      document.removeEventListener('visibilitychange', v)
      if (lock && lock.release) lock.release()
    }
  }, [running])

  const start = () => {
    const c = cfgRef.current
    if (!tradeOnRef.current) return setMsg('Log in first')
    if (!c.auto) return setMsg('Turn Auto-trade on first')
    if (!(+c.stake >= 0.35)) return setMsg('Stake must be at least 0.35')
    if (!(+c.sl > 0)) return setMsg('Set a stop loss above 0')
    if (!demo && !confirm('REAL account. The scanner will place trades automatically with real money. Start?')) return
    netRef.current = 0
    errs.current = 0
    pend.current.clear()
    lastTradeAt.current = 0
    setStats({ net: 0, trades: 0, wins: 0, losses: 0 })
    paused.current = false
    runRef.current = true
    setRunning(true)
    setMsg('Scanning and trading automatically')
  }

  // ---------- numbers for the screen ----------
  const best = an && an.best
  const wsym = (watch && an && an.per[watch]) ? watch : (best ? best.sym : monSyms[0])
  const wm = an && an.per[wsym]
  const verdict = !best ? null : best.z >= an.zc ? 'hot' : best.z >= 2 ? 'warn' : 'ok'
  const CIRC = 2 * Math.PI * 54
  const winPct = best ? best.est * 100 : 0
  const famName = cfg.fam === 'md' ? 'Matches / Differs' : cfg.fam === 'ou' ? 'Over / Under' : 'Even / Odd'
  const kindOpts = cfg.fam === 'md'
    ? [['both', 'Both'], ['matches', 'Matches'], ['differs', 'Differs']]
    : cfg.fam === 'ou' ? [['both', 'Both'], ['over', 'Over'], ['under', 'Under']]
    : [['both', 'Both'], ['even', 'Even'], ['odd', 'Odd']]
  const cell = (z) => {
    const a = Math.min(Math.abs(z) / 3, 1) * 0.85
    return z >= 0 ? 'rgba(255,170,60,' + (0.12 + a) + ')' : 'rgba(70,140,255,' + (0.12 + a) + ')'
  }
  const ageS = an ? Math.max(0, Math.round((Date.now() - an.ts) / 1000)) : 0

  return (
    <div className="msc">
      <section className="msc-hero">
        <svg className="gauge" viewBox="0 0 132 132">
          <defs>
            <linearGradient id="mscg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#19ff7a" />
              <stop offset="1" stopColor="#3aa0ff" />
            </linearGradient>
          </defs>
          <circle className="trk" cx="66" cy="66" r="54" />
          <circle className="val" cx="66" cy="66" r="54" strokeDasharray={(best ? (winPct / 100) * CIRC : 0) + ' ' + CIRC} />
          <text x="66" y="64" className="g1">{best ? winPct.toFixed(1) + '%' : '…'}</text>
          <text x="66" y="84" className="g2">{best ? 'est. win' : 'loading'}</text>
        </svg>
        <div className="hbody">
          <div className="eyebrow">MATRIX SCANNER · {famName}</div>
          {best ? (
            <>
              <div className="hname">{SYMN[best.sym]}</div>
              <div className="hbet">{nameOf(best)}</div>
              <div className="hrow">
                <span className="chip">baseline {(best.base * 100).toFixed(0)}%</span>
                <span className="chip">{best.edge >= 0 ? '+' : ''}{best.edge.toFixed(2)} pts</span>
                <span className="chip">z {best.z.toFixed(2)}</span>
              </div>
              <div className="hrow">
                <span className={'chip ' + verdict}>
                  {verdict === 'hot' ? 'Unusual: beyond chance' : verdict === 'warn' ? 'Mild: still within chance' : 'Within chance'}
                </span>
              </div>
            </>
          ) : (
            <div className="hname">Loading ticks…</div>
          )}
          <div className="hfoot">
            {an ? an.ready + '/' + an.total + ' markets · ' + winN + ' ticks each · updated ' + ageS + 's ago' : 'connecting'}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="seg">
          {[['md', 'Matches / Differs'], ['ou', 'Over / Under'], ['eo', 'Even / Odd']].map(([v, l]) => (
            <button key={v} className={cfg.fam === v ? 'on' : ''} onClick={() => setFam(v)}>{l}</button>
          ))}
        </div>
        <div className="row">
          <label>Market
            <select value={cfg.mkt} onChange={(e) => setC({ mkt: e.target.value })}>
              <option value="any">Any (scan all 10)</option>
              {SYMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label>{cfg.fam === 'ou' ? 'Barrier digit' : 'Digit'}
            <select value={cfg.digit} disabled={cfg.fam === 'eo'} onChange={(e) => setC({ digit: e.target.value })}>
              <option value="any">Any</option>
              {D10.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
        </div>
        <div className="row">
          <label>Analyse
            <select value={cfg.kind} onChange={(e) => setC({ kind: e.target.value })}>
              {kindOpts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label>Model
            <select value={cfg.model} onChange={(e) => setC({ model: e.target.value })}>
              <option value="ens">Blend of all three</option>
              <option value="freq">Overall share</option>
              <option value="recent">Recent 100 ticks</option>
              <option value="markov">Markov (after last digit)</option>
            </select>
          </label>
        </div>
        <label>History window
          <select value={cfg.win} onChange={(e) => setC({ win: +e.target.value })}>
            {[300, 500, 1000, 2000, 5000].map((n) => <option key={n} value={n}>{n} ticks</option>)}
          </select>
        </label>
      </section>

      <section className="card">
        <div className="sech"><b>TOP CANDIDATES</b><span className="sub">best estimated win % vs fair odds</span></div>
        {an && an.cands.length ? an.cands.map((cd, i) => (
          <div className="rk" key={cd.sym + cd.type + cd.barrier}>
            <span className="rkn">{i + 1}</span>
            <div className="rkm">
              <b>{SHORT[cd.sym]} · {nameOf(cd)}</b>
              <div className="rkbar"><i style={{ width: clamp(cd.est * 100, 0, 100) + '%' }} /></div>
            </div>
            <div className="rkv">
              <b>{(cd.est * 100).toFixed(1)}%</b>
              <small>{cd.edge >= 0 ? '+' : ''}{cd.edge.toFixed(2)} · z {cd.z.toFixed(1)}</small>
            </div>
          </div>
        )) : <div className="muted">Waiting for enough ticks…</div>}
      </section>

      <section className="card">
        <div className="sech"><b>MARKET HEAT MAP</b><span className="sub">share of last {winN} ticks · warm above 10%, cool below</span></div>
        <div className="hm">
          <span />
          {D10.map((d) => <span key={d} className="h">{d}</span>)}
          {(cfg.mkt === 'any' ? ALL : [cfg.mkt]).map((sym) => {
            const m2 = an && an.per[sym]
            return [
              <span key={sym + 'm'} className={'m' + (sym === wsym ? ' sel' : '')} onClick={() => setWatch(sym)}>{SHORT[sym]}</span>,
              ...D10.map((d) => (
                <span key={sym + d} className="c" style={{ background: m2 ? cell(m2.zd[d]) : 'rgba(255,255,255,.05)' }}>
                  {m2 ? (m2.share[d] * 100).toFixed(1) : '·'}
                </span>
              )),
            ]
          })}
        </div>
      </section>

      <section className="card">
        <div className="sech"><b>NEXT DIGIT · {SYMN[wsym] || ''}</b><span className="sub">model estimate per digit</span></div>
        {wm ? (
          <>
            <div className="dbars">
              {D10.map((d) => (
                <div className="db" key={d}>
                  <small>{(wm.p[d] * 100).toFixed(1)}</small>
                  <div className="colw">
                    <div className={'col' + (wm.last === d ? ' last' : '')} style={{ height: clamp((wm.p[d] / 0.2) * 100, 4, 100) + '%' }} />
                    <i className="base" />
                  </div>
                  <b>{d}</b>
                </div>
              ))}
            </div>
            <div className="muted">Dashed line = 10% (fair). Last digit {wm.last} outlined.</div>
          </>
        ) : <div className="muted">Waiting for enough ticks…</div>}
      </section>

      <section className="card">
        <div className="sech"><b>DEEP CHECKS</b><span className="sub">is any of this stronger than luck?</span></div>
        {an && best ? (
          <div className="tests">
            <div><small>Best z-score</small><b>{best.z.toFixed(2)}</b></div>
            <div><small>Needed (across {an.nT} candidates)</small><b>{an.zc.toFixed(2)}</b></div>
            <div><small>Digits uniform? (p)</small><b>{wm ? wm.chiPv.toFixed(3) : '…'}</b></div>
            <div><small>Digits independent? (p)</small><b>{wm && wm.mkP !== null ? wm.mkP.toFixed(3) : 'needs 1000+'}</b></div>
          </div>
        ) : <div className="muted">Waiting for enough ticks…</div>}
        {an && best && (
          <div className={'note ' + (verdict === 'hot' ? 'hot' : 'ok')}>
            {verdict === 'hot'
              ? 'The best candidate is stronger than chance would usually produce across this many candidates. Patterns like this usually fade, so watch whether it persists.'
              : 'The best candidate is what you would expect to find by chance when looking at this many candidates. Percentages near the baseline are normal.'}
          </div>
        )}
        <button className="smallbtn" onClick={() => setAboutOpen((o) => !o)}>{aboutOpen ? 'Hide' : 'What this scanner can and can’t do'}</button>
        {aboutOpen && (
          <div className="muted left">
            It counts how often each digit appeared and estimates the next digit with three simple models, then ranks every matching contract. Deriv builds its synthetic indices from an audited random generator and each tick is independent, so a digit that was common before is not more likely next. A high estimated win % usually falls back toward its baseline. The z-score and the “needed” figure show whether a result is beyond what luck produces across all candidates; most of the time it is not. Deriv also prices every contract with a margin, so even fair-looking odds lose slowly over time.
          </div>
        )}
      </section>

      <section className="card">
        <div className="sech">
          <b>AUTO-TRADE</b>
          <button className={'sw' + (cfg.auto ? ' on' : '')} disabled={running} onClick={() => setC({ auto: !cfg.auto })} aria-label="Auto-trade" />
        </div>
        <div className="row">
          <label>Stake
            <input type="number" min="0.35" step="0.05" disabled={running} value={cfg.stake} onChange={(e) => setC({ stake: e.target.value })} />
          </label>
          <label>Ticks per trade
            <input type="number" min="1" max="10" disabled={running} value={cfg.dur} onChange={(e) => setC({ dur: e.target.value })} />
          </label>
        </div>
        <div className="row">
          <label>Minimum edge (points)
            <input type="number" min="0" step="0.5" disabled={running} value={cfg.minEdge} onChange={(e) => setC({ minEdge: e.target.value })} />
          </label>
          <label>Seconds between trades
            <input type="number" min="1" disabled={running} value={cfg.cool} onChange={(e) => setC({ cool: e.target.value })} />
          </label>
        </div>
        <label>Significance needed
          <select disabled={running} value={cfg.zmode} onChange={(e) => setC({ zmode: e.target.value })}>
            <option value="strict">Strict: beyond chance across all candidates</option>
            <option value="normal">Normal: z-score of 2 or more</option>
            <option value="loose">Loose: edge only (trades on noise)</option>
          </select>
        </label>
        <div className="row">
          <label>Stop loss
            <input type="number" min="0" step="0.5" disabled={running} value={cfg.sl} onChange={(e) => setC({ sl: e.target.value })} />
          </label>
          <label>Take profit (0 = off)
            <input type="number" min="0" step="0.5" disabled={running} value={cfg.tp} onChange={(e) => setC({ tp: e.target.value })} />
          </label>
        </div>
        <label>Result speed
          <select disabled={running} value={cfg.instant === false ? 'off' : 'on'} onChange={(e) => setC({ instant: e.target.value === 'on' })}>
            <option value="on">Instant: settle on the exit tick, Deriv confirms</option>
            <option value="off">Safe: wait for Deriv's result</option>
          </select>
        </label>
        <button className={'buy ' + (running ? 'odd' : 'even')} onClick={running ? () => stopBot('Stopped by you') : start}>
          {running ? 'STOP' : 'START AUTO-TRADE'}
        </button>
        {msg && <div className="muted">{msg}</div>}
        <div className="sum">
          <div><small>Net P/L</small><b className={stats.net >= 0 ? 'win' : 'loss'}>{stats.net >= 0 ? '+' : ''}{stats.net.toFixed(2)}</b></div>
          <div><small>Win / Loss</small><b>{stats.wins} / {stats.losses}</b></div>
          <div><small>Trades</small><b>{stats.trades}</b></div>
        </div>
        <div className="muted">Trades the top candidate when it meets the edge and significance you set. It cannot create an edge: it only places trades faster than you can. Use DEMO first.</div>
      </section>

      {log.length > 0 && (
        <section className="card">
          <div className="muted">Bot activity</div>
          {log.map((l, i) => <div className="log" key={i}>{l}</div>)}
        </section>
      )}
    </div>
  )
}
