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
  syms: ['R_100'], side: 'both', win: 20, cnt: 7, ob: 1, ub: 8, waitW: 1, dur: 1,
  stake: 1, rec: false, mult: 2.1, steps: 3, rend: 'restart', sl: 10, tp: 10, maxT: 0,
  instant: true, lw: 100,
  mode: 'signal', pob: 4, pub: 4, ustake: 1, pgap: 0,
  lowOn: true, lowD: 4, maxL: 0,
}
const loadCfg = () => {
  try {
    const c = { ...DEF, ...JSON.parse(localStorage.bbfx_ou || '{}') }
    c.syms = (c.syms || []).filter((s) => SYMN[s])
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
const TYPE = { over: 'DIGITOVER', under: 'DIGITUNDER' }
const rank = (cnt) => {
  const mx = Math.max(...cnt)
  const mn = Math.min(...cnt)
  const second = Math.max(-1, ...cnt.filter((c) => c < mx))
  return (c) => (c === mx ? 'g' : c === mn ? 'r' : c === second ? 'b' : '')
}
const RING = 2 * Math.PI * 46

function Ring({ id, label, sub, n, k, state, off }) {
  const frac = off ? 0 : clamp(n / Math.max(1, k), 0, 1)
  return (
    <div className={'ou-ring ' + (off ? 'off' : state)}>
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <defs>
          <linearGradient id={'g' + id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#35d0ff" />
            <stop offset="100%" stopColor="#7a5cff" />
          </linearGradient>
          <linearGradient id={'a' + id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ffd166" />
            <stop offset="100%" stopColor="#ff7a45" />
          </linearGradient>
        </defs>
        <circle cx="60" cy="60" r="46" className="trk" />
        <circle
          cx="60" cy="60" r="46" className="bar" stroke={'url(#' + (state === 'armed' || state === 'fire' ? 'a' : 'g') + id + ')'}
          strokeDasharray={RING} strokeDashoffset={RING * (1 - frac)} transform="rotate(-90 60 60)"
        />
      </svg>
      <div className="mid">
        <b>{off ? '–' : n}</b>
        <small>of {k}</small>
      </div>
      <div className="cap">
        <span>{label}</span>
        <small>{off ? 'side is off' : sub}</small>
      </div>
    </div>
  )
}

export default function OverUnder({ active, tradeOn, send, cur, demo, addHist, updHist }) {
  const [cfg, setCfg] = useState(loadCfg)
  const [, force] = useState(0)
  const [running, setRunning] = useState(false)
  const [stats, setStats] = useState({ net: 0, trades: 0, wins: 0, losses: 0, idx: 0 })
  const [log, setLog] = useState([])
  const [msg, setMsg] = useState('')
  const [watch, setWatch] = useState('')

  const cfgRef = useRef(cfg)
  const runRef = useRef(false)
  const netRef = useRef(0)
  const idxRef = useRef(0)
  const doneN = useRef(0)
  const errs = useRef(0)
  const digs = useRef({})
  const pip = useRef({})
  const tn = useRef({})
  const sigs = useRef({})
  const reqs = useRef({})
  const pend = useRef(new Set())
  const openMap = useRef({})
  const armReq = useRef({})
  const armLatest = useRef({})
  const armP = useRef({})
  const armTs = useRef({})
  const armTries = useRef({})
  const pairs = useRef({})
  const pairWait = useRef(0)
  const pairSeq = useRef(0)
  const lossN = useRef(0)
  const lastSym = useRef('')
  const waitLogAt = useRef(0)
  const settled = useRef({})
  const tb = useRef({})
  const lastEp = useRef({})
  const tickAt = useRef({})
  const pollAt = useRef({})
  const seq = useRef(1500000)
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

  const N = clamp(Math.round(+cfg.win || 20), 20, 500)
  const K = clamp(Math.round(+cfg.cnt || 7), 2, N)
  const LW = clamp(Math.round(+cfg.lw || 100), 20, 1000)
  const keepNow = Math.min(1000, Math.max(60, LW + 5, N + 5))
  const [keep, setKeep] = useState(keepNow)
  useEffect(() => {
    const t = setTimeout(() => setKeep(keepNow), 600)
    return () => clearTimeout(t)
  }, [keepNow])
  const feedOn = !!active || running

  useEffect(() => { localStorage.bbfx_ou = JSON.stringify(cfg) }, [cfg])
  const setC = (p) => setCfg((c) => ({ ...c, ...p }))
  const addLog = (t) => setLog((l) => [t, ...l].slice(0, 14))
  const bump = () => {
    if (raf.current) return
    raf.current = requestAnimationFrame(() => { raf.current = 0; force((x) => x + 1) })
  }
  const togSym = (v) => {
    const has = cfg.syms.includes(v)
    if (has && cfg.syms.length === 1) return
    setC({ syms: has ? cfg.syms.filter((x) => x !== v) : [...cfg.syms, v] })
  }

  // ---------- stake ----------
  const isPair = () => cfgRef.current.mode === 'pair'
  const baseStake = (side) => {
    const c = cfgRef.current
    const v = side === 'under' && c.mode === 'pair' ? +c.ustake : +c.stake
    return Math.max(0.35, Math.round((v || 0.35) * 100) / 100)
  }
  const stakeAt = (i, side) => {
    const c = cfgRef.current
    if (!c.rec) return baseStake(side)
    return Math.max(0.35, Math.round(baseStake(side) * Math.pow(+c.mult || 1, i) * 100) / 100)
  }
  const curStake = (side) => stakeAt(idxRef.current, side)
  const sidesOn = () => (cfgRef.current.mode === 'pair' || cfgRef.current.side === 'both' ? ['over', 'under'] : cfgRef.current.side === 'over' ? ['over'] : ['under'])
  const barrierOf = (side) => {
    const c = cfgRef.current
    const p = c.mode === 'pair'
    return side === 'over' ? +(p ? c.pob : c.ob) : +(p ? c.pub : c.ub)
  }
  const keyOf = (side, stake) => [TYPE[side], barrierOf(side), +cfgRef.current.dur || 1, stake, curRef.current].join('|')
  const slots = () => Object.keys(openMap.current).length + pend.current.size + holds.current
  const forget = (id) => { if (id) sendRef.current({ forget: id }) }
  const sg = (sym, side) => sigs.current[sym + '|' + side] || (sigs.current[sym + '|' + side] = { armed: false, w: 0, resetTn: -1e9 })

  const stopBot = (why) => {
    paused.current = false
    clearTimeout(pauseTimer.current)
    runRef.current = false
    sigs.current = {}
    setRunning(false)
    Object.values(armP.current).forEach((a) => forget(a.subId))
    armP.current = {}
    armLatest.current = {}
    pend.current.clear()
    setMsg(why ? '■ ' + why : 'Stopped')
    if (why) addLog('■ ' + why)
  }

  // ---------- ready-to-buy prices (only while a signal is armed) ----------
  const armOne = (sym, side, stake, key) => {
    const rid = ++seq.current
    armReq.current[rid] = { sym, side, key }
    armLatest.current[sym + '|' + side] = rid
    sendRef.current({
      proposal: 1, subscribe: 1, req_id: rid, amount: stake, basis: 'stake',
      contract_type: TYPE[side], currency: curRef.current || 'USD', duration: +cfgRef.current.dur || 1,
      duration_unit: 't', underlying_symbol: sym, barrier: String(barrierOf(side)),
    })
  }
  const ensureArm = (sym, side) => {
    if (!runRef.current || !tradeOnRef.current || paused.current) return
    if (Date.now() < rateUntil.current) return
    const slot = sym + '|' + side
    const key = keyOf(side, curStake(side))
    const a = armP.current[slot]
    if (a && a.key === key) return
    if (a) { forget(a.subId); delete armP.current[slot] }
    if (Date.now() - (armTs.current[slot] || 0) < 800) return
    armTs.current[slot] = Date.now()
    armOne(sym, side, curStake(side), key)
  }
  const disarm = (sym, side) => {
    const slot = sym + '|' + side
    const a = armP.current[slot]
    if (a) { forget(a.subId); delete armP.current[slot] }
    delete armLatest.current[slot]
  }
  // share of every digit over the analysed ticks, and whether the chosen digit is the lowest
  const lowInfo = (sym) => {
    const c = cfgRef.current
    const d = clamp(Math.round(+c.lowD), 0, 9)
    const L = clamp(Math.round(+c.lw || 100), 20, 1000)
    const a = digs.current[sym] || []
    const have = Math.min(a.length, L)
    const cnt = new Array(10).fill(0)
    for (let i = a.length - have; i < a.length; i++) cnt[a[i]] += 1
    return { d, L, have, pct: have ? (cnt[d] * 100) / have : 0, ok: have >= L && cnt[d] === Math.min(...cnt) }
  }
  const lowestOk = (sym) => cfgRef.current.lowOn === false || lowInfo(sym).ok
  const armTargets = () => {
    const c = cfgRef.current
    const list = c.lowOn === false ? c.syms : c.syms.filter((x) => lowInfo(x).ok)
    return list.slice(0, 4)
  }
  const noteWait = () => {
    const now = Date.now()
    if (now - waitLogAt.current < 30000) return
    const c = cfgRef.current
    if (c.syms.some((x) => lowestOk(x))) return
    waitLogAt.current = now
    addLog('⏳ No market has digit ' + clamp(Math.round(+c.lowD), 0, 9) + ' as its lowest digit, waiting')
  }
  const noteSwitch = (sym) => {
    if (cfgRef.current.lowOn === false) return
    if (lastSym.current && lastSym.current !== sym) {
      const i = lowInfo(sym)
      addLog('↔ Switched to ' + SYMN[sym] + ' (digit ' + i.d + ' is its lowest: ' + i.pct.toFixed(1) + '%)')
    }
    lastSym.current = sym
  }
  const refreshArms = () => {
    if (isPair()) {
      if (!runRef.current) return
      const targets = armTargets()
      Object.keys(armP.current).forEach((slot) => {
        if (!targets.includes(slot.split('|')[0])) {
          forget(armP.current[slot].subId)
          delete armP.current[slot]
          delete armLatest.current[slot]
        }
      })
      targets.forEach((sym) => ['over', 'under'].forEach((side) => ensureArm(sym, side)))
      return
    }
    Object.keys(sigs.current).forEach((slot) => {
      const [sym, side] = slot.split('|')
      if (sigs.current[slot].armed) ensureArm(sym, side)
    })
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
      proposal: 1, subscribe: 1, req_id: rid, amount: meta.stake, basis: 'stake',
      contract_type: meta.type, currency: curRef.current || 'USD', duration: meta.dur,
      duration_unit: 't', underlying_symbol: meta.sym, barrier: String(meta.barrier),
    })
  }

  const fire = (sym, side) => {
    const c = cfgRef.current
    if (slots() >= 1) return false
    if (Date.now() < rateUntil.current) return false
    if (+c.maxT > 0 && doneN.current >= +c.maxT) return false
    if (!lowestOk(sym)) { noteWait(); return false }
    const stake = curStake(side)
    if (netRef.current - stake <= -Math.abs(+c.sl)) {
      stopBot('Next stake ' + stake + ' could pass your stop loss, stopped')
      return false
    }
    const meta = {
      sym, side, stake, type: TYPE[side], barrier: barrierOf(side), dur: +c.dur || 1,
      step: idxRef.current, t0: Date.now(), trig: (digs.current[sym] || []).slice(-4).join(''),
    }
    noteSwitch(sym)
    const slot = sym + '|' + side
    const a = armP.current[slot]
    if (a && a.id && a.key === keyOf(side, stake)) {
      delete armP.current[slot]
      delete armLatest.current[slot]
      sendBuy(meta, a.id, a.ask, a.subId, true, false)
    } else {
      slow(meta, false)
    }
    if (navigator.vibrate) navigator.vibrate(40)
    return true
  }

  const closePair = (pid) => {
    const pr = pairs.current[pid]
    if (!pr || pr.closed) return
    pr.closed = true
    if (!pr.legs) return
    const win = pr.profit >= 0
    pr.win = win
    doneN.current += 1
    if (!win) lossN.current += 1
    const cf = cfgRef.current
    let note = ''
    let endStop = false
    if (cf.rec) {
      if (win) {
        if (idxRef.current > 0) note = ' · recovered, back to the first stakes'
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
      net: netRef.current, trades: st.trades + 1, wins: st.wins + (win ? 1 : 0), losses: st.losses + (win ? 0 : 1), idx,
    }))
    addLog('🅿 Pair ' + (win ? 'WIN ' : 'LOSS ') + (pr.profit >= 0 ? '+' : '') + pr.profit.toFixed(2) + note + (cf.rec ? ' → next stakes ' + curStake('over') + ' + ' + curStake('under') : ''))
    pairWait.current = Math.max(0, Math.round(+cf.pgap || 0))
    bump()
    if (!runRef.current) return
    if (netRef.current <= -Math.abs(+cf.sl)) return stopBot('Stop loss reached')
    if (+cf.tp > 0 && netRef.current >= +cf.tp) return stopBot('Take profit reached')
    if (endStop) return stopBot('Reached the end of the recovery steps')
    if (+cf.maxT > 0 && doneN.current >= +cf.maxT) return stopBot('Finished ' + cf.maxT + ' trades')
    if (+cf.maxL > 0 && lossN.current >= +cf.maxL) return stopBot('Stopped after ' + cf.maxL + ' losses')
    refreshArms()
  }
  const dropLeg = (meta) => {
    const pr = pairs.current[meta.pair]
    if (!pr) return
    pr.left -= 1
    if (pr.left <= 0) closePair(meta.pair)
  }
  const pairLeg = (c, o, profit, ex) => {
    const pr = pairs.current[o.meta.pair]
    addLog(
      (profit >= 0 ? '✅ ' : '❌ ') + SYMN[o.meta.sym] + ' ' + (o.meta.side === 'over' ? 'Over ' : 'Under ') + o.meta.barrier +
      ' · stake ' + o.meta.stake + (ex == null || Number.isNaN(ex) ? '' : ' · exit ' + ex) + (o.lat != null ? ' · ' + o.lat + 'ms' : '') +
      ' · ' + (profit >= 0 ? '+' : '') + profit.toFixed(2)
    )
    if (!pr) return
    pr.profit += profit
    pr.legs = (pr.legs || 0) + 1
    pr.left -= 1
    bump()
    if (pr.left <= 0) closePair(o.meta.pair)
  }
  const firePair = (sym) => {
    const c = cfgRef.current
    if (slots() >= 1) return false
    if (Date.now() < rateUntil.current) return false
    if (+c.maxT > 0 && doneN.current >= +c.maxT) return false
    if (!lowestOk(sym)) { noteWait(); return false }
    const sO = curStake('over')
    const sU = curStake('under')
    if (netRef.current - (sO + sU) <= -Math.abs(+c.sl)) {
      stopBot('Next pair ' + sO + ' + ' + sU + ' could pass your stop loss, stopped')
      return false
    }
    const pid = ++pairSeq.current
    noteSwitch(sym)
    pairs.current[pid] = { left: 2, profit: 0, legs: 0, closed: false, t: Date.now() }
    ;[['over', sO], ['under', sU]].forEach(([side, stake]) => {
      const meta = {
        sym, side, stake, type: TYPE[side], barrier: barrierOf(side), dur: +c.dur || 1,
        step: idxRef.current, t0: Date.now(), trig: '', pair: pid,
      }
      const slot = sym + '|' + side
      const a = armP.current[slot]
      if (a && a.id && a.key === keyOf(side, stake)) {
        delete armP.current[slot]
        delete armLatest.current[slot]
        sendBuy(meta, a.id, a.ask, a.subId, true, false)
      } else {
        slow(meta, false)
      }
    })
    if (navigator.vibrate) navigator.vibrate(40)
    return true
  }

  // runs on every tick: count the cluster, wait for the winning digit, then fire
  const evalTick = (sym) => {
    if (!runRef.current || !tradeOnRef.current || paused.current) return
    const a = digs.current[sym] || []
    if (!a.length) return
    const d = a[a.length - 1]
    const c = cfgRef.current
    const n = tn.current[sym] || 0
    if (c.mode === 'pair') {
      if (pairWait.current > 0) { pairWait.current -= 1; return }
      firePair(sym)
      return
    }
    const need = clamp(Math.round(+c.waitW || 1), 1, 5)
    sidesOn().forEach((side) => {
      const st = sg(sym, side)
      const B = barrierOf(side)
      const wins = side === 'over' ? d > B : d < B
      if (st.armed) {
        st.w = wins ? st.w + 1 : 0
        if (st.w >= need && fire(sym, side)) {
          st.armed = false
          st.w = 0
          st.resetTn = n
          disarm(sym, side)
        }
        return
      }
      const len = Math.min(N, n - st.resetTn, a.length)
      if (len < 1) return
      let cnt = 0
      for (let i = a.length - len; i < a.length; i++) {
        if (side === 'over' ? a[i] <= B : a[i] >= B) cnt += 1
      }
      if (cnt >= K) {
        st.armed = true
        st.w = 0
        addLog('🔔 ' + SYMN[sym] + ': ' + cnt + ' of the last ' + len + ' ticks were ' + (side === 'over' ? '0-' + B : B + '-9') + ', waiting for a ' + (side === 'over' ? 'digit above ' + B : 'digit below ' + B))
        if (navigator.vibrate) navigator.vibrate(60)
        ensureArm(sym, side)
      }
    })
  }

  // ---------- results ----------
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
    if (o.meta.pair) return pairLeg(c, o, profit, ex)
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
      net: netRef.current, trades: st.trades + 1, wins: st.wins + (profit >= 0 ? 1 : 0),
      losses: st.losses + (profit < 0 ? 1 : 0), idx,
    }))
    addLog(
      (profit >= 0 ? '✅ ' : '❌ ') + SYMN[o.meta.sym] + ' ' + (o.meta.side === 'over' ? 'Over ' : 'Under ') + o.meta.barrier +
      ' · stake ' + o.meta.stake + (o.meta.trig ? ' · digits ' + o.meta.trig : '') +
      (ex == null || Number.isNaN(ex) ? '' : ' · exit ' + ex) + (o.lat != null ? ' · ' + o.lat + 'ms' : '') +
      ' · ' + (profit >= 0 ? '+' : '') + profit.toFixed(2) + note + (cf.rec ? ' → next stake ' + curStake('over') : '')
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
    const win = o.meta.side === 'over' ? d > o.meta.barrier : d < o.meta.barrier
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
    let flip = (real >= 0) !== sm.win
    let nowWin = real >= 0
    const ex = typeof c.exit_tick_display_value === 'string' ? +c.exit_tick_display_value.slice(-1) : NaN
    netRef.current += real - sm.profit
    if (sm.meta.pair) {
      const pr = pairs.current[sm.meta.pair]
      const before = pr ? pr.profit >= 0 : false
      if (pr) pr.profit += real - sm.profit
      nowWin = pr ? pr.profit >= 0 : false
      flip = !!(pr && pr.closed && nowWin !== before)
    }
    if (flip) lossN.current += nowWin ? -1 : 1
    helpers.current.updHist(id, {
      status: real >= 0 ? 'win' : 'loss', profit: real, exit: Number.isNaN(ex) ? undefined : ex,
    })
    setStats((st) => ({
      ...st,
      net: netRef.current,
      wins: st.wins + (flip ? (nowWin ? 1 : -1) : 0),
      losses: st.losses + (flip ? (nowWin ? -1 : 1) : 0),
    }))
    if (flip) addLog('⚠ Deriv corrected ' + (sm.meta.pair ? 'the pair' : SYMN[sm.meta.sym]) + ' to ' + (nowWin ? 'WIN ' : 'LOSS ') + real.toFixed(2))
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
      if (!rid || rid < 1500000 || rid >= 1600000) return

      const ar = armReq.current[rid]
      if (ar) {
        const slot = ar.sym + '|' + ar.side
        if (m.error) {
          if (isRate(m.error)) { rateUntil.current = Date.now() + 5000; addLog('Deriv asked to slow down, pausing 5s'); return }
          if (already(m.error)) {
            const n = (armTries.current[slot] || 0) + 1
            armTries.current[slot] = n
            if (n <= 5) setTimeout(() => { armTs.current[slot] = 0; if (sigs.current[slot] && sigs.current[slot].armed) ensureArm(ar.sym, ar.side) }, 600)
            return
          }
          addLog('⚠ ' + SYMN[ar.sym] + ': ' + m.error.message)
          return
        }
        if (m.msg_type === 'proposal') {
          if (!runRef.current || armLatest.current[slot] !== rid) {
            if (m.subscription) forget(m.subscription.id)
            return
          }
          const old = armP.current[slot]
          if (old && old.subId && m.subscription && old.subId !== m.subscription.id) forget(old.subId)
          armTries.current[slot] = 0
          armP.current[slot] = { id: m.proposal.id, ask: m.proposal.ask_price, subId: m.subscription && m.subscription.id, key: ar.key }
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
          if (r.meta && r.meta.pair) dropLeg(r.meta)
          return
        }
        if (r.kind === 'proposal' && already(m.error) && (r.meta.tries || 0) < 4) {
          holds.current += 1
          r.meta.tries = (r.meta.tries || 0) + 1
          setTimeout(() => { holds.current -= 1; if (runRef.current) slow(r.meta, r.retried) }, 450)
          return
        }
        if (r.kind === 'buy' && r.armed && !r.retried) {
          addLog('Fast price expired, retrying')
          slow(r.meta, true)
          return
        }
        if (r.meta && r.meta.pair) dropLeg(r.meta)
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
    if (!running) return undefined
    const t = setInterval(() => {
      const now = Date.now()
      pend.current.forEach((rid) => {
        const r = reqs.current[rid]
        if (!r || now - r.t > 8000) {
          pend.current.delete(rid)
          if (r && r.meta && r.meta.pair) dropLeg(r.meta)
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
      refreshArms()
    }, 2000)
    return () => clearInterval(t)
  }, [running])

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
          tn.current[sym] = (tn.current[sym] || 0) + 1
          tickAt.current[sym] = Date.now()
          settleByTick(sym, t.epoch, d)
          evalTick(sym)
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

  // pause when the trading connection drops, resume by itself
  useEffect(() => {
    if (!runRef.current) return
    if (!tradeOn) {
      paused.current = true
      pend.current.clear()
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
    if (!tradeOnRef.current) return setMsg('Log in first')
    if (!c.syms.length) return setMsg('Pick at least one market')
    if (c.mode === 'pair') {
      if (!(+c.pob >= 0 && +c.pob <= 8)) return setMsg('Over needs a digit from 0 to 8')
      if (!(+c.pub >= 1 && +c.pub <= 9)) return setMsg('Under needs a digit from 1 to 9')
      if (!(+c.ustake >= 0.35)) return setMsg('Under stake must be at least 0.35')
    } else {
      if (!(+c.ob >= 0 && +c.ob <= 8)) return setMsg('Over needs a digit from 0 to 8')
      if (!(+c.ub >= 1 && +c.ub <= 9)) return setMsg('Under needs a digit from 1 to 9')
      if (!(Math.round(+c.cnt) >= 2) || Math.round(+c.cnt) > N) return setMsg('The count must be between 2 and ' + N)
    }
    if (!(+c.stake >= 0.35)) return setMsg('Stake must be at least 0.35')
    if (!(+c.sl > 0)) return setMsg('Set a stop loss above 0')
    if (!demo && !confirm('REAL account. The bot will trade automatically with real money. Start?')) return
    netRef.current = 0
    idxRef.current = 0
    doneN.current = 0
    lossN.current = 0
    lastSym.current = ''
    errs.current = 0
    sigs.current = {}
    pairs.current = {}
    pairWait.current = 0
    setStats({ net: 0, trades: 0, wins: 0, losses: 0, idx: 0 })
    runRef.current = true
    setRunning(true)
    if (c.mode === 'pair') refreshArms()
    setMsg(c.mode === 'pair' ? 'Pair mode: buying Over and Under together' : 'Watching ' + c.syms.length + ' market' + (c.syms.length > 1 ? 's' : ''))
    addLog('▶ Started')
  }

  // ---------- screen ----------
  const lowOn = cfg.lowOn !== false
  const lowD = clamp(Math.round(+cfg.lowD), 0, 9)
  const scan = cfg.syms.map((x) => ({ sym: x, ...lowInfo(x) }))
  const okSyms = scan.filter((x) => x.ok).sort((a, b) => a.pct - b.pct)
  const bestSym = okSyms.length ? okSyms[0].sym : ''
  const wsym = lowOn && running && bestSym ? bestSym : cfg.syms.includes(watch) ? watch : cfg.syms[0]
  const arr = (wsym && digs.current[wsym]) || []
  const pairOn = cfg.mode === 'pair'
  const ob = clamp(Math.round(+(pairOn ? cfg.pob : cfg.ob)), 0, 8)
  const ub = clamp(Math.round(+(pairOn ? cfg.pub : cfg.ub)), 1, 9)
  const sample = arr.slice(-LW)
  const sn = sample.length || 1
  const cnt10 = Array(10).fill(0)
  sample.forEach((d) => { cnt10[d] += 1 })
  const cls = rank(cnt10)
  const lastD = arr[arr.length - 1]
  const maxC = Math.max(1, ...cnt10)
  const pOverWin = (sample.filter((d) => d > ob).length / sn) * 100
  const pUnderWin = (sample.filter((d) => d < ub).length / sn) * 100
  const nW = wsym ? tn.current[wsym] || 0 : 0
  const ringOf = (side) => {
    const st = wsym ? sg(wsym, side) : { armed: false, w: 0, resetTn: -1e9 }
    const B = side === 'over' ? ob : ub
    const len = Math.min(N, nW - st.resetTn, arr.length)
    let c = 0
    for (let i = arr.length - Math.max(0, len); i < arr.length; i++) if (side === 'over' ? arr[i] <= B : arr[i] >= B) c += 1
    const state = st.armed ? (st.w > 0 ? 'fire' : 'armed') : c >= K ? 'armed' : c >= K - 2 ? 'warm' : 'idle'
    return { c: st.armed ? Math.max(c, K) : c, state, armed: st.armed }
  }
  const rOver = ringOf('over')
  const rUnder = ringOf('under')
  const openNow = Object.keys(openMap.current).length + pend.current.size
  const anyArmed = !pairOn && ((rOver.armed && sidesOn().includes('over')) || (rUnder.armed && sidesOn().includes('under')))
  const phase = !running ? 'idle' : paused.current ? 'paused' : openNow > 0 ? 'trading' : anyArmed ? 'armed' : lowOn && !okSyms.length ? 'waiting' : 'watching'
  const PHASE_TXT = { idle: 'IDLE', paused: 'RECONNECTING', trading: 'TRADE OPEN', armed: 'ARMED · waiting for the winning digit', waiting: 'WAITING · digit ' + lowD + ' is not the lowest anywhere', watching: pairOn ? 'PAIR MODE · buying pairs' : 'WATCHING' }
  const stakeL = Array.from({ length: Math.min(6, Math.max(1, Math.round(+cfg.steps || 1)) + 1) }, (_, i) => (pairOn ? stakeAt(i, 'over') + '+' + stakeAt(i, 'under') : stakeAt(i, 'over')))
  const nextStake = pairOn ? curStake('over') + ' + ' + curStake('under') : curStake('over')
  const bothLose = Array.from({ length: 10 }, (_, d) => d).filter((d) => !(d > ob) && !(d < ub))
  const bothWin = Array.from({ length: 10 }, (_, d) => d).filter((d) => d > ob && d < ub)
  const pctOf = (ds) => (sample.length ? (sample.filter((d) => ds.includes(d)).length / sn) * 100 : 0)
  const sideTxt = cfg.side === 'both' ? 'both sides' : cfg.side === 'over' ? 'Over only' : 'Under only'
  const wN = clamp(Math.round(+cfg.waitW || 1), 1, 5)
  const zone = (d) => (pairOn ? (d > ob && d < ub ? 'w' : d > ob ? 'w' : d < ub ? 'v' : 'u') : d <= ob && cfg.side !== 'under' ? 'u' : d >= ub && cfg.side !== 'over' ? 'o' : '')

  return (
    <div className="ou">
      <section className="ou-hero">
        <div className="ou-orb" />
        <div className="ou-head">
          <div className="ou-hl">
            <div className="ou-eye">OVER &amp; UNDER · CLUSTER HUNTER</div>
            <h2 className="ou-title">Spot it. Wait. Strike.</h2>
            <div className={'ou-pill ' + phase}><i />{PHASE_TXT[phase]}</div>
          </div>
          <div className={'ou-big ' + (lastD === undefined ? '' : zone(lastD))}>
            <b>{lastD === undefined ? '–' : lastD}</b>
            <small>last digit</small>
          </div>
        </div>
        <select className="ou-sel" value={wsym || ''} onChange={(e) => setWatch(e.target.value)}>
          {cfg.syms.map((v) => <option key={v} value={v}>{SYMN[v]}</option>)}
        </select>
        <div className="ou-strip">
          {Array.from({ length: 24 }, (_, i) => {
            const d = arr[arr.length - 24 + i]
            if (d === undefined) return <b key={i} className="x">·</b>
            return <b key={i} className={zone(d) + (i === 23 ? ' now' : '')}>{d}</b>
          })}
        </div>
        <div className="ou-leg">
          {pairOn ? (
            <>
              <span className="w">Over {ob} wins {ob + 1}-9</span>
              <span className="v">Under {ub} wins 0-{ub - 1}</span>
              {bothLose.length > 0 && <span className="u">{bothLose.join(', ')} loses both</span>}
            </>
          ) : (
            <>
              <span className="u">0-{ob} counts for Over {ob}</span>
              <span className="o">{ub}-9 counts for Under {ub}</span>
            </>
          )}
        </div>
      </section>

      <section className="ou-card">
        {pairOn ? (
          <>
            <div className="ou-h"><b>PAIR TRADE</b><span>both bought together</span></div>
            <div className="ou-pair">
              <div className="ou-leg2 o"><small>BUYS</small><b>OVER {ob}</b><span>wins on {ob + 1}-9</span><small>{sample.length ? pOverWin.toFixed(1) + '% of the last ' + sample.length : '…'}</small></div>
              <div className="ou-leg2 u"><small>BUYS</small><b>UNDER {ub}</b><span>wins on 0-{ub - 1}</span><small>{sample.length ? pUnderWin.toFixed(1) + '% of the last ' + sample.length : '…'}</small></div>
            </div>
            {bothLose.length > 0 && <div className="ou-both">Both lose on {bothLose.join(', ')}{sample.length ? ' · ' + pctOf(bothLose).toFixed(1) + '% of the last ' + sample.length + ' ticks' : ''}</div>}
            {bothWin.length > 0 && <div className="ou-both win">Both win on {bothWin.join(', ')}{sample.length ? ' · ' + pctOf(bothWin).toFixed(1) + '% of the last ' + sample.length + ' ticks' : ''}</div>}
            <div className="ou-note">The bot buys the Over and the Under at the same moment, one pair at a time. A pair counts as one trade.</div>
          </>
        ) : (
          <>
        <div className="ou-h"><b>SIGNAL RADAR</b><span>last {N} ticks</span></div>
        <div className="ou-rings">
          <Ring id="o" label={'Unders → Over ' + ob} sub={'digits 0-' + ob} n={rOver.c} k={K} state={rOver.state} off={cfg.side === 'under'} />
          <Ring id="u" label={'Overs → Under ' + ub} sub={'digits ' + ub + '-9'} n={rUnder.c} k={K} state={rUnder.state} off={cfg.side === 'over'} />
        </div>
        <div className="ou-note">
          {anyArmed
            ? 'Signal armed. The bot buys on the next winning digit' + (wN > 1 ? ' (' + wN + ' in a row)' : '') + '.'
            : 'When a ring fills up, the bot waits for a winning digit and then trades.'}
        </div>
          </>
        )}
      </section>

      <section className="ou-card">
        <div className="ou-h">
          <b>CIRCLES</b>
          <input type="number" min="20" max="1000" value={cfg.lw} onChange={(e) => setC({ lw: e.target.value })} aria-label="Ticks analysed" />
        </div>
        <div className="ou-circles">
          {cnt10.map((c, d) => {
            const p = (c / sn) * 100
            return (
              <div className="ou-cw" key={d}>
                <div className={'ou-c ' + cls(c) + (sample.length ? '' : ' empty')}>
                  <svg viewBox="0 0 64 64" aria-hidden="true">
                    <circle cx="32" cy="32" r="27" className="t" />
                    <circle cx="32" cy="32" r="27" className="p" strokeDasharray={2 * Math.PI * 27} strokeDashoffset={2 * Math.PI * 27 * (1 - clamp(p / 20, 0, 1))} transform="rotate(-90 32 32)" />
                  </svg>
                  <b>{d}</b>
                  <small>{sample.length ? p.toFixed(1) + '%' : '…'}</small>
                </div>
                <i className="ou-tri">{lastD === d ? '▲' : ''}</i>
              </div>
            )
          })}
        </div>
        <div className="ou-note">{arr.length < LW ? 'Loading ' + arr.length + '/' + LW + ' ticks…' : 'Last ' + LW + ' ticks'} · green most · blue 2nd · red least</div>
      </section>

      <section className="ou-card">
        <div className="ou-h"><b>LDP</b><span>last digit percentages · dashed line = 10%</span></div>
        <div className="ou-ldp">
          {cnt10.map((c, d) => {
            const p = (c / sn) * 100
            const top = Math.max(10.5, (maxC / sn) * 100 * 1.15)
            return (
              <div className={'col ' + zone(d)} key={d}>
                <small className="pv">{sample.length ? p.toFixed(1) : ''}</small>
                <div className="well" style={{ '--ref': (10 / top) * 100 + '%' }}><div className={'fill ' + cls(c)} style={{ height: Math.max(3, (p / top) * 100) + '%' }} /></div>
                <span className={'dg' + (lastD === d ? ' cur' : '')}>{d}</span>
              </div>
            )
          })}
        </div>
        <div className="ou-sum">
          <div><small>Over {ob} would win</small><b>{sample.length ? pOverWin.toFixed(1) + '%' : '–'}</b></div>
          <div><small>Under {ub} would win</small><b>{sample.length ? pUnderWin.toFixed(1) + '%' : '–'}</b></div>
          <div><small>Ticks</small><b>{sample.length}</b></div>
        </div>
      </section>

      <section className="ou-card">
        <div className="ou-h"><b>TRADE</b><span className={'ou-badge ' + phase}>{PHASE_TXT[phase].split(' ·')[0]}</span></div>
        <div className="ou-chips">
          {SYMS.map(([v, l]) => (
            <button key={v} className={cfg.syms.includes(v) ? 'on' : ''} disabled={running} onClick={() => togSym(v)}>{l}</button>
          ))}
        </div>
        <div className="ou-pick">
          <label>Pick the market automatically
            <select disabled={running} value={lowOn ? 'on' : 'off'} onChange={(e) => setC({ lowOn: e.target.value === 'on' })}>
              <option value="on">On: only where the digit below is the lowest</option>
              <option value="off">Off: trade every market I picked</option>
            </select>
          </label>
          {lowOn && (
            <label>Digit that must be the lowest
              <input type="number" min="0" max="9" disabled={running} value={cfg.lowD} onChange={(e) => setC({ lowD: e.target.value })} />
            </label>
          )}
          <button disabled={running} onClick={() => setC({ syms: SYMS.map((x) => x[0]) })}>Select all markets</button>
        </div>
        {lowOn && (
          <div className="ou-scan">
            {scan.map((x) => (
              <div key={x.sym} className={'r' + (x.ok ? ' ok' : '') + (running && x.sym === wsym ? ' act' : '')}>
                <span className="nm">{SYMN[x.sym]}</span>
                <span className="pc">{x.have >= x.L ? 'digit ' + lowD + ': ' + x.pct.toFixed(1) + '%' : 'loading ' + x.have + '/' + x.L}</span>
                <span className={'tg' + (x.ok ? ' g' : '')}>{x.have < x.L ? '…' : x.ok ? 'LOWEST' : 'not lowest'}</span>
              </div>
            ))}
            <div className="ou-note">{cfg.syms.length < 2 ? 'Pick two or more markets so the bot can switch between them. ' : ''}{okSyms.length ? 'The bot trades on ' + okSyms.map((x) => SYMN[x.sym]).join(', ') + ' while digit ' + lowD + ' is its lowest.' : 'No market has digit ' + lowD + ' as its lowest digit right now. The bot waits.'}</div>
          </div>
        )}
        <button className={'ou-go ' + (running ? 'stop' : '')} onClick={() => (running ? stopBot('') : start())}>
          {running ? 'STOP BOT' : 'START BOT'}
        </button>
        {msg && <div className="ou-note">{msg}</div>}
        <div className="ou-stats">
          <div><small>Net P/L</small><b className={stats.net >= 0 ? 'win' : 'loss'}>{stats.net >= 0 ? '+' : ''}{stats.net.toFixed(2)}</b></div>
          <div><small>Win / Loss</small><b>{stats.wins} / {stats.losses}</b></div>
          <div><small>Next stake</small><b>{nextStake}</b></div>
        </div>
        <div className="ou-note">Open {pairOn ? 'pairs' : 'trades'}: {openNow > 0 ? 1 : 0} / 1 · {pairOn ? 'pairs' : 'trades'} done {stats.trades}{+cfg.maxT > 0 ? ' of ' + cfg.maxT : ''}</div>
      </section>

      <section className="ou-card">
        <div className="ou-h"><b>STRATEGY</b><span>{sideTxt}</span></div>
        <div className="ou-seg two">
          {[['signal', 'Signal'], ['pair', 'Pair: Over + Under']].map(([k, l]) => (
            <button key={k} className={cfg.mode === k ? 'on' : ''} disabled={running} onClick={() => setC({ mode: k })}>{l}</button>
          ))}
        </div>
        {pairOn ? (
          <>
            <div className="ou-grid">
              <label>Over digit (0-8)
                <input type="number" min="0" max="8" disabled={running} value={cfg.pob} onChange={(e) => setC({ pob: e.target.value })} />
              </label>
              <label>Under digit (1-9)
                <input type="number" min="1" max="9" disabled={running} value={cfg.pub} onChange={(e) => setC({ pub: e.target.value })} />
              </label>
              <label>Contract length (ticks)
                <input type="number" min="1" max="10" disabled={running} value={cfg.dur} onChange={(e) => setC({ dur: e.target.value })} />
              </label>
              <label>Skip ticks between pairs (0 = none)
                <input type="number" min="0" max="50" disabled={running} value={cfg.pgap} onChange={(e) => setC({ pgap: e.target.value })} />
              </label>
            </div>
            <div className="ou-how">
              <b>How it trades</b>
              <span>As soon as the last pair has finished, the bot buys <em>Over {ob}</em> and <em>Under {ub}</em> at the same moment, one pair after another.</span>
              <span>Over {ob} wins on {ob + 1}-9 and Under {ub} wins on 0-{ub - 1}.{bothLose.length ? ' A ' + bothLose.join(' or ') + ' loses both.' : ''}{bothWin.length ? ' A ' + bothWin.join(' or ') + ' wins both.' : ''}</span>
              <span>The pair counts as a win when the two results together are zero or more. It stops after the number of pairs you set.</span>
            </div>
          </>
        ) : (
          <>
        <div className="ou-seg">
          {[['both', 'Both'], ['over', 'Over'], ['under', 'Under']].map(([k, l]) => (
            <button key={k} className={cfg.side === k ? 'on' : ''} disabled={running} onClick={() => setC({ side: k })}>{l}</button>
          ))}
        </div>
        <div className="ou-grid">
          <label>Look at the last (ticks)
            <input type="number" min="20" max="500" disabled={running} value={cfg.win} onChange={(e) => setC({ win: e.target.value })} />
          </label>
          <label>Signal when this many (count)
            <input type="number" min="2" max="500" disabled={running} value={cfg.cnt} onChange={(e) => setC({ cnt: e.target.value })} />
          </label>
          <label>Over digit (0-8)
            <input type="number" min="0" max="8" disabled={running} value={cfg.ob} onChange={(e) => setC({ ob: e.target.value })} />
          </label>
          <label>Under digit (1-9)
            <input type="number" min="1" max="9" disabled={running} value={cfg.ub} onChange={(e) => setC({ ub: e.target.value })} />
          </label>
          <label>Winning digits to wait for
            <input type="number" min="1" max="5" disabled={running} value={cfg.waitW} onChange={(e) => setC({ waitW: e.target.value })} />
          </label>
          <label>Contract length (ticks)
            <input type="number" min="1" max="10" disabled={running} value={cfg.dur} onChange={(e) => setC({ dur: e.target.value })} />
          </label>
        </div>
        <div className="ou-how">
          <b>How it trades</b>
          <span>If {K} of the last {N} ticks are 0-{ob}, wait for {wN > 1 ? wN + ' winning digits in a row' : 'a winning digit'} (above {ob}), then buy <em>Over {ob}</em>.</span>
          <span>If {K} of the last {N} ticks are {ub}-9, wait for {wN > 1 ? wN + ' winning digits in a row' : 'a winning digit'} (below {ub}), then buy <em>Under {ub}</em>.</span>
          <span>After a trade the count starts again, so each signal needs {K} fresh ticks.</span>
        </div>
          </>
        )}
      </section>

      <section className="ou-card">
        <div className="ou-h"><b>STAKE &amp; RISK</b></div>
        <div className="ou-grid">
          <label>{pairOn ? 'Over stake' : 'Stake'}
            <input type="number" min="0.35" step="0.05" disabled={running} value={cfg.stake} onChange={(e) => setC({ stake: e.target.value })} />
          </label>
          {pairOn && (
            <label>Under stake
              <input type="number" min="0.35" step="0.05" disabled={running} value={cfg.ustake} onChange={(e) => setC({ ustake: e.target.value })} />
            </label>
          )}
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
                <input type="number" min="1" max="10" step="0.1" disabled={running} value={cfg.mult} onChange={(e) => setC({ mult: e.target.value })} />
              </label>
              <label>Recovery steps
                <input type="number" min="1" max="8" disabled={running} value={cfg.steps} onChange={(e) => setC({ steps: e.target.value })} />
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
          <label>{pairOn ? 'Stop after pairs (0 = off)' : 'Stop after trades (0 = off)'}
            <input type="number" min="0" max="1000" disabled={running} value={cfg.maxT} onChange={(e) => setC({ maxT: e.target.value })} />
          </label>
          <label>{pairOn ? 'Stop after lost pairs (0 = off)' : 'Stop after losses (0 = off)'}
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
