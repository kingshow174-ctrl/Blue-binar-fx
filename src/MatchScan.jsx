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
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const DEF = {
  syms: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'], scan: 'auto', win: 100, recent: 30, minRise: 3, taps: 2, other: 1, dur: 1,
  stake: 1, rec: false, mult: 1.25, steps: 6, rend: 'restart', sl: 10, tp: 0, maxT: 0, maxL: 0, instant: true, mstake: 1,
}
const loadCfg = () => {
  try {
    const c = { ...DEF, ...JSON.parse(localStorage.bbfx_ms || '{}') }
    c.syms = (c.syms || []).filter((x) => SYMN[x])
    if (!c.syms.length) c.syms = DEF.syms
    return c
  } catch (e) { return DEF }
}
const isDone = (c) => !!c && (Boolean(c.is_sold) || c.status === 'won' || c.status === 'lost')
const pnl = (c) => {
  if (c.profit !== undefined && c.profit !== null && c.profit !== '') {
    const p = Number(c.profit)
    if (!Number.isNaN(p)) return p
  }
  const buy = Number(c.buy_price)
  const pay = Number(c.payout)
  if (c.status === 'won' && Number.isFinite(buy) && Number.isFinite(pay)) return pay - buy
  if (c.status === 'lost' && Number.isFinite(buy)) return -buy
  return NaN
}
const rank = (cnt) => {
  const mx = Math.max(...cnt)
  const mn = Math.min(...cnt)
  const second = Math.max(-1, ...cnt.filter((c) => c < mx))
  return (c) => (c === mx ? 'g' : c === mn ? 'r' : c === second ? 'b' : '')
}
// share of each digit now, before, and how much it rose lately
const analyse = (a, L, R) => {
  const have = Math.min(a.length, L)
  const out = { have, L, R, ready: have >= L, pct: Array(10).fill(0), rec: Array(10).fill(0), base: Array(10).fill(0), rise: Array(10).fill(0), top: null, run: { d: -1, n: 0 } }
  if (!a.length) return out
  const last = a[a.length - 1]
  let n = 0
  for (let i = a.length - 1; i >= 0 && a[i] === last; i--) n += 1
  out.run = { d: last, n }
  if (!out.ready) return out
  const win = a.slice(-L)
  win.forEach((d) => { out.pct[d] += 1 })
  win.slice(-R).forEach((d) => { out.rec[d] += 1 })
  win.slice(0, L - R).forEach((d) => { out.base[d] += 1 })
  let best = 0
  for (let d = 0; d < 10; d++) {
    out.pct[d] = (out.pct[d] * 100) / L
    out.rec[d] = (out.rec[d] * 100) / R
    out.base[d] = (out.base[d] * 100) / (L - R)
    out.rise[d] = out.rec[d] - out.base[d]
    if (out.rise[d] > out.rise[best]) best = d
  }
  out.top = { d: best, rise: out.rise[best] }
  return out
}
// how much the digit had risen before its current run of taps began (the taps themselves must not count)
const preRise = (a, d, n, L, R) => {
  const p = analyse(a.slice(0, a.length - n), L, R)
  return p.ready ? p.rise[d] : -99
}
const ORDER = { armed: 0, ready: 1, tap: 2, rise: 3, none: 4, load: 5 }
const STATE_TXT = {
  armed: 'ARMED · waiting for another digit', ready: 'READY · taps done, next other digit enters', tap: 'tapping', rise: 'rising', none: 'no rising digit', load: 'loading',
}

export default function MatchScan({ active, tradeOn, send, cur, demo, addHist, updHist }) {
  const [cfg, setCfg] = useState(loadCfg)
  const [, force] = useState(0)
  const [running, setRunning] = useState(false)
  const [stats, setStats] = useState({ net: 0, trades: 0, wins: 0, losses: 0, idx: 0 })
  const [log, setLog] = useState([])
  const [msg, setMsg] = useState('')
  const [watch, setWatch] = useState('')
  const [snap, setSnap] = useState(null)
  const [mstats, setMstats] = useState({ net: 0, wins: 0, losses: 0 })
  const [mres, setMres] = useState(null)

  const cfgRef = useRef(cfg)
  const runRef = useRef(false)
  const netRef = useRef(0)
  const idxRef = useRef(0)
  const doneN = useRef(0)
  const lossN = useRef(0)
  const errs = useRef(0)
  const digs = useRef({})
  const pip = useRef({})
  const pat = useRef({})
  const reqs = useRef({})
  const pend = useRef(new Set())
  const openMap = useRef({})
  const armReq = useRef({})
  const armLatest = useRef({})
  const armP = useRef({})
  const armTs = useRef({})
  const armTries = useRef({})
  const settled = useRef({})
  const tb = useRef({})
  const lastEp = useRef({})
  const tickAt = useRef({})
  const pollAt = useRef({})
  const seq = useRef(1600000)
  const raf = useRef(0)
  const holds = useRef(0)
  const paused = useRef(false)
  const pauseTimer = useRef(null)
  const rateUntil = useRef(0)
  const sendRef = useRef(send)
  const tradeOnRef = useRef(tradeOn)
  const curRef = useRef(cur)
  const helpers = useRef({})
  cfgRef.current = cfg
  sendRef.current = send
  tradeOnRef.current = tradeOn
  curRef.current = cur
  helpers.current = { addHist, updHist }

  const L = clamp(Math.round(+cfg.win || 100), 40, 1000)
  const R = clamp(Math.round(+cfg.recent || 30), 10, L - 10)
  const minR = Math.max(0, +cfg.minRise || 0)
  const TAPS = clamp(Math.round(+cfg.taps || 2), 2, 8)
  const OTHER = clamp(Math.round(+cfg.other || 1), 1, 5)
  const keepNow = Math.min(1000, L + 10)
  const [keep, setKeep] = useState(keepNow)
  useEffect(() => {
    const t = setTimeout(() => setKeep(keepNow), 600)
    return () => clearTimeout(t)
  }, [keepNow])
  const feedOn = !!active || running

  useEffect(() => { localStorage.bbfx_ms = JSON.stringify(cfg) }, [cfg])
  const setC = (p) => setCfg((c) => ({ ...c, ...p }))
  const addLog = (t) => setLog((l) => [t, ...l].slice(0, 16))
  const bump = () => {
    if (raf.current) return
    raf.current = requestAnimationFrame(() => { raf.current = 0; force((x) => x + 1) })
  }
  const togSym = (v) => {
    const has = cfg.syms.includes(v)
    if (has && cfg.syms.length === 1) return
    setC({ syms: has ? cfg.syms.filter((x) => x !== v) : [...cfg.syms, v] })
  }
  const infoOf = (sym) => analyse(digs.current[sym] || [], L, R)

  // ---------- stake ----------
  const baseStake = () => Math.max(0.35, Math.round((+cfgRef.current.stake || 0.35) * 100) / 100)
  const stakeAt = (i) => {
    const c = cfgRef.current
    if (!c.rec) return baseStake()
    return Math.max(0.35, Math.round(baseStake() * Math.pow(+c.mult || 1, i) * 100) / 100)
  }
  const curStake = () => stakeAt(idxRef.current)
  const keyOf = (sym, x, stake) => [sym, x, +cfgRef.current.dur || 1, stake, curRef.current].join('|')
  const isMan = (m) => !!(m && m.manual)
  const botOpen = () => Object.values(openMap.current).filter((o) => !isMan(o.meta)).length
    + [...pend.current].filter((rid) => { const r = reqs.current[rid]; return !(r && isMan(r.meta)) }).length
  const slots = () => botOpen() + holds.current
  const forget = (id) => { if (id) sendRef.current({ forget: id }) }

  const stopBot = (why) => {
    paused.current = false
    clearTimeout(pauseTimer.current)
    runRef.current = false
    pat.current = {}
    setRunning(false)
    Object.values(armP.current).forEach((a) => forget(a.subId))
    armP.current = {}
    armLatest.current = {}
    ;[...pend.current].forEach((rid) => { const r = reqs.current[rid]; if (!(r && isMan(r.meta))) pend.current.delete(rid) })
    setMsg(why ? '■ ' + why : 'Stopped')
    if (why) addLog('■ ' + why)
  }

  // ---------- ready-to-buy price while a market is armed ----------
  const armOne = (sym, x, stake, key) => {
    const rid = ++seq.current
    armReq.current[rid] = { sym, key }
    armLatest.current[sym] = rid
    sendRef.current({
      proposal: 1, subscribe: 1, req_id: rid, amount: stake, basis: 'stake', contract_type: 'DIGITMATCH',
      currency: curRef.current || 'USD', duration: +cfgRef.current.dur || 1, duration_unit: 't',
      underlying_symbol: sym, barrier: String(x),
    })
  }
  const ensureArm = (sym, x) => {
    if (!runRef.current || !tradeOnRef.current || paused.current) return
    if (Date.now() < rateUntil.current) return
    const key = keyOf(sym, x, curStake())
    const a = armP.current[sym]
    if (a && a.key === key) return
    if (a) { forget(a.subId); delete armP.current[sym] }
    if (Date.now() - (armTs.current[sym] || 0) < 800) return
    armTs.current[sym] = Date.now()
    armOne(sym, x, curStake(), key)
  }
  const disarm = (sym) => {
    const a = armP.current[sym]
    if (a) { forget(a.subId); delete armP.current[sym] }
    delete armLatest.current[sym]
  }
  const refreshArms = () => {
    Object.keys(pat.current).forEach((sym) => { const st = pat.current[sym]; if (st.armed) ensureArm(sym, st.x) })
  }

  const sendBuy = (meta, pid, ask, subId, armed, retried) => {
    const rid = ++seq.current
    reqs.current[rid] = { kind: 'buy', meta, subId, armed, retried, t: Date.now() }
    pend.current.add(rid)
    sendRef.current({ buy: pid, price: Number(ask) || meta.stake, req_id: rid })
  }
  const slow = (meta, retried) => {
    const rid = ++seq.current
    reqs.current[rid] = { kind: 'proposal', meta, retried, t: Date.now() }
    pend.current.add(rid)
    sendRef.current({
      proposal: 1, subscribe: 1, req_id: rid, amount: meta.stake, basis: 'stake', contract_type: 'DIGITMATCH',
      currency: curRef.current || 'USD', duration: meta.dur, duration_unit: 't',
      underlying_symbol: meta.sym, barrier: String(meta.x),
    })
  }

  const fire = (sym, x) => {
    const c = cfgRef.current
    if (slots() >= 1) return false
    if (Date.now() < rateUntil.current) return false
    if (+c.maxT > 0 && doneN.current >= +c.maxT) return false
    const stake = curStake()
    if (netRef.current - stake <= -Math.abs(+c.sl)) {
      stopBot('Next stake ' + stake + ' could pass your stop loss, stopped')
      return false
    }
    const meta = { sym, x, stake, dur: +c.dur || 1, step: idxRef.current, t0: Date.now(), trig: (digs.current[sym] || []).slice(-4).join('') }
    const a = armP.current[sym]
    if (a && a.id && a.key === keyOf(sym, x, stake)) {
      delete armP.current[sym]
      delete armLatest.current[sym]
      sendBuy(meta, a.id, a.ask, a.subId, true, false)
    } else {
      slow(meta, false)
    }
    if (navigator.vibrate) navigator.vibrate(40)
    return true
  }

  // every tick: a rising digit tapped 2+ times, then another digit, then enter Matches on it
  const patStep = (sym) => {
    if (!runRef.current || !tradeOnRef.current || paused.current) return
    const c = cfgRef.current
    if (c.scan === 'manual') return
    const a = digs.current[sym] || []
    if (!a.length) return
    const info = analyse(a, L, R)
    if (!info.ready) return
    const st = pat.current[sym] || (pat.current[sym] = { armed: false, x: -1, others: 0, age: 0 })
    const d = a[a.length - 1]
    if (st.armed) {
      st.age += 1
      if (st.age > OTHER + 8) {
        st.armed = false
        disarm(sym)
        addLog('⌛ ' + SYMN[sym] + ': digit ' + st.x + ' signal expired')
        return
      }
      if (d === st.x) { st.others = 0; return }
      st.others += 1
      if (st.others >= OTHER && fire(sym, st.x)) {
        st.armed = false
        disarm(sym)
      }
      return
    }
    if (info.run.n >= TAPS) {
      const pr = preRise(a, d, info.run.n, L, R)
      if (pr >= minR) {
        st.armed = true
        st.x = d
        st.others = 0
        st.age = 0
        addLog('🎯 ' + SYMN[sym] + ': digit ' + d + ' rising (+' + pr.toFixed(1) + ') and tapped ' + info.run.n + ' times, waiting for another digit')
        if (navigator.vibrate) navigator.vibrate(60)
        ensureArm(sym, d)
      }
    }
  }

  // ---------- manual trades ----------
  const mStake = () => Math.max(0.35, Math.round((+cfgRef.current.mstake || 0.35) * 100) / 100)
  const manualResult = (o, profit, ex) => {
    const win = profit >= 0
    const ret = win && Number.isFinite(o.cost) ? o.cost + profit : 0
    addLog('🖐 ' + (win ? '✅ ' : '❌ ') + SYMN[o.meta.sym] + ' Matches ' + o.meta.x + ' · stake ' + o.meta.stake + (ex == null || Number.isNaN(ex) ? '' : ' · exit ' + ex) + ' · ' + (win ? '+' : '') + profit.toFixed(2) + (ret > 0 ? ' · total return ' + ret.toFixed(2) : ''))
    setMstats((st) => ({ net: st.net + profit, wins: st.wins + (win ? 1 : 0), losses: st.losses + (win ? 0 : 1) }))
    setMres({ text: (win ? 'WIN +' : 'LOSS ') + profit.toFixed(2), win, ret: ret > 0 ? ret : null, t: Date.now() })
    bump()
  }
  const manualBuy = (sym, x) => {
    const c = cfgRef.current
    const say = (text) => setMres({ text, win: null, ret: null, t: Date.now() })
    if (!tradeOnRef.current) return say('Log in first')
    if (!(+c.mstake >= 0.35)) return say('Stake must be at least 0.35')
    if (!(x >= 0 && x <= 9)) return say('No digit to match')
    if (Date.now() < rateUntil.current) return say('Deriv asked to slow down, try again in a moment')
    setMres(null)
    slow({ sym, x, stake: mStake(), dur: +c.dur || 1, t0: Date.now(), trig: '', manual: true }, false)
    if (navigator.vibrate) navigator.vibrate(30)
  }

  // ---------- results ----------
  const finish = (c, o, prov) => {
    const cid = String(c.contract_id)
    delete openMap.current[cid]
    const profit = pnl(c)
    if (Number.isNaN(profit)) return
    if (prov) settled.current[cid] = { meta: o.meta, profit, win: profit >= 0, t: Date.now() }
    const ex = prov ? c.exit_digit : typeof c.exit_tick_display_value === 'string' ? +c.exit_tick_display_value.slice(-1) : NaN
    helpers.current.updHist(c.contract_id, { status: profit >= 0 ? 'win' : 'loss', profit, exit: Number.isNaN(ex) ? undefined : ex })
    if (o.meta.manual) return manualResult(o, profit, ex)
    netRef.current += profit
    doneN.current += 1
    if (profit < 0) lossN.current += 1
    const cf = cfgRef.current
    let note = ''
    let endStop = false
    if (cf.rec) {
      if (profit >= 0) {
        if (idxRef.current > 0) note = ' · recovered, back to the first stake'
        idxRef.current = 0
      } else {
        idxRef.current += 1
        if (idxRef.current > Math.max(1, Math.round(+cf.steps || 1))) {
          idxRef.current = 0
          if (cf.rend === 'stop') endStop = true
          note = ' · recovery steps used up'
        } else note = ' · step ' + (idxRef.current + 1)
      }
    }
    const idx = idxRef.current
    setStats((st) => ({
      net: netRef.current, trades: st.trades + 1, wins: st.wins + (profit >= 0 ? 1 : 0), losses: st.losses + (profit < 0 ? 1 : 0), idx,
    }))
    const ret = profit >= 0 && Number.isFinite(o.cost) ? o.cost + profit : 0
    addLog(
      (profit >= 0 ? '✅ ' : '❌ ') + SYMN[o.meta.sym] + ' Matches ' + o.meta.x + ' · stake ' + o.meta.stake + (o.meta.trig ? ' · digits ' + o.meta.trig : '') +
      (ex == null || Number.isNaN(ex) ? '' : ' · exit ' + ex) + (o.lat != null ? ' · ' + o.lat + 'ms' : '') + ' · ' + (profit >= 0 ? '+' : '') + profit.toFixed(2) +
      (ret > 0 ? ' · total return ' + ret.toFixed(2) : '') + note + (cf.rec ? ' → next stake ' + curStake() : '')
    )
    bump()
    if (!runRef.current) return
    if (netRef.current <= -Math.abs(+cf.sl)) return stopBot('Stop loss reached')
    if (+cf.tp > 0 && netRef.current >= +cf.tp) return stopBot('Take profit reached')
    if (endStop) return stopBot('Reached the end of the recovery steps')
    if (+cf.maxT > 0 && doneN.current >= +cf.maxT) return stopBot('Finished ' + cf.maxT + ' trades')
    if (+cf.maxL > 0 && lossN.current >= +cf.maxL) return stopBot('Stopped after ' + cf.maxL + ' losses')
    refreshArms()
  }
  const tryTick = (o, id, ep, d) => {
    if (cfgRef.current.instant === false) return
    if (o.noProv || !o.pt || !(o.payout > 0) || !(o.cost > 0)) return
    if (!(Number(ep) > o.pt)) return
    if (o.seen === 0 && Number(ep) - o.pt > 6) { o.noProv = true; return }
    o.seen += 1
    if (o.seen < (o.meta.dur || 1)) return
    const win = d === o.meta.x
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
    helpers.current.updHist(id, { status: real >= 0 ? 'win' : 'loss', profit: real, exit: Number.isNaN(ex) ? undefined : ex })
    if (sm.meta.manual) {
      setMstats((st) => ({ net: st.net + real - sm.profit, wins: st.wins + (flip ? (real >= 0 ? 1 : -1) : 0), losses: st.losses + (flip ? (real >= 0 ? -1 : 1) : 0) }))
      if (flip) addLog('⚠ Deriv corrected a manual trade to ' + (real >= 0 ? 'WIN ' : 'LOSS ') + real.toFixed(2))
      return
    }
    netRef.current += real - sm.profit
    if (flip) lossN.current += real >= 0 ? -1 : 1
    setStats((st) => ({
      ...st, net: netRef.current, wins: st.wins + (flip ? (real >= 0 ? 1 : -1) : 0), losses: st.losses + (flip ? (real >= 0 ? -1 : 1) : 0),
    }))
    if (flip) addLog('⚠ Deriv corrected ' + SYMN[sm.meta.sym] + ' to ' + (real >= 0 ? 'WIN ' : 'LOSS ') + real.toFixed(2))
    if (!runRef.current) return
    const c2 = cfgRef.current
    if (netRef.current <= -Math.abs(+c2.sl)) stopBot('Stop loss reached')
    else if (+c2.tp > 0 && netRef.current >= +c2.tp) stopBot('Take profit reached')
    else if (+c2.maxL > 0 && lossN.current >= +c2.maxL) stopBot('Stopped after ' + c2.maxL + ' losses')
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
      if (!rid || rid < 1600000 || rid >= 1700000) return

      const ar = armReq.current[rid]
      if (ar) {
        const sym = ar.sym
        if (m.error) {
          if (isRate(m.error)) { rateUntil.current = Date.now() + 5000; addLog('Deriv asked to slow down, pausing 5s'); return }
          if (already(m.error)) {
            const n = (armTries.current[sym] || 0) + 1
            armTries.current[sym] = n
            if (n <= 5) setTimeout(() => { armTs.current[sym] = 0; const st = pat.current[sym]; if (st && st.armed) ensureArm(sym, st.x) }, 600)
            return
          }
          addLog('⚠ ' + SYMN[sym] + ': ' + m.error.message)
          return
        }
        if (m.msg_type === 'proposal') {
          if (!runRef.current || armLatest.current[sym] !== rid) {
            if (m.subscription) forget(m.subscription.id)
            return
          }
          const old = armP.current[sym]
          if (old && old.subId && m.subscription && old.subId !== m.subscription.id) forget(old.subId)
          armTries.current[sym] = 0
          armP.current[sym] = { id: m.proposal.id, ask: m.proposal.ask_price, subId: m.subscription && m.subscription.id, key: ar.key }
        }
        return
      }

      const r = reqs.current[rid]
      if (!r) return
      if (m.error) {
        pend.current.delete(rid)
        if (isRate(m.error)) {
          rateUntil.current = Date.now() + 5000
          addLog('Deriv asked to slow down, pausing 5s')
          if (r.meta && r.meta.manual) setMres({ text: 'Deriv asked to slow down, try again in a moment', win: null, ret: null, t: Date.now() })
          return
        }
        if (r.kind === 'proposal' && already(m.error) && (r.meta.tries || 0) < 4) {
          holds.current += 1
          r.meta.tries = (r.meta.tries || 0) + 1
          setTimeout(() => { holds.current -= 1; slow(r.meta, r.retried) }, 450)
          return
        }
        if (r.kind === 'buy' && r.armed && !r.retried) {
          addLog('Fast price expired, retrying')
          slow(r.meta, true)
          return
        }
        if (r.meta && r.meta.manual) {
          addLog('⚠ Manual trade: ' + m.error.message)
          setMres({ text: m.error.message, win: null, ret: null, t: Date.now() })
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
        sendBuy(r.meta, m.proposal.id, m.proposal.ask_price, m.subscription && m.subscription.id, false, r.retried)
      } else if (m.msg_type === 'buy' && r.kind === 'buy') {
        pend.current.delete(rid)
        if (!(r.meta && r.meta.manual)) errs.current = 0
        const id = m.buy.contract_id
        openMap.current[String(id)] = {
          meta: r.meta, t: Date.now(), pt: Number(m.buy.purchase_time) || 0, seen: 0,
          lat: Date.now() - (r.meta.t0 || Date.now()), payout: Number(m.buy.payout), cost: Number(m.buy.buy_price),
        }
        sendRef.current({ proposal_open_contract: 1, contract_id: id, subscribe: 1, req_id: ++seq.current })
        helpers.current.addHist({
          id, t: Date.now(), symbol: r.meta.sym, type: 'DIGITMATCH', barrier: r.meta.x, stake: Number(m.buy.buy_price), status: 'open',
        })
        forget(r.subId)
        replayTicks(String(id))
        bump()
      }
    }
    bus.fns.add(h)
    return () => bus.fns.delete(h)
  }, [])

  // ---------- watchdog (bot and manual trades) ----------
  useEffect(() => {
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
          if (o.meta.manual) addLog('🖐 No result received for a manual trade')
          else if (runRef.current) stopBot('No result received for a trade, stopped for safety')
        }
      })
      if (runRef.current) refreshArms()
    }, 2000)
    return () => clearInterval(t)
  }, [])

  // ---------- tick monitor ----------
  const symKey = cfg.syms.join(',')
  useEffect(() => {
    const syms = cfgRef.current.syms
    if (!feedOn || !syms.length) return undefined
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
          sock.send(JSON.stringify({ ticks_history: sym, count: keep, end: 'latest', style: 'ticks' }))
          setTimeout(() => sub(sym), 3000)
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
          digs.current[sym] = (hh.prices || []).map((p) => +Number(p).toFixed(pp).slice(-1)).slice(-keep)
          sub(sym)
          bump()
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
          digs.current[sym] = [...(digs.current[sym] || []).slice(-(keep - 1)), d]
          tickAt.current[sym] = Date.now()
          settleByTick(sym, t.epoch, d)
          patStep(sym)
          bump()
        }
      }
    }
    connect()
    const refresh = setInterval(() => force((x) => x + 1), 1000)
    const stale = setInterval(() => {
      if (document.visibilityState !== 'visible' || !sock || sock.readyState !== 1) return
      const now = Date.now()
      const opened = tickAt.current.__open || now
      if (syms.some((sym) => now - (tickAt.current[sym] || opened) > 7000)) {
        addLog('Tick feed stalled, reconnecting')
        sock.close()
      }
    }, 2000)
    const vis = () => { if (document.visibilityState === 'visible' && sock) sock.close() }
    document.addEventListener('visibilitychange', vis)
    return () => {
      dead = true
      clearTimeout(retry)
      clearInterval(refresh)
      clearInterval(stale)
      document.removeEventListener('visibilitychange', vis)
      if (sock) sock.close()
    }
  }, [feedOn, symKey, keep])

  useEffect(() => {
    if (!runRef.current) return
    if (!tradeOn) {
      paused.current = true
      ;[...pend.current].forEach((rid) => { const r = reqs.current[rid]; if (!(r && isMan(r.meta))) pend.current.delete(rid) })
      armP.current = {}
      armLatest.current = {}
      armTs.current = {}
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
      refreshArms()
    }
  }, [tradeOn])

  useEffect(() => {
    if (!running) return undefined
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
    if (c.scan === 'manual') return setMsg('Switch to Auto scan to run the auto trade')
    if (!tradeOnRef.current) return setMsg('Log in first')
    if (!c.syms.length) return setMsg('Pick at least one market')
    if (!(+c.stake >= 0.35)) return setMsg('Stake must be at least 0.35')
    if (!(+c.sl > 0)) return setMsg('Set a stop loss above 0')
    if (!demo && !confirm('REAL account. The bot will trade automatically with real money. Start?')) return
    netRef.current = 0
    idxRef.current = 0
    doneN.current = 0
    lossN.current = 0
    errs.current = 0
    pat.current = {}
    setStats({ net: 0, trades: 0, wins: 0, losses: 0, idx: 0 })
    runRef.current = true
    setRunning(true)
    setMsg('Scanning ' + c.syms.length + ' market' + (c.syms.length > 1 ? 's' : ''))
    addLog('▶ Auto trade started')
  }

  // ---------- the scan: one row per market ----------
  const buildRows = () => cfg.syms.map((sym) => {
    const info = infoOf(sym)
    const st = pat.current[sym]
    const rd = info.run.d
    const prr = info.ready && info.run.n ? preRise(digs.current[sym] || [], rd, info.run.n, L, R) : -99
    const tapped = prr >= minR ? rd : -1
    let state = 'load'
    let cand = -1
    let rv = 0
    if (info.ready) {
      if (running && st && st.armed) { state = 'armed'; cand = st.x; rv = st.x === rd ? prr : info.rise[st.x] }
      else if (tapped >= 0 && info.run.n >= TAPS) { state = 'ready'; cand = tapped; rv = prr }
      else if (tapped >= 0) { state = 'tap'; cand = tapped; rv = prr }
      else if (info.top && info.top.rise >= minR) { state = 'rise'; cand = info.top.d; rv = info.top.rise }
      else state = 'none'
    }
    return { sym, info, state, cand, rv }
  }).sort((a, b) => ORDER[a.state] - ORDER[b.state] || ((b.info.top ? b.info.top.rise : -99) - (a.info.top ? a.info.top.rise : -99)))
  const liveRows = buildRows()
  const manualMode = cfg.scan === 'manual'
  const rows = manualMode ? (snap ? snap.rows : []) : liveRows
  const scanNow = () => setSnap({ t: Date.now(), rows: buildRows() })

  // ---------- screen ----------
  const best = liveRows.find((r) => r.state !== 'none' && r.state !== 'load') || liveRows[0]
  const wsym = cfg.syms.includes(watch) ? watch : best ? best.sym : cfg.syms[0]
  const info = infoOf(wsym)
  const arr = digs.current[wsym] || []
  const lastD = arr[arr.length - 1]
  const rising = (d) => info.ready && info.rise[d] >= minR
  const cls = rank(info.pct)
  const maxP = Math.max(10.5, ...info.pct)
  const openNow = botOpen()
  const wst = running && pat.current[wsym] && pat.current[wsym].armed
  const phase = !running ? 'idle' : paused.current ? 'paused' : openNow > 0 ? 'trading' : rows.some((r) => r.state === 'armed') ? 'armed' : 'watching'
  const PHASE_TXT = { idle: manualMode ? 'MANUAL SCAN' : 'AUTO SCAN', paused: 'RECONNECTING', trading: 'TRADE OPEN', armed: 'ARMED · waiting for another digit', watching: 'SCANNING' }
  const stakeL = Array.from({ length: Math.min(6, Math.max(1, Math.round(+cfg.steps || 1)) + 1) }, (_, i) => stakeAt(i))

  return (
    <div className="ou">
      <section className="ou-hero">
        <div className="ou-orb" />
        <div className="ou-head">
          <div className="ou-hl">
            <div className="ou-eye">MATCHES · RISING DIGIT SCANNER</div>
            <h2 className="ou-title">Find it. Tap tap. Match.</h2>
            <div className={'ou-pill ' + phase}><i />{PHASE_TXT[phase]}</div>
          </div>
          <div className={'ou-big ' + (info.top && rising(info.top.d) ? 'w' : '')}>
            <b>{info.ready && info.top && rising(info.top.d) ? info.top.d : lastD === undefined ? '–' : lastD}</b>
            <small>{info.ready && info.top && rising(info.top.d) ? 'rising first' : 'last digit'}</small>
          </div>
        </div>
        <select className="ou-sel" value={cfg.syms.includes(watch) ? watch : ''} onChange={(e) => setWatch(e.target.value)}>
          <option value="">Best market (automatic)</option>
          {cfg.syms.map((v) => <option key={v} value={v}>{SYMN[v]}</option>)}
        </select>
        <div className="ou-strip">
          {Array.from({ length: 24 }, (_, i) => {
            const d = arr[arr.length - 24 + i]
            if (d === undefined) return <b key={i} className="x">·</b>
            return <b key={i} className={(rising(d) ? 'o' : '') + (i === 23 ? ' now' : '')}>{d}</b>
          })}
        </div>
        <div className="ou-leg">
          <span className="o">rising digit (+{minR}% or more lately)</span>
          <span className="w">{SYMN[wsym]}</span>
        </div>
      </section>

      <section className="ou-card">
        <div className="ou-h"><b>SCAN</b><span>{manualMode ? (snap ? 'scanned ' + new Date(snap.t).toLocaleTimeString() : 'press Scan now') : 'live, every tick'}</span></div>
        <div className="ou-seg two">
          {[['auto', 'Auto scan'], ['manual', 'Manual scan']].map(([k, l]) => (
            <button key={k} className={cfg.scan === k ? 'on' : ''} disabled={running} onClick={() => setC({ scan: k })}>{l}</button>
          ))}
        </div>
        {manualMode && (
          <div className="ms-man">
            <button className="ms-scan" onClick={scanNow}>SCAN NOW</button>
            <label>Stake
              <input type="number" min="0.35" step="0.05" value={cfg.mstake} onChange={(e) => setC({ mstake: e.target.value })} />
            </label>
          </div>
        )}
        <div className="ms-rows">
          {manualMode && !snap && <div className="ou-note">Press Scan now to check every market for a rising digit.</div>}
          {rows.map((r) => (
            <div key={r.sym} className={'ms-row ' + r.state + (r.sym === wsym ? ' act' : '')} onClick={() => setWatch(r.sym)}>
              <span className="nm">{SYMN[r.sym]}</span>
              <span className="dg">
                {!r.info.ready ? 'loading ' + r.info.have + '/' + r.info.L
                  : r.cand >= 0 ? <><b>{r.cand}</b><i>▲ +{r.rv.toFixed(1)}</i></> : <i>no riser</i>}
              </span>
              <span className="tp">{r.info.ready && r.cand >= 0 && r.info.run.d === r.cand ? 'taps ×' + r.info.run.n : '–'}</span>
              <span className={'st ' + r.state}>{STATE_TXT[r.state]}</span>
              {manualMode && r.cand >= 0 && (
                <button disabled={!tradeOn} onClick={(e) => { e.stopPropagation(); manualBuy(r.sym, r.cand) }}>MATCH {r.cand}</button>
              )}
            </div>
          ))}
        </div>
        {mres && (
          <div className={'ou-mres ' + (mres.win === true ? 'win' : mres.win === false ? 'loss' : '')}>
            {mres.text}
            {mres.ret ? <em>Total return {mres.ret.toFixed(2)}</em> : null}
          </div>
        )}
        {manualMode && (
          <div className="ou-stats">
            <div><small>Manual P/L</small><b className={mstats.net >= 0 ? 'win' : 'loss'}>{mstats.net >= 0 ? '+' : ''}{mstats.net.toFixed(2)}</b></div>
            <div><small>Win / Loss</small><b>{mstats.wins} / {mstats.losses}</b></div>
            <div><small>Stake</small><b>{mStake()}</b></div>
          </div>
        )}
        <div className="ou-note">
          {manualMode
            ? 'Manual scan: press Scan now, then tap MATCH on a row to buy Matches on that market and digit.'
            : 'Auto scan: a digit whose share has been rising is watched. When it is tapped ' + TAPS + ' times in a row and then ' + (OTHER > 1 ? OTHER + ' other digits show' : 'another digit shows') + ', the bot buys Matches on it.'}
        </div>
      </section>

      <section className="ou-card">
        <div className="ou-h">
          <b>CIRCLES</b>
          <input type="number" min="40" max="1000" value={cfg.win} onChange={(e) => setC({ win: e.target.value })} aria-label="Ticks analysed" />
        </div>
        <div className="ou-circles">
          {info.pct.map((p, d) => (
            <div className="ou-cw" key={d}>
              <div className={'ou-c ' + cls(p) + (info.ready ? '' : ' empty')}>
                <svg viewBox="0 0 64 64" aria-hidden="true">
                  <circle cx="32" cy="32" r="27" className="t" />
                  <circle cx="32" cy="32" r="27" className="p" strokeDasharray={2 * Math.PI * 27} strokeDashoffset={2 * Math.PI * 27 * (1 - clamp(p / 20, 0, 1))} transform="rotate(-90 32 32)" />
                </svg>
                <b>{d}</b>
                <small>{info.ready ? p.toFixed(1) + '%' : '…'}</small>
              </div>
              <i className="ou-tri">{lastD === d ? '▲' : ''}</i>
              <em className={'ms-rs' + (rising(d) ? ' on' : '')}>{rising(d) ? '▲ +' + info.rise[d].toFixed(0) : ''}</em>
            </div>
          ))}
        </div>
        <div className="ou-note">{info.ready ? 'Last ' + L + ' ticks · green most · blue 2nd · red least · ▲ +n = rising lately' : 'Loading ' + info.have + '/' + L + ' ticks…'}</div>
      </section>

      <section className="ou-card">
        <div className="ou-h"><b>LDP</b><span>last digit percentages · white mark = before</span></div>
        <div className="ou-ldp">
          {info.pct.map((p, d) => (
            <div className="col" key={d}>
              <small className="pv">{info.ready ? p.toFixed(1) : ''}</small>
              <div className="well" style={{ '--ref': (10 / maxP) * 100 + '%' }}>
                <div className={'fill ' + cls(p) + (rising(d) ? ' rs' : '')} style={{ height: Math.max(3, (p / maxP) * 100) + '%' }} />
                {info.ready && <div className="ms-base" style={{ bottom: (info.base[d] / maxP) * 100 + '%' }} />}
              </div>
              <span className={'dg' + (lastD === d ? ' cur' : '')}>{d}</span>
            </div>
          ))}
        </div>
        <div className="ou-sum">
          <div><small>Rising first</small><b>{info.ready && info.top && rising(info.top.d) ? info.top.d + ' (+' + info.top.rise.toFixed(1) + ')' : 'none'}</b></div>
          <div><small>Tapped now</small><b>{info.run.n ? info.run.d + ' ×' + info.run.n : '–'}</b></div>
          <div><small>Ticks</small><b>{Math.min(arr.length, L)}</b></div>
        </div>
      </section>

      <section className="ou-card">
        <div className="ou-h"><b>AUTO TRADE</b><span className={'ou-badge ' + phase}>{PHASE_TXT[phase].split(' ·')[0]}</span></div>
        <div className="ou-chips">
          {SYMS.map(([v, l]) => (
            <button key={v} className={cfg.syms.includes(v) ? 'on' : ''} disabled={running} onClick={() => togSym(v)}>{l}</button>
          ))}
        </div>
        <button className="ou-chip2" disabled={running} onClick={() => setC({ syms: SYMS.map((x) => x[0]) })}>Select all markets</button>
        <button className={'ou-go ' + (running ? 'stop' : '')} disabled={manualMode && !running} onClick={() => (running ? stopBot('') : start())}>
          {running ? 'STOP AUTO TRADE' : manualMode ? 'AUTO TRADE (switch to Auto scan)' : 'START AUTO TRADE'}
        </button>
           {msg && <div className="ou-note">{msg}</div>}
        <div className="ou-stats">
          <div><small>Net P/L</small><b className={stats.net >= 0 ? 'win' : 'loss'}>{stats.net >= 0 ? '+' : ''}{stats.net.toFixed(2)}</b></div>
          <div><small>Win / Loss</small><b>{stats.wins} / {stats.losses}</b></div>
          <div><small>Next stake</small><b>{curStake()}</b></div>
        </div>
        <div className="ou-note">Open trades: {openNow > 0 ? 1 : 0} / 1 · trades done {stats.trades}{+cfg.maxT > 0 ? ' of ' + cfg.maxT : ''}{wst ? ' · ' + SYMN[wsym] + ' armed' : ''}</div>
      </section>

      <section className="ou-card">
        <div className="ou-h"><b>STRATEGY</b><span>rising digit · taps · another digit</span></div>
        <div className="ou-grid">
          <label>Ticks analysed (LDP window)
            <input type="number" min="40" max="1000" disabled={running} value={cfg.win} onChange={(e) => setC({ win: e.target.value })} />
          </label>
          <label>Recent part (ticks)
            <input type="number" min="10" max="500" disabled={running} value={cfg.recent} onChange={(e) => setC({ recent: e.target.value })} />
          </label>
          <label>Rising when it gains (% points)
            <input type="number" min="0" max="50" step="0.5" disabled={running} value={cfg.minRise} onChange={(e) => setC({ minRise: e.target.value })} />
          </label>
          <label>Taps in a row (min 2)
            <input type="number" min="2" max="8" disabled={running} value={cfg.taps} onChange={(e) => setC({ taps: e.target.value })} />
          </label>
          <label>Other digits to wait for
            <input type="number" min="1" max="5" disabled={running} value={cfg.other} onChange={(e) => setC({ other: e.target.value })} />
          </label>
          <label>Contract length (ticks)
            <input type="number" min="1" max="10" disabled={running} value={cfg.dur} onChange={(e) => setC({ dur: e.target.value })} />
          </label>
        </div>
        <div className="ou-how">
          <b>How it trades</b>
          <span>The scan compares the last {R} ticks with the {L - R} before them. A digit that gained {minR}% or more is rising, and the biggest gain comes first.</span>
          <span>When a rising digit is tapped {TAPS} times in a row, the bot waits for {OTHER > 1 ? OTHER + ' other digits' : 'another digit'}, then buys <em>Matches</em> on the rising digit.</span>
          <span>Matches wins only when the next digit is exactly that digit, so wins are rare but pay a lot. Check the stop limits before you start.</span>
        </div>
      </section>

      <section className="ou-card">
        <div className="ou-h"><b>STAKE &amp; RISK</b></div>
        <div className="ou-grid">
          <label>Stake
            <input type="number" min="0.35" step="0.05" disabled={running} value={cfg.stake} onChange={(e) => setC({ stake: e.target.value })} />
          </label>
          <label>Recovery after a loss
            <select disabled={running} value={cfg.rec ? 'on' : 'off'} onChange={(e) => setC({ rec: e.target.value === 'on' })}>
              <option value="off">Off (fixed stake)</option>
              <option value="on">On (multiply)</option>
            </select>
          </label>
        </div>
        {cfg.rec && (
          <>
            <div className="ou-grid">
              <label>Multiply stake by
                <input type="number" min="1" max="10" step="0.05" disabled={running} value={cfg.mult} onChange={(e) => setC({ mult: e.target.value })} />
              </label>
              <label>Recovery steps
                <input type="number" min="1" max="12" disabled={running} value={cfg.steps} onChange={(e) => setC({ steps: e.target.value })} />
              </label>
            </div>
            <label>At the end of the steps
              <select disabled={running} value={cfg.rend} onChange={(e) => setC({ rend: e.target.value })}>
                <option value="restart">Start again from the first stake</option>
                <option value="stop">Stop the bot</option>
              </select>
            </label>
            <div className="ou-note">Stakes: {stakeL.join(' → ')}. A win goes back to the first stake.</div>
          </>
        )}
        <div className="ou-grid">
          <label>Stop loss
            <input type="number" min="0" step="0.5" disabled={running} value={cfg.sl} onChange={(e) => setC({ sl: e.target.value })} />
          </label>
          <label>Take profit (0 = off)
            <input type="number" min="0" step="0.5" disabled={running} value={cfg.tp} onChange={(e) => setC({ tp: e.target.value })} />
          </label>
          <label>Stop after trades (0 = off)
            <input type="number" min="0" max="1000" disabled={running} value={cfg.maxT} onChange={(e) => setC({ maxT: e.target.value })} />
          </label>
          <label>Stop after losses (0 = off)
            <input type="number" min="0" max="1000" disabled={running} value={cfg.maxL} onChange={(e) => setC({ maxL: e.target.value })} />
          </label>
          <label>Result speed
            <select disabled={running} value={cfg.instant === false ? 'safe' : 'instant'} onChange={(e) => setC({ instant: e.target.value === 'instant' })}>
              <option value="instant">Instant (from the tick feed)</option>
              <option value="safe">Safe (wait for Deriv)</option>
            </select>
          </label>
        </div>
      </section>

      <section className="ou-card">
        <div className="ou-h"><b>ACTIVITY</b></div>
        {log.length ? log.map((l, i) => <div className="ou-log" key={i}>{l}</div>) : <div className="ou-note">Nothing yet</div>}
      </section>
    </div>
  )
}
