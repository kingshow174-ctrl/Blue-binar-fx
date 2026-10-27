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
const LETTERS = 'ABCDEFGHIJKL'
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const DEF_LADDER = [
  { stake: 0.35, runs: 1 }, { stake: 1, runs: 4 }, { stake: 3.75, runs: 4 },
  { stake: 14.05, runs: 4 }, { stake: 52.7, runs: 4 },
]
const DEF = {
  syms: ['R_100'], mode: 'every', dur: 1, target: 'last', fixed: 5, same: 2, lock: true,
  rec: true, ladder: DEF_LADDER, end: 'restart', sl: 20, tp: 10, instant: true,
  cbase: 0.35, cmult: 11, cdiv: 4, csteps: 4, cmode: 'cum', cround: 0.05, cauto: true,
}
const loadCfg = () => {
  try { return { ...DEF, ...JSON.parse(localStorage.bbfx_differ || '{}') } } catch (e) { return DEF }
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
// stake calculator: each recovery stake = losses x multiply / divide by
const calcStakes = (c) => {
  const base = Math.max(0.35, Number(c.cbase) || 0.35)
  const mult = Number(c.cmult) || 11
  const div = Math.max(1, Number(c.cdiv) || 1)
  const steps = clamp(Math.round(Number(c.csteps) || 1), 1, 11)
  const rnd = Number(c.cround) || 0.05
  const up = (v) => Math.max(0.35, Math.round(Math.ceil(v / rnd - 1e-9) * rnd * 100) / 100)
  const out = [Math.round(base * 100) / 100]
  let cum = out[0]
  for (let i = 0; i < steps; i++) {
    const next = up((c.cmode === 'prev' ? out[out.length - 1] : cum) * mult / div)
    out.push(next)
    cum += next
  }
  return out
}

export default function Differ({ tradeOn, send, cur, demo, addHist, updHist }) {
  const [cfg, setCfg] = useState(loadCfg)
  const [running, setRunning] = useState(false)
  const [stats, setStats] = useState({ net: 0, trades: 0, wins: 0, losses: 0, idx: 0, w: 0 })
  const [log, setLog] = useState([])
  const [msg, setMsg] = useState('')
  const [watch, setWatch] = useState('')
  const [mini, setMini] = useState({})
  const [ladderOpen, setLadderOpen] = useState(true)
  const [calcOpen, setCalcOpen] = useState(true)
  const [, force] = useState(0)

  const cfgRef = useRef(cfg)
  const runRef = useRef(false)
  const levelRef = useRef(0)
  const winsRef = useRef(0)
  const netRef = useRef(0)
  const errs = useRef(0)
  const digs = useRef({})
  const pip = useRef({})
  const reqs = useRef({})
  const pend = useRef(new Set())
  const openMap = useRef({})
  const armReq = useRef({})
  const armLatest = useRef({})
  const armedP = useRef({})
  const armTs = useRef({})
  const armErr = useRef({})
  const armTries = useRef({})
  const seq = useRef(900000)
  const raf = useRef(0)
  const holds = useRef(0)
  const tickAt = useRef({})
  const paused = useRef(false)
  const pauseTimer = useRef(null)
  const pollAt = useRef({})
  const settled = useRef({})
  const tb = useRef({})
  const lastEp = useRef({})
  const pt = useRef({})
  const recLock = useRef(null)
  const sendRef = useRef(send)
  const tradeOnRef = useRef(tradeOn)
  const curRef = useRef(cur)
  const helpers = useRef({})
  cfgRef.current = cfg
  sendRef.current = send
  tradeOnRef.current = tradeOn
  curRef.current = cur
  helpers.current = { addHist, updHist }

  useEffect(() => { localStorage.bbfx_differ = JSON.stringify(cfg) }, [cfg])
  const setC = (p) => setCfg((c) => ({ ...c, ...p }))
  const ladder = cfg.ladder || DEF_LADDER
  const setMain = (v) => setCfg((c) => ({
    ...c, cbase: v, ladder: (c.ladder || DEF_LADDER).map((b, i) => (i === 0 ? { ...b, stake: v } : b)),
  }))
  const setBlock = (i, p) => setC({ ladder: ladder.map((b, j) => (j === i ? { ...b, ...p } : b)) })
  const addBlock = () => {
    const last = Number(ladder[ladder.length - 1].stake) || 1
    setC({ ladder: [...ladder, { stake: Math.round(last * 3.5 * 100) / 100, runs: 4 }] })
  }
  const delBlock = (i) => { setC({ ladder: ladder.filter((_, j) => j !== i) }); setMini({}) }

  // stake calculator: write the calculated stakes into the recovery blocks
  const applyCalc = () => {
    const c0 = cfgRef.current
    const l = calcStakes(c0)
    const div = Math.max(1, Math.round(Number(c0.cdiv) || 1))
    setCfg((c) => ({ ...c, ladder: l.map((v, i) => ({ stake: v, runs: i === 0 ? 1 : div })) }))
  }
  const calcKey = [cfg.cbase, cfg.cmult, cfg.cdiv, cfg.csteps, cfg.cmode, cfg.cround].join('|')
  const calcFirst = useRef(true)
  useEffect(() => {
    if (calcFirst.current) { calcFirst.current = false; return }
    if (!cfgRef.current.cauto || !cfgRef.current.rec || runRef.current) return
    applyCalc()
  }, [calcKey])

  const addLog = (t) => setLog((l) => [t, ...l].slice(0, 14))
  const bump = () => {
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      force((x) => x + 1)
    })
  }
  const ladderList = () => {
    const l = (cfgRef.current.ladder || [])
      .map((b) => ({ stake: Number(b.stake), runs: Math.max(1, Math.round(Number(b.runs) || 1)) }))
      .filter((b) => isFinite(b.stake) && b.stake >= 0.35)
    return l.length ? l : DEF_LADDER
  }
  const inRecovery = () => !!cfgRef.current.rec && levelRef.current > 0
  const curStake = () => {
    const L = ladderList()
    if (!cfgRef.current.rec) return L[0].stake
    return L[Math.min(levelRef.current, L.length - 1)].stake
  }
  const keyOf = (barrier, stake) => [barrier, +cfgRef.current.dur || 1, stake, curRef.current].join('|')
  const keyOfMeta = (m) => [m.barrier, m.dur, m.stake, curRef.current].join('|')
  const slots = () => Object.keys(openMap.current).length + pend.current.size + holds.current
  const forget = (id) => { if (id) sendRef.current({ forget: id }) }

  const stopBot = (why) => {
    paused.current = false
    clearTimeout(pauseTimer.current)
    runRef.current = false
    recLock.current = null
    setRunning(false)
    Object.values(armedP.current).forEach((map) => Object.values(map).forEach((a) => forget(a.subId)))
    armedP.current = {}
    armLatest.current = {}
    pend.current.clear()
    setMsg(why ? '■ ' + why : 'Stopped')
    if (why) addLog('■ ' + why)
  }

  // ---------- ready-to-buy prices ----------
  const neededStakes = () => {
    const c = cfgRef.current
    const L = ladderList()
    const i = c.rec ? Math.min(levelRef.current, L.length - 1) : 0
    const out = [L[i].stake]
    if (c.rec && i + 1 < L.length && (c.mode === 'pattern' || c.syms.length === 1)) out.push(L[i + 1].stake)
    return [...new Set(out)]
  }
  const wantList = () => {
    const c = cfgRef.current
    const stakes = neededStakes()
    const ALL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    const digitsFor = (sym) => {
      if (c.mode === 'every') return c.target === 'fixed' ? [clamp(Math.round(+c.fixed || 0), 0, 9)] : ALL
      if (inRecovery()) {
        const lk = recLock.current
        return c.lock === false || (lk && lk.sym === sym) ? ALL : []
      }
      const st = pt.current[sym]
      return st && st.armed ? [st.x] : []
    }
    let out = []
    c.syms.forEach((sym) => digitsFor(sym).forEach((b) => stakes.forEach((stake) => {
      out.push({ sym, barrier: b, stake, k: keyOf(b, stake) })
    })))
    if (out.length > 50) out = out.filter((x) => x.stake === stakes[0])
    return out.slice(0, 50)
  }
  const armOne = (sym, barrier, stake, key) => {
    const rid = ++seq.current
    armReq.current[rid] = { sym, key }
    armLatest.current[sym + '|' + key] = rid
    sendRef.current({
      proposal: 1, subscribe: 1, req_id: rid, amount: stake, basis: 'stake',
      contract_type: 'DIGITDIFF', currency: curRef.current || 'USD', duration: +cfgRef.current.dur || 1,
      duration_unit: 't', underlying_symbol: sym, barrier: String(barrier),
    })
  }
  const ensureArmed = (sym) => {
    if (!runRef.current || !tradeOnRef.current) return
    const want = wantList().filter((w) => w.sym === sym)
    const map = (armedP.current[sym] = armedP.current[sym] || {})
    const wantKeys = new Set(want.map((w) => w.k))
    Object.keys(map).forEach((k) => {
      if (!wantKeys.has(k)) {
        forget(map[k].subId)
        delete armLatest.current[sym + '|' + k]
        delete map[k]
      }
    })
    want.forEach((w) => {
      if (map[w.k]) return
      const slot = sym + '|' + w.k
      if (Date.now() - (armTs.current[slot] || 0) < 3000) return
      armTs.current[slot] = Date.now()
      armOne(sym, w.barrier, w.stake, w.k)
    })
  }
  const ensureAll = () => cfgRef.current.syms.forEach(ensureArmed)
  const rearm = (sym) => {
    Object.keys(armTs.current).forEach((x) => { if (x.startsWith(sym + '|')) armTs.current[x] = 0 })
    ensureArmed(sym)
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
      contract_type: 'DIGITDIFF', currency: curRef.current || 'USD', duration: meta.dur,
      duration_unit: 't', underlying_symbol: meta.sym, barrier: String(meta.barrier),
    })
  }

  const fire = (sym, barrier) => {
    const c = cfgRef.current
    if (slots() >= 1) return false
    const stake = curStake()
    if (netRef.current - stake <= -Math.abs(+c.sl)) {
      stopBot('Next stake ' + stake + ' could pass your stop loss, stopped')
      return false
    }
    const meta = {
      sym, stake, type: 'DIGITDIFF', barrier, dur: +c.dur || 1,
      tag: c.rec ? LETTERS[Math.min(levelRef.current, 11)] : 'A',
    }
    meta.t0 = Date.now()
    meta.trig = (digs.current[sym] || []).slice(-3).join('')
    const key = keyOf(barrier, stake)
    const map = (armedP.current[sym] = armedP.current[sym] || {})
    const a = map[key]
    if (a && a.id) {
      delete map[key]
      delete armLatest.current[sym + '|' + key]
      sendBuy(meta, a.id, a.ask, a.subId, true, false)
    } else {
      slow(meta, false)
    }
    return true
  }

  // pattern tracker: the same digit 2+ times in a row, then a different digit
  const patStep = (sym, d, K) => {
    const st = pt.current[sym] || (pt.current[sym] = { x: null, n: 0, armed: false })
    let ready = null
    let armedNow = false
    if (st.x === d) {
      st.n += 1
      if (st.n >= K && !st.armed) { st.armed = true; armedNow = true }
    } else {
      if (st.armed) ready = st.x
      st.x = d
      st.n = 1
      st.armed = false
    }
    return { ready, armedNow }
  }

  // runs on every tick, before any screen redraw
  const evalTick = (sym) => {
    if (!runRef.current || !tradeOnRef.current) return
    const c = cfgRef.current
    const a = digs.current[sym] || []
    if (!a.length) return
    const d = a[a.length - 1]
    if (!inRecovery()) recLock.current = null
    let ready = null
    if (c.mode === 'pattern') {
      const r = patStep(sym, d, clamp(Math.round(+c.same || 2), 2, 10))
      ready = r.ready
      if (r.armedNow) ensureArmed(sym)
    }
    if (slots() >= 1) return
    if (c.mode === 'every') {
      fire(sym, c.target === 'fixed' ? clamp(Math.round(+c.fixed || 0), 0, 9) : d)
      return
    }
    if (inRecovery()) {
      if (c.lock !== false) {
        if (!recLock.current) recLock.current = { sym }
        if (recLock.current.sym !== sym) return
      }
      fire(sym, d)
      return
    }
    if (ready !== null) fire(sym, ready)
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
    const cf = cfgRef.current
    const wasRec = inRecovery()
    netRef.current += profit
    let lvl = levelRef.current
    let w = winsRef.current
    let note = ''
    let endStop = false
    if (cf.rec) {
      const L = ladderList()
      if (profit >= 0) {
        if (lvl > 0) {
          w += 1
          const need = L[Math.min(lvl, L.length - 1)].runs
          if (w >= need) { note = ' · recovered, back to A'; lvl = 0; w = 0 }
          else note = ' · ' + LETTERS[lvl] + ' ' + w + '/' + need
        }
      } else {
        lvl += 1
        w = 0
        if (lvl >= L.length) {
          if (cf.end === 'stop') endStop = true
          lvl = 0
          note = ' · ladder finished'
        } else note = ' · jump to ' + LETTERS[lvl]
      }
    }
    levelRef.current = lvl
    winsRef.current = w
    const live = runRef.current
    if (cf.mode === 'pattern' && !wasRec && inRecovery() && cf.lock !== false) recLock.current = { sym: o.meta.sym }
    setStats((st) => ({
      net: netRef.current, trades: st.trades + 1, wins: st.wins + (profit >= 0 ? 1 : 0),
      losses: st.losses + (profit < 0 ? 1 : 0), idx: lvl, w,
    }))
    addLog(
      (profit >= 0 ? '✅ ' : '❌ ') + o.meta.tag + ' ' + SYMN[o.meta.sym] + ' Differs ' + o.meta.barrier +
      ' · stake ' + o.meta.stake + (o.meta.trig ? ' · digits ' + o.meta.trig : '') +
      (ex == null || Number.isNaN(ex) ? '' : ' · exit ' + ex) + (o.lat != null ? ' · ' + o.lat + 'ms' : '') +
      ' · ' + (profit >= 0 ? '+' : '') + profit.toFixed(2) + note + ' → next stake ' + curStake()
    )
    if (!live) return
    if (netRef.current <= -Math.abs(+cf.sl)) return stopBot('Stop loss reached')
    if (+cf.tp > 0 && netRef.current >= +cf.tp) return stopBot('Take profit reached')
    if (endStop) return stopBot('Reached the end of the ladder')
    ensureAll()
  }

  // ---------- instant results from the tick feed ----------
  const tryTick = (o, id, ep, d) => {
    if (cfgRef.current.instant === false) return
    if (o.noProv || !o.pt || !(o.payout > 0) || !(o.cost > 0)) return
    if (!(Number(ep) > o.pt)) return
    if (o.seen === 0 && Number(ep) - o.pt > 6) { o.noProv = true; return }
    o.seen += 1
    if (o.seen < (o.meta.dur || 1)) return
    const win = d !== o.meta.barrier
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
    if (flip) addLog('⚠ Deriv corrected ' + sm.meta.tag + ' ' + SYMN[sm.meta.sym] + ' to ' + (real >= 0 ? 'WIN ' : 'LOSS ') + real.toFixed(2))
    if (!runRef.current) return
    const c2 = cfgRef.current
    if (netRef.current <= -Math.abs(+c2.sl)) stopBot('Stop loss reached')
    else if (+c2.tp > 0 && netRef.current >= +c2.tp) stopBot('Take profit reached')
  }

  // ---------- messages from the trading socket ----------
  useEffect(() => {
    const already = (e) => e.code === 'AlreadySubscribed' || /already subscribed/i.test(e.message || '')
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
      if (!rid || rid < 900000) return

      const ar = armReq.current[rid]
      if (ar) {
        const slot = ar.sym + '|' + ar.key
        if (m.error) {
          if (already(m.error)) {
            const n = (armTries.current[slot] || 0) + 1
            armTries.current[slot] = n
            if (n <= 5) setTimeout(() => rearm(ar.sym), 600)
            return
          }
          if (armErr.current[ar.sym] !== m.error.message) {
            armErr.current[ar.sym] = m.error.message
            addLog('⚠ ' + SYMN[ar.sym] + ': ' + m.error.message)
          }
          return
        }
        if (m.msg_type === 'proposal') {
          if (!runRef.current || armLatest.current[slot] !== rid) {
            if (m.subscription) forget(m.subscription.id)
            return
          }
          const map = (armedP.current[ar.sym] = armedP.current[ar.sym] || {})
          const old = map[ar.key]
          if (old && old.subId && m.subscription && old.subId !== m.subscription.id) forget(old.subId)
          armErr.current[ar.sym] = ''
          armTries.current[slot] = 0
          map[ar.key] = { id: m.proposal.id, ask: m.proposal.ask_price, subId: m.subscription && m.subscription.id }
        }
        return
      }

      const r = reqs.current[rid]
      if (!r) return
      if (m.error) {
        if (r.kind === 'proposal' && already(m.error) && (r.meta.tries || 0) < 4) {
          pend.current.delete(rid)
          holds.current += 1
          r.meta.tries = (r.meta.tries || 0) + 1
          setTimeout(() => {
            holds.current -= 1
            if (runRef.current) slow(r.meta, r.retried)
          }, 450)
          return
        }
        pend.current.delete(rid)
        if (r.kind === 'buy' && r.armed && !r.retried) {
          addLog('Fast price expired, retrying')
          const k = keyOfMeta(r.meta)
          const map = armedP.current[r.meta.sym]
          if (map && map[k]) { forget(map[k].subId); delete map[k] }
          delete armLatest.current[r.meta.sym + '|' + k]
          armTs.current[r.meta.sym + '|' + k] = 0
          ensureArmed(r.meta.sym)
          slow(r.meta, true)
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
        rearm(r.meta.sym)
        replayTicks(String(id))
        bump()
      }
    }
    bus.fns.add(h)
    return () => bus.fns.delete(h)
  }, [])

  // ---------- watchdog: poll overdue results, keep prices ready ----------
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
      ensureAll()
    }, 2000)
    return () => clearInterval(t)
  }, [running])

  // ---------- tick monitor for the selected markets ----------
  useEffect(() => {
    const syms = cfg.syms
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
          sock.send(JSON.stringify({ ticks_history: sym, count: 60, end: 'latest', style: 'ticks' }))
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
          digs.current[sym] = (hh.prices || []).map((p) => +Number(p).toFixed(pp).slice(-1)).slice(-60)
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
          digs.current[sym] = [...(digs.current[sym] || []).slice(-59), d]
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
  }, [cfg.syms.join(',')])

  // pause when the trading connection drops, resume by itself
  useEffect(() => {
    if (!runRef.current) return
    if (!tradeOn) {
      paused.current = true
      pend.current.clear()
      armedP.current = {}
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
      ensureAll()
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
    if (!c.syms.length) return setMsg('Pick at least one market')
    if (c.mode === 'every' && c.target === 'fixed' && !(+c.fixed >= 0 && +c.fixed <= 9)) return setMsg('Fixed digit must be 0 to 9')
    const lad = c.ladder || []
    if (!lad.length || !(Number(lad[0].stake) >= 0.35)) return setMsg('Main stake must be at least 0.35')
    if (c.rec) {
      const bad = lad.findIndex((b) => !(Number(b.stake) >= 0.35))
      if (bad >= 0) return setMsg('Block ' + LETTERS[bad] + ' needs a stake of at least 0.35')
      if (lad.length < 2) return setMsg('Add at least one recovery block (B) or turn recovery off')
    }
    if (!(+c.sl > 0)) return setMsg('Set a stop loss above 0')
    if (!demo && !confirm('REAL account. The bot will place trades automatically with real money. Start?')) return
    netRef.current = 0
    levelRef.current = 0
    winsRef.current = 0
    errs.current = 0
    pt.current = {}
    recLock.current = null
    pend.current.clear()
    armedP.current = {}
    armLatest.current = {}
    armTs.current = {}
    armErr.current = {}
    armTries.current = {}
    setStats({ net: 0, trades: 0, wins: 0, losses: 0, idx: 0, w: 0 })
    paused.current = false
    runRef.current = true
    setRunning(true)
    setMsg('Running')
    ensureAll()
  }

  const togSym = (v) =>
    setC({ syms: cfg.syms.includes(v) ? cfg.syms.filter((x) => x !== v) : [...cfg.syms, v] })

  const wsym = cfg.syms.includes(watch) ? watch : cfg.syms[0]
  const arr = (wsym && digs.current[wsym]) || []
  const lad = ladderList()
  const recNow = !!cfg.rec && stats.idx > 0
  const stakeNow = cfg.rec ? lad[Math.min(stats.idx, lad.length - 1)].stake : lad[0].stake
  const openNow = Object.keys(openMap.current).length + pend.current.size
  const calcList = calcStakes(cfg)
  const calcTotal = calcList.reduce((x, y) => x + y, 0)
  const calcSl = Math.abs(+cfg.sl || 0)
  let calcReach = 0
  let calcCum = 0
  for (let i = 0; i < calcList.length; i++) {
    if (calcCum + calcList[i] < calcSl) calcReach = i
    else break
    calcCum += calcList[i]
  }

  return (
    <>
      <section className="card">
        <div className="pcthead">
          <b>DIFFER</b>
          <span className={'badge ' + (running ? 'on' : '')}>{running ? (cfg.mode === 'every' ? 'EVERY TICK' : 'PATTERN') : 'stopped'}</span>
        </div>
        <select value={wsym || ''} onChange={(e) => setWatch(e.target.value)} disabled={!cfg.syms.length}>
          {cfg.syms.map((v) => <option key={v} value={v}>{SYMN[v]}</option>)}
        </select>
        <div className="osu">
          {Array.from({ length: 30 }, (_, i) => {
            const d = arr[arr.length - 1 - i]
            if (d === undefined) return <b key={i} className="x">·</b>
            const prev = arr[arr.length - 2 - i]
            const c = prev === undefined ? 'b' : d === prev ? 'r' : 'g'
            return <b key={i} className={c + (i === 0 ? ' new' : '')}>{d}</b>
          })}
        </div>
        <div className="muted">Newest top-left · green: differs from the digit before it · red: repeats it</div>
      </section>

      <section className="card">
        <button className={'buy ' + (running ? 'odd' : 'even')} onClick={running ? () => stopBot('Stopped by you') : start}>
          {running ? 'STOP' : 'START'}
        </button>
        {msg && <div className="muted">{msg}</div>}
        <div className="sum">
          <div><small>Net P/L</small><b className={stats.net >= 0 ? 'win' : 'loss'}>{stats.net >= 0 ? '+' : ''}{stats.net.toFixed(2)}</b></div>
          <div><small>Win / Loss</small><b>{stats.wins} / {stats.losses}</b></div>
          <div><small>{cfg.rec ? 'Block ' + LETTERS[Math.min(stats.idx, 11)] + ' stake' : 'Stake'}</small><b>{stakeNow}</b></div>
        </div>
        {running && <div className="muted">Open trades: {openNow} / 1{recNow ? ' · recovering' : ''}</div>}
      </section>

      <section className="card">
        <b>How it trades</b>
        <label>Mode
          <select disabled={running} value={cfg.mode} onChange={(e) => setC({ mode: e.target.value })}>
            <option value="every">Differ every tick</option>
            <option value="pattern">Pattern: 2+ same digit, wait for a winning differ</option>
          </select>
        </label>
        {cfg.mode === 'every' ? (
          <>
            <div className="row">
              <label>Differ which digit
                <select disabled={running} value={cfg.target} onChange={(e) => setC({ target: e.target.value })}>
                  <option value="last">The digit that just appeared</option>
                  <option value="fixed">One fixed digit</option>
                </select>
              </label>
              {cfg.target === 'fixed' && (
                <label>Fixed digit
                  <input type="number" min="0" max="9" disabled={running} value={cfg.fixed} onChange={(e) => setC({ fixed: e.target.value })} />
                </label>
              )}
            </div>
            <div className="muted">Trades Differs on every tick, one trade at a time.</div>
          </>
        ) : (
          <>
            <div className="row">
              <label>Same digit in a row (min)
                <input type="number" min="2" max="10" disabled={running} value={cfg.same} onChange={(e) => setC({ same: e.target.value })} />
              </label>
              <label>Stay on the same market in recovery
                <select disabled={running} value={cfg.lock === false ? 'off' : 'on'} onChange={(e) => setC({ lock: e.target.value === 'on' })}>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </label>
            </div>
            <div className="muted">
              When a market shows the same digit {cfg.same || 2}+ times in a row, wait for a winning differ (a different digit), then trade Differs on the repeated digit. After a loss, recovery trades Differs on every digit{cfg.lock === false ? '' : ', on the same market,'} until it recovers.
            </div>
          </>
        )}
        <label>Ticks per trade
          <input type="number" min="1" max="10" disabled={running} value={cfg.dur} onChange={(e) => setC({ dur: e.target.value })} />
        </label>
      </section>

      <section className="card">
        <b>Stake and recovery</b>
        <div className="row">
          <label>Main stake
            <input type="number" min="0.35" step="0.05" disabled={running} value={cfg.cbase} onChange={(e) => setMain(e.target.value)} />
          </label>
          <label>Recovery
            <select disabled={running} value={cfg.rec ? 'on' : 'off'} onChange={(e) => setC({ rec: e.target.value === 'on' })}>
              <option value="on">On</option>
              <option value="off">Off (fixed stake)</option>
            </select>
          </label>
        </div>
        {!cfg.rec && <div className="muted">Recovery is off, so every trade uses the main stake.</div>}
      </section>

      {cfg.rec && (
        <section className="card">
          <div className="pcthead">
            <b>STAKE CALCULATOR</b>
            <button className="smallbtn" onClick={() => setCalcOpen((o) => !o)}>{calcOpen ? 'Minimise' : 'Expand'}</button>
          </div>
          {calcOpen && (
            <>
              <div className="muted">Each recovery stake = losses so far × multiply by ÷ divide by (the wins to recover).</div>
              <div className="row">
                <label>Multiply by
                  <input type="number" min="1" step="0.5" disabled={running} value={cfg.cmult} onChange={(e) => setC({ cmult: e.target.value })} />
                </label>
                <label>Divide by (wins to recover)
                  <input type="number" min="1" max="50" disabled={running} value={cfg.cdiv} onChange={(e) => setC({ cdiv: e.target.value })} />
                </label>
              </div>
              <div className="row">
                <label>Recovery steps
                  <input type="number" min="1" max="11" disabled={running} value={cfg.csteps} onChange={(e) => setC({ csteps: e.target.value })} />
                </label>
                <label>Round up to
                  <select disabled={running} value={String(cfg.cround)} onChange={(e) => setC({ cround: +e.target.value })}>
                    {[0.01, 0.05, 0.1, 0.5, 1].map((n) => <option key={n} value={String(n)}>{n}</option>)}
                  </select>
                </label>
              </div>
              <label>Count losses
                <select disabled={running} value={cfg.cmode} onChange={(e) => setC({ cmode: e.target.value })}>
                  <option value="cum">All losses so far</option>
                  <option value="prev">Last stake only</option>
                </select>
              </label>
              <div className="calcrow">
                {calcList.map((v, i) => <span key={i} className="cchip"><b>{LETTERS[i]}</b>{v.toFixed(2)}</span>)}
              </div>
              <div className="muted">
                If every step loses you are down {calcTotal.toFixed(2)}. With your stop loss of {calcSl} the bot can reach block {LETTERS[calcReach]} (stake {calcList[calcReach].toFixed(2)}).
              </div>
              <div className="row">
                <label>Auto-update blocks
                  <select disabled={running} value={cfg.cauto ? 'on' : 'off'} onChange={(e) => setC({ cauto: e.target.value === 'on' })}>
                    <option value="on">On</option>
                    <option value="off">Off: only when I tap Apply</option>
                  </select>
                </label>
                <button disabled={running} onClick={applyCalc}>Apply now</button>
              </div>
            </>
          )}
        </section>
      )}

      {cfg.rec && (
        <section className="card">
          <div className="pcthead">
            <b>RECOVERY BLOCKS</b>
            <button className="smallbtn" onClick={() => setLadderOpen((o) => !o)}>{ladderOpen ? 'Minimise' : 'Expand'}</button>
          </div>
          {ladderOpen && (
            <>
              <div className="muted">
                A is your main stake. After a loss the bot jumps to the next block and trades its stake until it has won the "times to recover" number, then returns to A. A loss inside a block jumps to the next one.
              </div>
              {ladder.map((b, i) => {
                const col = !!mini[i]
                const liveB = running && stats.idx === i
                return (
                  <div className={'lblock' + (liveB ? ' live' : '')} key={i}>
                    <div className="lhead" onClick={() => setMini((m) => ({ ...m, [i]: !m[i] }))}>
                      <b>{LETTERS[i]}</b>
                      <span className="lt">
                        {i === 0 ? 'Main ' : 'Recover '}{b.stake}
                        {i > 0 ? ' × ' + b.runs + ' wins' : ''}
                        {liveB && i > 0 ? ' · ' + stats.w + '/' + b.runs : ''}
                      </span>
                      <span>{col ? '▸' : '▾'}</span>
                    </div>
                    {!col && (
                      <>
                        <div className="row">
                          <label>Stake
                            <input type="number" min="0.35" step="0.05" disabled={running} value={b.stake} onChange={(e) => (i === 0 ? setMain(e.target.value) : setBlock(i, { stake: e.target.value }))} />
                          </label>
                          <label>Times to recover
                            {i === 0
                              ? <input disabled readOnly value="main" />
                              : <input type="number" min="1" max="50" disabled={running} value={b.runs} onChange={(e) => setBlock(i, { runs: e.target.value })} />}
                          </label>
                        </div>
                        {i >= 2 && !running && <button onClick={() => delBlock(i)}>Remove {LETTERS[i]}</button>}
                      </>
                    )}
                  </div>
                )
              })}
              <div className="row">
                <button disabled={running || ladder.length >= 12} onClick={addBlock}>+ Add block</button>
                <button onClick={() => setMini(Object.fromEntries(ladder.map((_, i) => [i, true])))}>Minimise all</button>
              </div>
              <div className="muted">Each step up risks more money. The bot stops instead of placing a stake that could pass your stop loss.</div>
            </>
          )}
        </section>
      )}

      <section className="card">
        <b>Risk and speed</b>
        <div className="row">
          <label>Stop loss
            <input type="number" min="0" step="0.5" disabled={running} value={cfg.sl} onChange={(e) => setC({ sl: e.target.value })} />
          </label>
          <label>Take profit (0 = off)
            <input type="number" min="0" step="0.5" disabled={running} value={cfg.tp} onChange={(e) => setC({ tp: e.target.value })} />
          </label>
        </div>
        {cfg.rec && (
          <label>After the last block loses
            <select disabled={running} value={cfg.end} onChange={(e) => setC({ end: e.target.value })}>
              <option value="restart">Restart at A</option>
              <option value="stop">Stop the bot</option>
            </select>
          </label>
        )}
        <label>Result speed
          <select disabled={running} value={cfg.instant === false ? 'off' : 'on'} onChange={(e) => setC({ instant: e.target.value === 'on' })}>
            <option value="on">Instant: settle on the exit tick, Deriv confirms</option>
            <option value="off">Safe: wait for Deriv's result</option>
          </select>
        </label>
      </section>

      <section className="card">
        <b>Markets</b>
        <div className="chips">
          {SYMS.map(([v, l]) => (
            <button key={v} disabled={running} className={cfg.syms.includes(v) ? 'on' : ''} onClick={() => togSym(v)}>{l}</button>
          ))}
        </div>
        {cfg.syms.map((sym) => {
          const a = digs.current[sym] || []
          const p = pt.current[sym]
          let label = 'stopped'
          if (running) {
            if (cfg.mode === 'every') label = 'every tick'
            else if (recNow && cfg.lock !== false && recLock.current) label = recLock.current.sym === sym ? 'LOCKED' : 'paused'
            else if (p && p.armed) label = 'ARMED ' + p.x
            else if (p && p.n >= 2) label = p.x + ' ×' + p.n
            else label = 'waiting'
          }
          return (
            <div className="mrow" key={sym} style={{ gridTemplateColumns: '1fr 36px 110px' }}>
              <button className={'sname' + (sym === wsym ? ' sel' : '')} onClick={() => setWatch(sym)}>{SYMN[sym]}</button>
              <b>{a.length ? a[a.length - 1] : '…'}</b>
              <span className={'met' + (running && (label === 'LOCKED' || label.startsWith('ARMED')) ? ' on' : '')}>{label}</span>
            </div>
          )
        })}
      </section>

      {log.length > 0 && (
        <section className="card">
          <div className="muted">Bot activity</div>
          {log.map((l, i) => <div className="log" key={i}>{l}</div>)}
        </section>
      )}
    </>
  )
}
