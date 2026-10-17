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
const TYPES = [
  ['DIGITOVER', 'Over'], ['DIGITUNDER', 'Under'], ['DIGITMATCH', 'Matches'],
  ['DIGITDIFF', 'Differs'], ['DIGITEVEN', 'Even'], ['DIGITODD', 'Odd'],
]
const TYPEN = Object.fromEntries(TYPES)
const CONDS = [['lt', 'is under'], ['gt', 'is over'], ['eq', 'equals'], ['even', 'is even'], ['odd', 'is odd']]
const CONDN = Object.fromEntries(CONDS)
const hasB = (t) => t !== 'DIGITEVEN' && t !== 'DIGITODD'
const isWin = (type, d, b) =>
  type === 'DIGITEVEN' ? d % 2 === 0
  : type === 'DIGITODD' ? d % 2 === 1
  : type === 'DIGITMATCH' ? d === b
  : type === 'DIGITDIFF' ? d !== b
  : type === 'DIGITOVER' ? d > b
  : d < b
const test = (cond, n, d) =>
  cond === 'lt' ? d < n : cond === 'gt' ? d > n : cond === 'eq' ? d === n : cond === 'even' ? d % 2 === 0 : d % 2 === 1
const parseStakes = (s) =>
  String(s).split(/[\s,;]+/).map(Number).filter((x) => isFinite(x) && x >= 0.35)
const wb = (st) => (hasB(st.type) ? +st.barrier : null)
const metOfSt = (st, a) => {
  const k = Math.max(1, +st.condK || 1)
  return a.length >= k && a.slice(-k).every((d) => test(st.cond, +st.condN, d))
}

const STRAT_DEF = { on: true, condK: 1, cond: 'lt', condN: 2, type: 'DIGITOVER', barrier: 1, dur: 1, entry: 'confirm' }
const newId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
const DEF = { stakes: '1, 2, 4, 8', end: 'restart', after: 'win', maxOpen: 3, sl: 10, tp: 10, syms: ['R_100'] }
const LEGACY = ['condK', 'cond', 'condN', 'type', 'barrier', 'dur', 'entry']
const loadCfg = () => {
  let st = {}
  try { st = JSON.parse(localStorage.bbfx_multi || '{}') } catch (e) { st = {} }
  const base = { ...DEF, ...st }
  if (!Array.isArray(base.strats) || !base.strats.length) {
    const legacy = {}
    LEGACY.forEach((k) => { if (st[k] !== undefined) legacy[k] = st[k] })
    base.strats = [{ ...STRAT_DEF, ...legacy, id: newId() }]
  }
  base.strats = base.strats.map((x) => ({ ...STRAT_DEF, ...x, id: x.id || newId() }))
  LEGACY.forEach((k) => { delete base[k] })
  return base
}

export default function Multi({ active, tradeOn, send, cur, demo, addHist, updHist }) {
  const [cfg, setCfg] = useState(loadCfg)
  const [running, setRunning] = useState(false)
  const [stats, setStats] = useState({ net: 0, trades: 0, wins: 0, losses: 0, idx: 0 })
  const [log, setLog] = useState([])
  const [msg, setMsg] = useState('')
  const [waitTxt, setWaitTxt] = useState('')
  const [watch, setWatch] = useState('')
  const [ldpSel, setLdpSel] = useState('')
  const [miniS, setMiniS] = useState({})
  const [showC, setShowC] = useState(() => localStorage.bbfx_mcirc !== '0')
  const [circNIn, setCircNIn] = useState(1000)
  const [cd, setCd] = useState([])
  const [, force] = useState(0)

  const cfgRef = useRef(cfg)
  const runRef = useRef(false)
  const idxRef = useRef(0)
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
  const entryArm = useRef({})
  const seq = useRef(500)
  const gate = useRef(null)
  const raf = useRef(0)
  const holds = useRef(0)
  const tickAt = useRef({})
  const paused = useRef(false)
  const pauseTimer = useRef(null)
  const pollAt = useRef({})
  const sendRef = useRef(send)
  const tradeOnRef = useRef(tradeOn)
  const curRef = useRef(cur)
  const helpers = useRef({})
  cfgRef.current = cfg
  sendRef.current = send
  tradeOnRef.current = tradeOn
  curRef.current = cur
  helpers.current = { addHist, updHist }

  useEffect(() => { localStorage.bbfx_multi = JSON.stringify(cfg) }, [cfg])
  const setC = (p) => setCfg((c) => ({ ...c, ...p }))
  const setS = (id, p) => setCfg((c) => ({ ...c, strats: c.strats.map((x) => (x.id === id ? { ...x, ...p } : x)) }))
  const dupS = (id) => setCfg((c) => {
    const i = c.strats.findIndex((x) => x.id === id)
    if (i < 0 || c.strats.length >= 6) return c
    const arr = [...c.strats]
    arr.splice(i + 1, 0, { ...c.strats[i], id: newId() })
    return { ...c, strats: arr }
  })
  const delS = (id) => setCfg((c) => (c.strats.length > 1 ? { ...c, strats: c.strats.filter((x) => x.id !== id) } : c))

  const addLog = (t) => setLog((l) => [t, ...l].slice(0, 14))
  const bump = () => {
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      force((x) => x + 1)
    })
  }
  const stakesList = () => {
    const l = parseStakes(cfgRef.current.stakes)
    return l.length ? l : [1]
  }
  const curStake = () => {
    const l = stakesList()
    return l[Math.min(idxRef.current, l.length - 1)]
  }
  const keyOf = (st, stake) => [st.type, wb(st), +st.dur || 1, stake, curRef.current].join('|')
  const keyOfMeta = (m) => [m.type, m.barrier, m.dur, m.stake, curRef.current].join('|')
  const slots = () => Object.keys(openMap.current).length + pend.current.size + holds.current
  const exposure = () => {
    let e = 0
    Object.values(openMap.current).forEach((o) => { e += o.meta.stake })
    pend.current.forEach((rid) => {
      const r = reqs.current[rid]
      if (r && r.meta) e += r.meta.stake
    })
    return e
  }
  const forget = (id) => { if (id) sendRef.current({ forget: id }) }
  const activeStrats = () => cfgRef.current.strats.filter((x) => x.on)
  const anyMet = (sym) => {
    const a = digs.current[sym] || []
    return activeStrats().some((st) => metOfSt(st, a))
  }

  const stopBot = (why) => {
    paused.current = false
    clearTimeout(pauseTimer.current)
    runRef.current = false
    gate.current = null
    entryArm.current = {}
    setWaitTxt('')
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
    const l = stakesList()
    const i = Math.min(idxRef.current, l.length - 1)
    const set = new Set([l[i], l[0]])
    if (i + 1 < l.length) set.add(l[i + 1])
    return [...set]
  }
  const wantList = () => {
    const stakes = neededStakes()
    const uniq = new Map()
    activeStrats().forEach((st) => stakes.forEach((stake) => {
      const k = keyOf(st, stake)
      if (!uniq.has(k)) uniq.set(k, { st, stake, k })
    }))
    let arr = [...uniq.values()]
    if (arr.length * cfgRef.current.syms.length > 24) {
      const cs = curStake()
      arr = arr.filter((x) => x.stake === cs)
    }
    return arr
  }
  const armOne = (sym, st, stake, key) => {
    const barrier = wb(st)
    const rid = ++seq.current
    armReq.current[rid] = { sym, key }
    armLatest.current[sym + '|' + key] = rid
    const p = {
      proposal: 1, subscribe: 1, req_id: rid, amount: stake, basis: 'stake',
      contract_type: st.type, currency: curRef.current || 'USD', duration: +st.dur || 1,
      duration_unit: 't', underlying_symbol: sym,
    }
    if (barrier !== null) p.barrier = String(barrier)
    sendRef.current(p)
  }
  const ensureArmed = (sym) => {
    if (!runRef.current || !tradeOnRef.current) return
    const want = wantList()
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
      armOne(sym, w.st, w.stake, w.k)
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
    const p = {
      proposal: 1, subscribe: 1, req_id: rid, amount: meta.stake, basis: 'stake',
      contract_type: meta.type, currency: curRef.current || 'USD', duration: meta.dur,
      duration_unit: 't', underlying_symbol: meta.sym,
    }
    if (meta.barrier !== null) p.barrier = String(meta.barrier)
    sendRef.current(p)
  }

  const fire = (sym, st) => {
    const c = cfgRef.current
    const maxOpen = parseStakes(c.stakes).length > 1 ? 1 : Math.max(1, Math.min(5, +c.maxOpen || 1))
    if (slots() >= maxOpen) return false
    if (netRef.current - exposure() <= -Math.abs(+c.sl)) return false
    const stake = curStake()
    const si = c.strats.findIndex((x) => x.id === st.id)
    const meta = { sym, stake, type: st.type, barrier: wb(st), dur: +st.dur || 1, tag: 'S' + (si + 1) }
    const key = keyOf(st, stake)
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

  // runs on every tick, before any screen redraw
  const evalTick = (sym) => {
    if (!runRef.current || !tradeOnRef.current) return
    const a = digs.current[sym] || []
    const d = a[a.length - 1]
    const g = gate.current
    if (g) {
      if (sym !== g.sym) return
      if (g.mode === 'win') {
        if (!g.ok) {
          if (isWin(g.type, d, g.barrier)) g.ok = true
          return
        }
      } else if (!g.sawFalse) {
        if (!anyMet(sym)) g.sawFalse = true
        return
      }
      gate.current = null
      setWaitTxt('')
    }
    activeStrats().forEach((st) => {
      if (st.entry === 'confirm') {
        const ek = sym + '|' + st.id
        if (entryArm.current[ek]) {
          if (isWin(st.type, d, wb(st))) {
            entryArm.current[ek] = false
            fire(sym, st)
          }
          return
        }
        if (metOfSt(st, a)) entryArm.current[ek] = true
        return
      }
      if (metOfSt(st, a)) fire(sym, st)
    })
  }

  const finish = (c, o) => {
    delete openMap.current[String(c.contract_id)]
    const profit = Number(c.profit)
    if (Number.isNaN(profit)) return
    const ex = typeof c.exit_tick_display_value === 'string' ? +c.exit_tick_display_value.slice(-1) : NaN
    helpers.current.updHist(c.contract_id, {
      status: profit >= 0 ? 'win' : 'loss', profit, exit: Number.isNaN(ex) ? undefined : ex,
    })
    netRef.current += profit
    const list = stakesList()
    const oldStake = curStake()
    let idx = idxRef.current
    let endStop = false
    if (profit >= 0) idx = 0
    else {
      idx += 1
      if (idx >= list.length) {
        if (cfgRef.current.end === 'stop') endStop = true
        idx = 0
      }
    }
    idxRef.current = idx
    const live = runRef.current
    if (live) {
      if (profit < 0 && cfgRef.current.after !== 'now') {
        const mode = cfgRef.current.after === 'fresh' ? 'fresh' : 'win'
        gate.current = { mode, sym: o.meta.sym, type: o.meta.type, barrier: o.meta.barrier, ok: false, sawFalse: false }
        Object.keys(entryArm.current).forEach((k) => { if (k.startsWith(o.meta.sym + '|')) entryArm.current[k] = false })
        setWaitTxt(
          mode === 'win'
            ? 'Waiting after the loss: needs a winning digit (' + TYPEN[o.meta.type] + (o.meta.barrier !== null ? ' ' + o.meta.barrier : '') + ') on ' + SYMN[o.meta.sym] + ', then the next signal'
            : 'Waiting after the loss: the signal must clear and appear again on ' + SYMN[o.meta.sym]
        )
      } else {
        gate.current = null
        setWaitTxt('')
      }
    }
    setStats((s) => ({
      net: netRef.current, trades: s.trades + 1, wins: s.wins + (profit >= 0 ? 1 : 0),
      losses: s.losses + (profit < 0 ? 1 : 0), idx,
    }))
    addLog(
      (profit >= 0 ? '✅ ' : '❌ ') + (o.meta.tag || '') + ' ' + SYMN[o.meta.sym] + ' ' + TYPEN[o.meta.type] +
      (o.meta.barrier !== null ? ' ' + o.meta.barrier : '') + ' · stake ' + o.meta.stake +
      ' · ' + (profit >= 0 ? '+' : '') + profit.toFixed(2) + ' → next stake ' + curStake()
    )
    if (!live) return
    if (curStake() !== oldStake) ensureAll()
    const c2 = cfgRef.current
    if (netRef.current <= -Math.abs(+c2.sl)) return stopBot('Stop loss reached')
    if (+c2.tp > 0 && netRef.current >= +c2.tp) return stopBot('Take profit reached')
    if (endStop) return stopBot('Reached the end of the stake list')
  }

  // ---------- messages from the trading socket ----------
  useEffect(() => {
    const already = (e) => e.code === 'AlreadySubscribed' || /already subscribed/i.test(e.message || '')
    const h = (m) => {
      if (m.msg_type === 'proposal_open_contract') {
        const c = m.proposal_open_contract
        if (c && c.is_sold) {
          const o = openMap.current[String(c.contract_id)]
          if (m.subscription) forget(m.subscription.id)
          if (o) finish(c, o)
        }
        return
      }
      const rid = m.req_id || (m.echo_req && m.echo_req.req_id)
      if (!rid || rid < 500) return

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
          map[ar.key] = {
            id: m.proposal.id, ask: m.proposal.ask_price, subId: m.subscription && m.subscription.id,
          }
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
        forget(r.subId)
        rearm(r.meta.sym)
        errs.current = 0
        const id = m.buy.contract_id
        openMap.current[String(id)] = { meta: r.meta, t: Date.now() }
        helpers.current.addHist({
          id, t: Date.now(), symbol: r.meta.sym, type: r.meta.type, barrier: r.meta.barrier,
          stake: Number(m.buy.buy_price), status: 'open',
        })
        sendRef.current({ proposal_open_contract: 1, contract_id: id, subscribe: 1, req_id: ++seq.current })
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
          pip.current[sym] = t.pip_size
          const d = +t.quote.toFixed(t.pip_size).slice(-1)
          digs.current[sym] = [...(digs.current[sym] || []).slice(-59), d]
          tickAt.current[sym] = Date.now()
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
      const bad = syms.some((sym) => now - (tickAt.current[sym] || opened) > 7000)
      if (bad) {
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
    if (!c.strats.some((x) => x.on)) return setMsg('Turn on at least one strategy')
    if (!parseStakes(c.stakes).length) return setMsg('Add at least one stake (minimum 0.35)')
    if (!(+c.sl > 0)) return setMsg('Set a stop loss above 0')
    for (let i = 0; i < c.strats.length; i++) {
      const st = c.strats[i]
      if (!st.on) continue
      if (st.type === 'DIGITOVER' && +st.barrier === 9) return setMsg('Strategy ' + (i + 1) + ': Over needs a digit 0-8')
      if (st.type === 'DIGITUNDER' && +st.barrier === 0) return setMsg('Strategy ' + (i + 1) + ': Under needs a digit 1-9')
    }
    if (!demo && !confirm('REAL account. The bot will place trades automatically with real money. Start?')) return
    gate.current = null
    entryArm.current = {}
    setWaitTxt('')
    netRef.current = 0
    idxRef.current = 0
    errs.current = 0
    pend.current.clear()
    armedP.current = {}
    armLatest.current = {}
    armTs.current = {}
    armErr.current = {}
    armTries.current = {}
    setStats({ net: 0, trades: 0, wins: 0, losses: 0, idx: 0 })
    paused.current = false
    runRef.current = true
    setRunning(true)
    setMsg('Running')
    ensureAll()
  }

  const togSym = (v) =>
    setC({ syms: cfg.syms.includes(v) ? cfg.syms.filter((x) => x !== v) : [...cfg.syms, v] })

  const wsym = cfg.syms.includes(watch) ? watch : cfg.syms[0]
  const viewSt = cfg.strats.find((x) => x.id === ldpSel) || cfg.strats[0]

  // ----- circles: own socket for the market shown in the LDP -----
  const circN = Math.max(100, Math.min(5000, +circNIn || 1000))
  const circOn = active === undefined || active
  useEffect(() => {
    if (!showC || !circOn || !wsym) return
    let dead = false
    let sock
    let retry
    let subTimer
    const run = () => {
      sock = new WebSocket(PUBLIC_WS)
      let subd = false
      const sub = () => {
        if (subd || sock.readyState !== 1) return
        subd = true
        sock.send(JSON.stringify({ ticks: wsym, subscribe: 1 }))
      }
      sock.onopen = () => {
        setCd([])
        sock.send(JSON.stringify({ ticks_history: wsym, count: circN, end: 'latest', style: 'ticks' }))
        subTimer = setTimeout(sub, 4000)
      }
      sock.onclose = () => { if (!dead) retry = setTimeout(run, 2000) }
      sock.onmessage = (e) => {
        const m = JSON.parse(e.data)
        if (m.msg_type === 'history') {
          const h = m.history || {}
          const pp = m.pip_size ?? h.pip_size ?? 2
          setCd((h.prices || []).map((p) => +Number(p).toFixed(pp).slice(-1)).slice(-circN))
          sub()
        } else if (m.msg_type === 'tick') {
          const t = m.tick
          const d = +t.quote.toFixed(t.pip_size).slice(-1)
          setCd((a) => [...a.slice(-(circN - 1)), d])
        } else if (m.error && m.echo_req && m.echo_req.ticks_history) {
          sub()
        }
      }
    }
    const startT = setTimeout(run, 500)
    return () => {
      dead = true
      clearTimeout(startT)
      clearTimeout(retry)
      clearTimeout(subTimer)
      if (sock) sock.close()
    }
  }, [showC, circOn, wsym, circN])

  const cn = cd.length || 1
  const ccount = Array(10).fill(0)
  cd.forEach((d) => { ccount[d]++ })
  const cmax = Math.max(...ccount)
  const cmin = Math.min(...ccount)
  const csecond = Math.max(-1, ...ccount.filter((c) => c < cmax))
  const clast = cd[cd.length - 1]
  const ccls = (c) => (cd.length === 0 ? '' : c === cmax ? 'g' : c === cmin ? 'r' : c === csecond ? 'b' : '')

  const arr = (wsym && digs.current[wsym]) || []
  const vbar = +viewSt.barrier
  const vNeedN = ['lt', 'gt', 'eq'].includes(viewSt.cond)
  const kindOf = (d) =>
    viewSt.type === 'DIGITOVER' || viewSt.type === 'DIGITUNDER'
      ? (d > vbar ? ['O', 'g'] : d < vbar ? ['U', 'r'] : ['S', 'b'])
      : viewSt.type === 'DIGITMATCH' || viewSt.type === 'DIGITDIFF'
      ? (d === vbar ? ['M', 'g'] : ['D', 'r'])
      : (d % 2 ? ['O', 'r'] : ['E', 'g'])
  const ldpLabel =
    viewSt.type === 'DIGITOVER' || viewSt.type === 'DIGITUNDER'
      ? 'O over ' + vbar + ' · S same · U under'
      : viewSt.type === 'DIGITMATCH' || viewSt.type === 'DIGITDIFF'
      ? 'M = digit ' + vbar + ' · D = other digits'
      : 'E even · O odd'
  const list = parseStakes(cfg.stakes)
  const shown = list.length ? list : [1]
  const nextStake = shown[Math.min(stats.idx, shown.length - 1)]
  const openNow = Object.keys(openMap.current).length + pend.current.size
  const maxO = list.length > 1 ? 1 : Math.max(1, Math.min(5, +cfg.maxOpen || 1))

  return (
    <>
      <section className="card">
        <div className="pcthead">
          <b>CIRCLES · {SYMN[wsym] || ''}</b>
          <button
            className="smallbtn"
            onClick={() => {
              const v = !showC
              setShowC(v)
              localStorage.bbfx_mcirc = v ? '1' : '0'
            }}
          >
            {showC ? 'Hide' : 'Show'}
          </button>
        </div>
        {showC && (
          <>
            <div className="row">
              <label>Ticks to analyse
                <input type="number" min="100" max="5000" value={circNIn} onChange={(e) => setCircNIn(e.target.value)} />
              </label>
            </div>
            <div className="circles">
              {ccount.map((c, d) => {
                const parts = []
                if (vNeedN && d === +viewSt.condN) parts.push('SIGNAL')
                if (hasB(viewSt.type) && d === vbar) parts.push('TRADE')
                const isLast = clast === d
                return (
                  <div className="cwrap" key={d + '-' + (isLast ? cd.length : 'x')}>
                    <i className="pill">{parts.join(' ')}</i>
                    <div className={'circ ' + ccls(c) + (hasB(viewSt.type) && d === vbar ? ' tsel' : '') + (isLast ? ' flash' : '')}>
                      <b>{d}</b>
                      <small>{cd.length ? ((c / cn) * 100).toFixed(1) + '%' : '…'}</small>
                    </div>
                    <i className="tri">{isLast ? '▲' : ''}</i>
                  </div>
                )
              })}
            </div>
            <div className="muted">
              {cd.length < circN ? 'Loading ' + cd.length + '/' + circN + ' ticks…' : 'Last ' + circN + ' ticks'} · green most · blue 2nd · red least · follows the market chosen in LDP below
            </div>
          </>
        )}
      </section>

      <section className="card">
        <div className="pcthead">
          <b>LDP</b>
          <span className={'badge ' + (metOfSt(viewSt, arr) ? 'on' : '')}>{metOfSt(viewSt, arr) ? 'CONDITION MET' : 'waiting'}</span>
        </div>
        <select value={wsym || ''} onChange={(e) => setWatch(e.target.value)} disabled={!cfg.syms.length}>
          {cfg.syms.map((v) => <option key={v} value={v}>{SYMN[v]}</option>)}
        </select>
        {cfg.strats.length > 1 && (
          <label>Boxes show
            <select value={viewSt.id} onChange={(e) => setLdpSel(e.target.value)}>
              {cfg.strats.map((x, i) => <option key={x.id} value={x.id}>Strategy {i + 1}</option>)}
            </select>
          </label>
        )}
        <div className="osu">
          {Array.from({ length: 30 }, (_, i) => {
            const d = arr[arr.length - 1 - i]
            if (d === undefined) return <b key={i} className="x">·</b>
            const [l, c] = kindOf(d)
            return <b key={i} className={c + (i === 0 ? ' new' : '')}>{l}</b>
          })}
        </div>
        <div className="muted">Newest top-left · {ldpLabel}</div>
      </section>

      <section className="card">
        <button className={'buy ' + (running ? 'odd' : 'even')} onClick={running ? () => stopBot('Stopped by you') : start}>
          {running ? 'STOP' : 'START'}
        </button>
        {msg && <div className="muted">{msg}</div>}
        {waitTxt && <div className="waitbox">⏳ {waitTxt}</div>}
        <div className="sum">
          <div><small>Net P/L</small><b className={stats.net >= 0 ? 'win' : 'loss'}>{stats.net >= 0 ? '+' : ''}{stats.net.toFixed(2)}</b></div>
          <div><small>Win / Loss</small><b>{stats.wins} / {stats.losses}</b></div>
          <div><small>Next stake</small><b>{nextStake}</b></div>
        </div>
        {running && <div className="muted">Open trades: {openNow} / {maxO}</div>}
      </section>

      {cfg.strats.map((st, i) => {
        const needN = ['lt', 'gt', 'eq'].includes(st.cond)
        const kk = Math.max(1, +st.condK || 1)
        const open = !miniS[st.id]
        return (
          <section className={'card' + (st.on ? '' : ' off')} key={st.id}>
            <div className="pcthead">
              <b>Strategy {i + 1}{st.on ? '' : ' (off)'}</b>
              <button className="smallbtn" onClick={() => setMiniS((m) => ({ ...m, [st.id]: open }))}>{open ? 'Minimise' : 'Expand'}</button>
            </div>
            {open && (
              <>
                <div className="row">
                  <label>Last digits to check
                    <input type="number" min="1" max="10" disabled={running} value={st.condK} onChange={(e) => setS(st.id, { condK: e.target.value })} />
                  </label>
                  <label>Condition
                    <select disabled={running} value={st.cond} onChange={(e) => setS(st.id, { cond: e.target.value })}>
                      {CONDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </label>
                </div>
                {needN && (
                  <label>Digit
                    <input type="number" min="0" max="9" disabled={running} value={st.condN} onChange={(e) => setS(st.id, { condN: e.target.value })} />
                  </label>
                )}
                <div className="row">
                  <label>Then trade
                    <select disabled={running} value={st.type} onChange={(e) => setS(st.id, { type: e.target.value })}>
                      {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </label>
                  <label>Ticks
                    <input type="number" min="1" max="10" disabled={running} value={st.dur} onChange={(e) => setS(st.id, { dur: e.target.value })} />
                  </label>
                </div>
                {hasB(st.type) && (
                  <div className="pick">
                    {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
                      <button key={d} disabled={running} className={+st.barrier === d ? 'on' : ''} onClick={() => setS(st.id, { barrier: d })}>{d}</button>
                    ))}
                  </div>
                )}
                <label>Entry
                  <select disabled={running} value={st.entry} onChange={(e) => setS(st.id, { entry: e.target.value })}>
                    <option value="confirm">After the signal, wait for one winning digit, then trade</option>
                    <option value="now">Trade immediately on the signal</option>
                  </select>
                </label>
              </>
            )}
            <div className="muted">
              S{i + 1}: when the last {kk} digit{kk > 1 ? 's' : ''} {CONDN[st.cond]}{needN ? ' ' + st.condN : ''}
              {st.entry === 'confirm' ? ', wait for one winning digit, then ' : ' → '}
              {TYPEN[st.type]}{hasB(st.type) ? ' ' + st.barrier : ''}
            </div>
            <div className="row">
              <button disabled={running} onClick={() => setS(st.id, { on: !st.on })}>{st.on ? 'Turn off' : 'Turn on'}</button>
              <button disabled={running || cfg.strats.length >= 6} onClick={() => dupS(st.id)}>Duplicate</button>
              {cfg.strats.length > 1 && <button disabled={running} onClick={() => delS(st.id)}>Remove</button>}
            </div>
          </section>
        )
      })}

      <section className="card">
        <b>Stakes, stop loss, take profit</b>
        <label>Stake list (martingale steps, comma separated)
          <input type="text" inputMode="text" disabled={running} value={cfg.stakes} onChange={(e) => setC({ stakes: e.target.value })} />
        </label>
        <div className="row">
          <label>At end of list
            <select disabled={running} value={cfg.end} onChange={(e) => setC({ end: e.target.value })}>
              <option value="restart">Restart at first stake</option>
              <option value="stop">Stop the bot</option>
            </select>
          </label>
          <label>Stop loss
            <input type="number" min="0" step="0.5" disabled={running} value={cfg.sl} onChange={(e) => setC({ sl: e.target.value })} />
          </label>
        </div>
        <label>After a loss
          <select disabled={running} value={cfg.after} onChange={(e) => setC({ after: e.target.value })}>
            <option value="win">Wait for a winning digit, then the next signal</option>
            <option value="fresh">Wait until the signal clears and appears again</option>
            <option value="now">Trade on the very next signal</option>
          </select>
        </label>
        <div className="row">
          <label>Trades open at once
            <select disabled={running || list.length > 1} value={list.length > 1 ? 1 : cfg.maxOpen} onChange={(e) => setC({ maxOpen: +e.target.value })}>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label>Take profit (0 = off)
            <input type="number" min="0" step="0.5" disabled={running} value={cfg.tp} onChange={(e) => setC({ tp: e.target.value })} />
          </label>
        </div>
        {list.length > 1 && <div className="muted">Stake list is on, so the bot trades one at a time and each stake follows the result of the trade before it. Use a single stake to allow overlapping trades.</div>}
        <div className="muted">The bot will not open a trade if losing everything already open would pass your stop loss. Stake list, stop loss and take profit are shared by all strategies.</div>
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
          const met = cfg.strats.some((x) => x.on && metOfSt(x, a))
          const armedE = cfg.strats.some((x) => x.on && x.entry === 'confirm' && entryArm.current[sym + '|' + x.id])
          return (
            <div className="mrow" key={sym}>
              <button className={'sname' + (sym === wsym ? ' sel' : '')} onClick={() => setWatch(sym)}>{SYMN[sym]}</button>
              <b>{a.length ? a[a.length - 1] : '…'}</b>
              <span className={'met' + (met || armedE ? ' on' : '')}>{armedE ? 'ARMED' : met ? 'MET' : 'wait'}</span>
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
