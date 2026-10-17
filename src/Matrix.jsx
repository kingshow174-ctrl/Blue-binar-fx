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
const TN = { DIGITOVER: 'Over', DIGITUNDER: 'Under', DIGITEVEN: 'Even', DIGITODD: 'Odd' }
const hasB = (t) => t === 'DIGITOVER' || t === 'DIGITUNDER'
const isWin = (type, d, b) =>
  type === 'DIGITEVEN' ? d % 2 === 0
  : type === 'DIGITODD' ? d % 2 === 1
  : type === 'DIGITOVER' ? d > b
  : d < b
const parseStakes = (s) =>
  String(s).split(/[\s,;]+/).map(Number).filter((x) => isFinite(x) && x >= 0.35)
const LET = ['A', 'B', 'C', 'D']
const OU = { A: ['gt', 'DIGITOVER'], B: ['lt', 'DIGITUNDER'], C: ['gt', 'DIGITUNDER'], D: ['lt', 'DIGITOVER'] }
const EO = { A: ['odd', 'DIGITODD'], B: ['even', 'DIGITEVEN'], C: ['odd', 'DIGITEVEN'], D: ['even', 'DIGITODD'] }
const ouDesc = (l, c) => {
  const s = c.ou.sig
  const t = c.ou.tr
  return l === 'A' ? 'If the last digit is over ' + s + ' → trade Over ' + t
    : l === 'B' ? 'If the last digit is under ' + s + ' → trade Under ' + t
    : l === 'C' ? 'If the last digit is over ' + s + ' → trade Under ' + t
    : 'If the last digit is under ' + s + ' → trade Over ' + t + ' (mirror of C)'
}
const eoDesc = (l) =>
  l === 'A' ? 'If the last digit is odd → trade Odd'
  : l === 'B' ? 'If the last digit is even → trade Even'
  : l === 'C' ? 'If the last digit is odd → trade Even'
  : 'If the last digit is even → trade Odd (mirror of C)'

const DEF = {
  syms: ['R_100'], stakes: '1, 2, 4, 8', end: 'restart', after: 'win', maxOpen: 3, sl: 10, tp: 10, dur: 1,
  ou: { k: 1, sig: 4, tr: 4, A: true, B: false, C: false, D: false },
  eo: { k: 1, A: false, B: false, C: false, D: false },
}
const loadCfg = () => {
  try {
    const st = JSON.parse(localStorage.bbfx_matrix || '{}')
    return { ...DEF, ...st, ou: { ...DEF.ou, ...(st.ou || {}) }, eo: { ...DEF.eo, ...(st.eo || {}) } }
  } catch (e) { return DEF }
}
const buildStrats = (c) => {
  const out = []
  LET.forEach((l) => {
    if (c.ou[l]) out.push({ id: 'ou' + l, tag: 'OU-' + l, cond: OU[l][0], n: +c.ou.sig, k: Math.max(1, +c.ou.k || 1), type: OU[l][1], barrier: +c.ou.tr })
  })
  LET.forEach((l) => {
    if (c.eo[l]) out.push({ id: 'eo' + l, tag: 'EO-' + l, cond: EO[l][0], n: 0, k: Math.max(1, +c.eo.k || 1), type: EO[l][1], barrier: null })
  })
  return out
}
const sigMet = (s, a) =>
  a.length >= s.k && a.slice(-s.k).every((d) =>
    s.cond === 'gt' ? d > s.n : s.cond === 'lt' ? d < s.n : s.cond === 'odd' ? d % 2 === 1 : d % 2 === 0)

export default function Matrix({ tradeOn, send, cur, demo, addHist, updHist }) {
  const [cfg, setCfg] = useState(loadCfg)
  const [running, setRunning] = useState(false)
  const [stats, setStats] = useState({ net: 0, trades: 0, wins: 0, losses: 0, idx: 0 })
  const [log, setLog] = useState([])
  const [msg, setMsg] = useState('')
  const [waitTxt, setWaitTxt] = useState('')
  const [watch, setWatch] = useState('')
  const [view, setView] = useState('ou')
  const [mini, setMini] = useState({})
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
  const seq = useRef(300000)
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

  useEffect(() => { localStorage.bbfx_matrix = JSON.stringify(cfg) }, [cfg])
  const setC = (p) => setCfg((c) => ({ ...c, ...p }))
  const setGrp = (g, p) => setCfg((c) => ({ ...c, [g]: { ...c[g], ...p } }))
  const addLog = (t) => setLog((l) => [t, ...l].slice(0, 14))
  const bump = () => {
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      force((x) => x + 1)
    })
  }
  const strats = () => buildStrats(cfgRef.current)
  const stakesList = () => {
    const l = parseStakes(cfgRef.current.stakes)
    return l.length ? l : [1]
  }
  const curStake = () => {
    const l = stakesList()
    return l[Math.min(idxRef.current, l.length - 1)]
  }
  const keyOf = (s, stake) => [s.type, s.barrier, +cfgRef.current.dur || 1, stake, curRef.current].join('|')
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

  const stopBot = (why) => {
    paused.current = false
    clearTimeout(pauseTimer.current)
    runRef.current = false
    gate.current = null
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
    strats().forEach((s) => stakes.forEach((stake) => {
      const k = keyOf(s, stake)
      if (!uniq.has(k)) uniq.set(k, { s, stake, k })
    }))
    let arr = [...uniq.values()]
    if (arr.length * cfgRef.current.syms.length > 24) {
      const cs = curStake()
      arr = arr.filter((x) => x.stake === cs)
    }
    return arr
  }
  const armOne = (sym, s, stake, key) => {
    const rid = ++seq.current
    armReq.current[rid] = { sym, key }
    armLatest.current[sym + '|' + key] = rid
    const p = {
      proposal: 1, subscribe: 1, req_id: rid, amount: stake, basis: 'stake',
      contract_type: s.type, currency: curRef.current || 'USD', duration: +cfgRef.current.dur || 1,
      duration_unit: 't', underlying_symbol: sym,
    }
    if (s.barrier !== null) p.barrier = String(s.barrier)
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
      armOne(sym, w.s, w.stake, w.k)
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

  const fire = (sym, s) => {
    const c = cfgRef.current
    const maxOpen = parseStakes(c.stakes).length > 1 ? 1 : Math.max(1, Math.min(5, +c.maxOpen || 1))
    if (slots() >= maxOpen) return false
    if (netRef.current - exposure() <= -Math.abs(+c.sl)) return false
    const stake = curStake()
    const meta = { sym, stake, type: s.type, barrier: s.barrier, dur: +c.dur || 1, tag: s.tag }
    const key = keyOf(s, stake)
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
      if (!g.ok) {
        if (isWin(g.type, d, g.barrier)) g.ok = true
        return
      }
      gate.current = null
      setWaitTxt('')
    }
    strats().forEach((s) => { if (sigMet(s, a)) fire(sym, s) })
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
        gate.current = { sym: o.meta.sym, type: o.meta.type, barrier: o.meta.barrier, ok: false }
        setWaitTxt('Waiting after the loss: needs a winning digit (' + TN[o.meta.type] + (o.meta.barrier !== null ? ' ' + o.meta.barrier : '') + ') on ' + SYMN[o.meta.sym] + ', then the next signal')
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
      (profit >= 0 ? '✅ ' : '❌ ') + o.meta.tag + ' ' + SYMN[o.meta.sym] + ' ' + TN[o.meta.type] +
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
      if (!rid || rid < 300000) return

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
    const ss = buildStrats(c)
    if (!ss.length) return setMsg('Turn on at least one strategy')
    if (!parseStakes(c.stakes).length) return setMsg('Add at least one stake (minimum 0.35)')
    if (!(+c.sl > 0)) return setMsg('Set a stop loss above 0')
    for (const s of ss) {
      if (hasB(s.type) && !(s.barrier >= 0 && s.barrier <= 9)) return setMsg(s.tag + ': trade digit must be 0-9')
      if (s.type === 'DIGITOVER' && s.barrier > 8) return setMsg(s.tag + ': Over needs a trade digit 0-8')
      if (s.type === 'DIGITUNDER' && s.barrier < 1) return setMsg(s.tag + ': Under needs a trade digit 1-9')
      if (s.cond === 'gt' && !(s.n >= 0 && s.n <= 8)) return setMsg(s.tag + ': signal digit must be 0-8 (nothing is over 9)')
      if (s.cond === 'lt' && !(s.n >= 1 && s.n <= 9)) return setMsg(s.tag + ': signal digit must be 1-9 (nothing is under 0)')
    }
    if (!demo && !confirm('REAL account. The bot will place trades automatically with real money. Start?')) return
    gate.current = null
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
  const arr = (wsym && digs.current[wsym]) || []
  const sig = +cfg.ou.sig
  const kindOf = (d) =>
    view === 'ou'
      ? (d > sig ? ['O', 'g'] : d < sig ? ['U', 'r'] : ['S', 'b'])
      : (d % 2 ? ['O', 'r'] : ['E', 'g'])
  const list = parseStakes(cfg.stakes)
  const shown = list.length ? list : [1]
  const nextStake = shown[Math.min(stats.idx, shown.length - 1)]
  const openNow = Object.keys(openMap.current).length + pend.current.size
  const maxO = list.length > 1 ? 1 : Math.max(1, Math.min(5, +cfg.maxOpen || 1))
  const clash = (g) => (cfg[g].A && cfg[g].C) || (cfg[g].B && cfg[g].D)

  return (
    <>
      <section className="card">
        <div className="pcthead">
          <b>MATRIX</b>
          <span className="badge">{strats().length} strategies on</span>
        </div>
        <select value={wsym || ''} onChange={(e) => setWatch(e.target.value)} disabled={!cfg.syms.length}>
          {cfg.syms.map((v) => <option key={v} value={v}>{SYMN[v]}</option>)}
        </select>
        <label>Boxes show
          <select value={view} onChange={(e) => setView(e.target.value)}>
            <option value="ou">Over / Under (vs signal digit {cfg.ou.sig})</option>
            <option value="eo">Even / Odd</option>
          </select>
        </label>
        <div className="osu">
          {Array.from({ length: 30 }, (_, i) => {
            const d = arr[arr.length - 1 - i]
            if (d === undefined) return <b key={i} className="x">·</b>
            const [l, c] = kindOf(d)
            return <b key={i} className={c + (i === 0 ? ' new' : '')}>{l}</b>
          })}
        </div>
        <div className="muted">Newest top-left · {view === 'ou' ? 'O over ' + sig + ' · S same · U under' : 'E even · O odd'}</div>
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

      <section className="card">
        <div className="pcthead">
          <b>OVER / UNDER</b>
          <button className="smallbtn" onClick={() => setMini((m) => ({ ...m, ou: !m.ou }))}>{mini.ou ? 'Expand' : 'Minimise'}</button>
        </div>
        {!mini.ou && (
          <>
            <div className="row">
              <label>Signal digit
                <input type="number" min="0" max="9" disabled={running} value={cfg.ou.sig} onChange={(e) => setGrp('ou', { sig: e.target.value })} />
              </label>
              <label>Trade digit
                <input type="number" min="0" max="9" disabled={running} value={cfg.ou.tr} onChange={(e) => setGrp('ou', { tr: e.target.value })} />
              </label>
            </div>
            <label>Last digits to check
              <input type="number" min="1" max="10" disabled={running} value={cfg.ou.k} onChange={(e) => setGrp('ou', { k: e.target.value })} />
            </label>
            <div className="stg">
              {LET.map((l) => (
                <button key={l} disabled={running} className={'stb' + (cfg.ou[l] ? ' on' : '')} onClick={() => setGrp('ou', { [l]: !cfg.ou[l] })}>
                  <b>{l}</b>
                  <small>{ouDesc(l, cfg)}</small>
                </button>
              ))}
            </div>
            {clash('ou') && <div className="muted">A+C (or B+D) answer the same signal with opposite trades, so they cancel each other out.</div>}
          </>
        )}
      </section>

      <section className="card">
        <div className="pcthead">
          <b>EVEN / ODD</b>
          <button className="smallbtn" onClick={() => setMini((m) => ({ ...m, eo: !m.eo }))}>{mini.eo ? 'Expand' : 'Minimise'}</button>
        </div>
        {!mini.eo && (
          <>
            <label>Last digits to check
              <input type="number" min="1" max="10" disabled={running} value={cfg.eo.k} onChange={(e) => setGrp('eo', { k: e.target.value })} />
            </label>
            <div className="stg">
              {LET.map((l) => (
                <button key={l} disabled={running} className={'stb' + (cfg.eo[l] ? ' on' : '')} onClick={() => setGrp('eo', { [l]: !cfg.eo[l] })}>
                  <b>{l}</b>
                  <small>{eoDesc(l)}</small>
                </button>
              ))}
            </div>
            {clash('eo') && <div className="muted">A+C (or B+D) answer the same signal with opposite trades, so they cancel each other out.</div>}
          </>
        )}
      </section>

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
          <label>Ticks per trade
            <input type="number" min="1" max="10" disabled={running} value={cfg.dur} onChange={(e) => setC({ dur: e.target.value })} />
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
        <label>After a loss
          <select disabled={running} value={cfg.after} onChange={(e) => setC({ after: e.target.value })}>
            <option value="win">Wait for a winning digit, then the next signal</option>
            <option value="now">Trade on the very next signal</option>
          </select>
        </label>
        <label>Trades open at once
          <select disabled={running || list.length > 1} value={list.length > 1 ? 1 : cfg.maxOpen} onChange={(e) => setC({ maxOpen: +e.target.value })}>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        {list.length > 1 && <div className="muted">Stake list is on, so the bot trades one at a time and each stake follows the result of the trade before it. Use a single stake to allow overlapping trades.</div>}
        <div className="muted">The bot will not open a trade if losing everything already open would pass your stop loss.</div>
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
          const tags = strats().filter((s) => sigMet(s, a)).map((s) => s.tag.replace('OU-', 'O/U ').replace('EO-', 'E/O '))
          return (
            <div className="mrow" key={sym} style={{ gridTemplateColumns: '1fr 36px 120px' }}>
              <button className={'sname' + (sym === wsym ? ' sel' : '')} onClick={() => setWatch(sym)}>{SYMN[sym]}</button>
              <b>{a.length ? a[a.length - 1] : '…'}</b>
              <span className={'met' + (tags.length ? ' on' : '')}>{tags.length ? tags.join(' ') : 'wait'}</span>
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
