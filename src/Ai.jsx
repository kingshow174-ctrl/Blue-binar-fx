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
const TN = {
  DIGITOVER: 'Over', DIGITUNDER: 'Under', DIGITMATCH: 'Matches',
  DIGITDIFF: 'Differs', DIGITEVEN: 'Even', DIGITODD: 'Odd',
}
const hasB = (t) => t !== 'DIGITEVEN' && t !== 'DIGITODD'
const isWin = (type, d, b) =>
  type === 'DIGITEVEN' ? d % 2 === 0
  : type === 'DIGITODD' ? d % 2 === 1
  : type === 'DIGITMATCH' ? d === b
  : type === 'DIGITDIFF' ? d !== b
  : type === 'DIGITOVER' ? d > b
  : d < b
const parseStakes = (s) =>
  String(s).split(/[\s,;]+/).map(Number).filter((x) => isFinite(x) && x >= 0.35)
const label = (d) => (d ? TN[d.type] + (d.barrier != null ? ' ' + d.barrier : '') : '')
const stamp = () => new Date().toLocaleTimeString([], { hour12: false })
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const LETTERS = 'ABCDEFGHIJKL'
const DEF_LADDER = [
  { stake: 0.35, runs: 1 }, { stake: 1, runs: 4 }, { stake: 3.5, runs: 4 },
  { stake: 13, runs: 4 }, { stake: 47, runs: 4 },
]

const pctArr = (arr) => {
  const c = Array(10).fill(0)
  arr.forEach((d) => { c[d]++ })
  return c.map((x) => (arr.length ? (x / arr.length) * 100 : 0))
}
// what the DIFF-RADAR sees: stable % per digit, lowest/highest ranks, fast movers
const diffInfo = (a, c) => {
  const W = clamp(Math.round(+c.dwin || 500), 100, 2000)
  const SW = clamp(Math.round(+c.dspeed || 30), 5, 200)
  const win = a.slice(-W)
  const now = pctArr(win)
  const prevArr = a.slice(Math.max(0, a.length - SW - W), Math.max(0, a.length - SW))
  const prev = prevArr.length >= 50 ? pctArr(prevArr) : null
  const delta = now.map((p, i) => (prev ? Math.abs(p - prev[i]) : 0))
  const order = [...Array(10).keys()].sort((x, y) => now[x] - now[y])
  const lowN = clamp(Math.round(+c.dlow || 0), 0, 5)
  const highN = clamp(Math.round(+c.dhigh || 0), 0, 5)
  const low = new Set(order.slice(0, lowN))
  const high = new Set(highN ? order.slice(10 - highN) : [])
  const thr = +c.dfastN || 1
  const fast = new Set()
  if (c.dfast) delta.forEach((d, i) => { if (d >= thr) fast.add(i) })
  return { now, low, high, fast, delta }
}

// stake calculator: each recovery stake = losses x multiplier / divide-by
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

const BOTS = [
  {
    id: 'neo', name: 'NEO-SNIPER', need: 1,
    desc: 'Last digit under 2 → Over 1',
    decide: (a) => (a[a.length - 1] < 2 ? { type: 'DIGITOVER', barrier: 1 } : null),
  },
  {
    id: 'streak', name: 'STREAK-X', need: 3,
    desc: '3 odd in a row → Even · 3 even in a row → Odd',
    decide: (a) => {
      const l = a.slice(-3)
      if (l.every((d) => d % 2 === 1)) return { type: 'DIGITEVEN', barrier: null }
      if (l.every((d) => d % 2 === 0)) return { type: 'DIGITODD', barrier: null }
      return null
    },
  },
  {
    id: 'diff', name: 'DIFF-RADAR', need: 20,
    desc: 'Digit seen 5+ times in the last 20 and just appeared → Differs on it (settings below)',
    decide: (a, c) => {
      if (c.dmode === 'filter') {
        if (a.length < 100) return null
        const last = a[a.length - 1]
        const info = diffInfo(a, c)
        if (info.low.has(last) || info.high.has(last) || info.fast.has(last)) return null
        return { type: 'DIGITDIFF', barrier: last }
      }
      const N = clamp(Math.round(+c.cwin || 20), 5, 100)
      const K = clamp(Math.round(+c.ccount || 5), 2, 50)
      if (a.length < N) return null
      const w = a.slice(-N)
      const d = w[w.length - 1]
      return w.filter((x) => x === d).length >= K ? { type: 'DIGITDIFF', barrier: d } : null
    },
  },
  {
    id: 'wave', name: 'UNDER-WAVE', need: 2,
    desc: '2 digits in a row at 8 or 9 → Under 8',
    decide: (a) => (a.slice(-2).every((d) => d >= 8) ? { type: 'DIGITUNDER', barrier: 8 } : null),
  },
]
const BOTN = Object.fromEntries(BOTS.map((b) => [b.id, b]))
const DEF = {
  bot: 'neo', syms: ['R_100'], stakes: '1, 2, 4, 8', end: 'restart', after: 'win', sl: 10, tp: 10,
  ladder: DEF_LADDER, dmode: 'classic', ccount: 5, cwin: 20, dstake: 'list', cbase: 0.35, cmult: 11, cdiv: 4, csteps: 4, cmode: 'cum', cround: 0.05, cauto: true, rstrat: 'over1c', rover: 1, runder: 2, rconf: 1, rpick: 'both', rwin: 200, rentry: 'confirm', rcut: 15, rwins: 1, dwin: 500, dspeed: 30, dfast: true, dfastN: 1, dlow: 2, dhigh: 0,
}

function MatrixRain({ active }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!active || !ref.current) return
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const c = ref.current
    const ctx = c.getContext('2d')
    const size = 16
    const chars = '01アイウエオカキクケコサシスセソ0123456789'
    let w, h, cols, drops, raf
    let last = 0
    const resize = () => {
      w = c.width = window.innerWidth
      h = c.height = window.innerHeight
      cols = Math.floor(w / size)
      drops = Array.from({ length: cols }, () => Math.random() * (h / size))
    }
    resize()
    window.addEventListener('resize', resize)
    const frame = (t) => {
      raf = requestAnimationFrame(frame)
      if (t - last < 55) return
      last = t
      ctx.fillStyle = 'rgba(2,10,24,0.13)'
      ctx.fillRect(0, 0, w, h)
      ctx.font = size + 'px monospace'
      for (let i = 0; i < cols; i++) {
        const rr = Math.random()
        ctx.fillStyle = rr > 0.97 ? '#ffffff' : rr > 0.93 ? '#19ff7a' : '#3aa0ff'
        ctx.fillText(chars[Math.floor(Math.random() * chars.length)], i * size, drops[i] * size)
        if (drops[i] * size > h && Math.random() > 0.975) drops[i] = 0
        drops[i] += 1
      }
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [active])
  return active ? <canvas ref={ref} className="rain" /> : null
}

function Robot({ state }) {
  return (
    <svg viewBox="0 0 120 120" className={'robot ' + state}>
      <circle className="ring" cx="60" cy="60" r="56" />
      <circle className="ring" cx="60" cy="60" r="48" style={{ opacity: 0.5 }} />
      <circle className="halo" cx="60" cy="60" r="56" />
      <line x1="60" y1="34" x2="60" y2="23" stroke="#7cc4ff" strokeWidth="2" />
      <circle className="ant" cx="60" cy="20" r="3.5" fill="#ffffff" />
      <rect x="26" y="48" width="6" height="16" rx="2" fill="#0b4a94" stroke="#7cc4ff" />
      <rect x="88" y="48" width="6" height="16" rx="2" fill="#0b4a94" stroke="#7cc4ff" />
      <rect x="32" y="34" width="56" height="46" rx="10" fill="#031428" stroke="#3aa0ff" strokeWidth="2.5" />
      <rect className="eye" x="42" y="47" width="10" height="10" rx="2" fill="#ffffff" />
      <rect className="eye" x="68" y="47" width="10" height="10" rx="2" fill="#ffffff" />
      {[0, 1, 2, 3, 4].map((i) => (
        <rect key={i} className="bar" x={42 + i * 8} y="64" width="5" height="9" rx="1" fill="#19ff7a"
          style={{ animationDelay: i * 0.12 + 's' }} />
      ))}
      <rect x="40" y="84" width="40" height="18" rx="6" fill="#031428" stroke="#3aa0ff" strokeWidth="2" />
      <circle className="chest" cx="60" cy="93" r="3.5" fill="#19ff7a" />
    </svg>
  )
}

export default function Ai({ active, tradeOn, send, cur, demo, addHist, updHist }) {
  const [cfg, setCfg] = useState(() => {
    try {
      const st = JSON.parse(localStorage.bbfx_ai || '{}')
      const m = { ...DEF, ...st }
      if (st.rwins === undefined && st.cdiv) m.rwins = Math.max(1, Math.round(Number(st.cdiv)) || 1)
      return m
    } catch { return DEF }
  })
  const [running, setRunning] = useState(false)
  const [stats, setStats] = useState({ net: 0, wins: 0, losses: 0, idx: 0, w: 0 })
  const [log, setLog] = useState([])
  const [msg, setMsg] = useState('')
  const [waitTxt, setWaitTxt] = useState('')
  const [watch, setWatch] = useState('')
  const [ladderOpen, setLadderOpen] = useState(true)
  const [fOpen, setFOpen] = useState(true)
  const [calcOpen, setCalcOpen] = useState(true)
  const [mini, setMini] = useState({})
  const [, force] = useState(0)

  const cfgRef = useRef(cfg)
  const botRef = useRef(BOTS[0])
  const runRef = useRef(false)
  const busy = useRef(false)
  const idxRef = useRef(0)
  const levelRef = useRef(0)
  const winsRef = useRef(0)
  const netRef = useRef(0)
  const errs = useRef(0)
  const digs = useRef({})
  const pip = useRef({})
  const reqs = useRef({})
  const openC = useRef(null)
  const seq = useRef(100000)
  const dog = useRef(null)
  const gate = useRef(null)
  const rfsm = useRef({})
  const lastBest = useRef(null)
  const sendRef = useRef(send)
  const tradeOnRef = useRef(tradeOn)
  const curRef = useRef(cur)
  const helpers = useRef({})
  const bot = BOTN[cfg.bot] || BOTS[0]
  const isDiff = bot.id === 'diff'
  const dW = clamp(Math.round(+cfg.dwin || 500), 100, 2000)
  const dS = clamp(Math.round(+cfg.dspeed || 30), 5, 200)
  const ladderUI = isDiff && cfg.dstake === 'ladder'
  const filterUI = isDiff && cfg.dmode === 'filter'
  const scanOn = isDiff && cfg.rstrat === 'scan'
  const monSyms = scanOn ? SYMS.map((x) => x[0]) : cfg.syms
  const keep = Math.max(filterUI ? dW + dS + 20 : 60, scanOn ? clamp(Math.round(+cfg.rwin || 200), 50, 1000) + 20 : 0)
  cfgRef.current = cfg
  botRef.current = bot
  sendRef.current = send
  tradeOnRef.current = tradeOn
  curRef.current = cur
  helpers.current = { addHist, updHist }

  useEffect(() => { localStorage.bbfx_ai = JSON.stringify(cfg) }, [cfg])

  // stake calculator: write the calculated stakes into the stake list and the ladder
  const applyCalc = () => {
    const c0 = cfgRef.current
    const l = calcStakes(c0)
    const div = Math.max(1, Math.round(Number(c0.cdiv) || 1))
    setCfg((c) => ({
      ...c,
      stakes: l.map((v) => v.toFixed(2)).join(', '),
      rwins: div,
      ladder: l.map((v, i) => ({ stake: v, runs: i === 0 ? 1 : div })),
    }))
  }
  const calcKey = [cfg.cbase, cfg.cmult, cfg.cdiv, cfg.csteps, cfg.cmode, cfg.cround].join('|')
  const calcFirst = useRef(true)
  useEffect(() => {
    if (calcFirst.current) { calcFirst.current = false; return }
    if (!cfgRef.current.cauto || runRef.current) return
    applyCalc()
  }, [calcKey])
  const setC = (p) => setCfg((c) => ({ ...c, ...p }))
  const addLog = (t) => setLog((l) => ['[' + stamp() + '] ' + t, ...l].slice(0, 14))
  const ladderOn = () => botRef.current.id === 'diff' && cfgRef.current.dstake === 'ladder'
  const inRecovery = () => (ladderOn() ? levelRef.current > 0 : idxRef.current > 0)
  const recMode = () =>
    botRef.current.id === 'diff' && !!cfgRef.current.rstrat && cfgRef.current.rstrat !== 'same' && inRecovery()
  // signal used while recovering
  const recoveryDecide = (sym, a, c) => {
    if (!a.length) return null
    const d = a[a.length - 1]
    if (c.rstrat === 'over0') return { type: 'DIGITOVER', barrier: 0 }
    if (c.rstrat === 'under9') return { type: 'DIGITUNDER', barrier: 9 }
    const B = clamp(Math.round(+c.rover || 1), 0, 8)
    const U = clamp(Math.round(+c.runder || 2), 1, 9)
    const N = clamp(Math.round(+c.rconf || 1), 1, 5)
    const st = rfsm.current[sym] || (rfsm.current[sym] = { phase: 'wait_under', cnt: 0 })
    const under = d < U
    const over = d > B
    if (st.phase === 'wait_under') {
      if (under) { st.phase = 'wait_over'; st.cnt = 0 }
      return null
    }
    if (st.phase === 'wait_over') {
      if (under || !over) { st.cnt = 0; return null }
      st.cnt += 1
      if (st.cnt >= N) { st.phase = 'run'; st.cnt = 0; return { type: 'DIGITOVER', barrier: B } }
      return null
    }
    if (under) { st.phase = 'wait_over'; st.cnt = 0; return null }
    return over ? { type: 'DIGITOVER', barrier: B } : null
  }
  const recoveryStep = (sym, a, c) => (c.rstrat === 'scan' ? scanDecide(sym, a, c) : recoveryDecide(sym, a, c))
  // the contract whose losing digits are rarest, over every market
  const scanBest = (c, sticky) => {
    const W = clamp(Math.round(+c.rwin || 200), 50, 1000)
    const need = Math.min(W, 100)
    let best = null
    SYMS.forEach(([sym]) => {
      const a = digs.current[sym] || []
      if (a.length < need) return
      const w = a.slice(-W)
      const n = w.length
      const pLow = (w.filter((d) => d <= 1).length / n) * 100
      const pHigh = (w.filter((d) => d >= 8).length / n) * 100
      if (c.rpick !== 'under8' && (!best || pLow < best.p)) best = { sym, type: 'DIGITOVER', barrier: 1, p: pLow }
      if (c.rpick !== 'over1' && (!best || pHigh < best.p)) best = { sym, type: 'DIGITUNDER', barrier: 8, p: pHigh }
    })
    if (best && sticky && lastBest.current) {
      const lb = lastBest.current
      const a = digs.current[lb.sym] || []
      const allowed = lb.type === 'DIGITOVER' ? c.rpick !== 'under8' : c.rpick !== 'over1'
      if (allowed && a.length >= need) {
        const w = a.slice(-W)
        const bad = (w.filter((d) => (lb.type === 'DIGITOVER' ? d <= 1 : d >= 8)).length / w.length) * 100
        if (bad <= best.p + 0.5) best = { ...lb, p: bad }
      }
    }
    return best
  }
  // confirmation tracker for one market and contract
  const stepFsm = (sym, type, d, N) => {
    const bad = type === 'DIGITOVER' ? d <= 1 : d >= 8
    const key = sym + type
    const st = rfsm.current[key] || (rfsm.current[key] = { phase: 'wait_bad', cnt: 0 })
    let go = false
    if (st.phase === 'wait_bad') {
      if (bad) { st.phase = 'wait_good'; st.cnt = 0 }
    } else if (st.phase === 'wait_good') {
      if (bad) st.cnt = 0
      else { st.cnt += 1; if (st.cnt >= N) { st.phase = 'run'; st.cnt = 0; go = true } }
    } else if (bad) { st.phase = 'wait_good'; st.cnt = 0 } else go = true
    return go
  }
  const scanDecide = (sym, a, c) => {
    if (!a.length) return null
    const d = a[a.length - 1]
    const N = clamp(Math.round(+c.rconf || 1), 1, 5)
    const goOver = stepFsm(sym, 'DIGITOVER', d, N)
    const goUnder = stepFsm(sym, 'DIGITUNDER', d, N)
    const best = scanBest(c, true)
    if (!best) return null
    lastBest.current = best
    if (best.sym !== sym) return null
    const dec = { type: best.type, barrier: best.barrier }
    if (c.rentry === 'tick') return dec
    return (best.type === 'DIGITOVER' ? goOver : goUnder) ? dec : null
  }

  const stakesList = () => {
    const l = parseStakes(cfgRef.current.stakes)
    return l.length ? l : [1]
  }
  const ladderList = () => {
    const l = (cfgRef.current.ladder || [])
      .map((b) => ({ stake: Number(b.stake), runs: Math.max(1, Math.round(Number(b.runs) || 1)) }))
      .filter((b) => isFinite(b.stake) && b.stake >= 0.35)
    return l.length ? l : DEF_LADDER
  }
  const rawStake = () => {
    if (ladderOn()) {
      const L = ladderList()
      return L[Math.min(levelRef.current, L.length - 1)].stake
    }
    const l = stakesList()
    return l[Math.min(idxRef.current, l.length - 1)]
  }
  const curStake = () => {
    const v = rawStake()
    const c = cfgRef.current
    if (botRef.current.id !== 'diff' || c.rstrat !== 'scan' || !inRecovery()) return v
    const cut = clamp(+c.rcut || 0, 0, 60)
    return Math.max(0.35, Math.round(v * (1 - cut / 100) * 100) / 100)
  }

  const stopBot = (why) => {
    runRef.current = false
    gate.current = null
    setWaitTxt('')
    setRunning(false)
    clearTimeout(dog.current)
    busy.current = false
    openC.current = null
    setMsg(why ? '■ ' + why : 'Stopped')
    if (why) addLog('■ ' + why)
  }

  const place = (sym, dec) => {
    const stake = curStake()
    if (netRef.current - stake <= -Math.abs(+cfgRef.current.sl)) {
      stopBot('Next stake ' + stake + ' could pass your stop loss, stopped')
      return
    }
    const meta = {
      sym, stake, type: dec.type, barrier: hasB(dec.type) ? dec.barrier : null, bot: botRef.current.name + (recMode() ? ' (recovery)' : ''),
    }
    busy.current = true
    const rid = ++seq.current
    reqs.current[rid] = { kind: 'proposal', meta }
    const p = {
      proposal: 1, subscribe: 1, req_id: rid, amount: stake, basis: 'stake',
      contract_type: dec.type, currency: curRef.current || 'USD', duration: 1,
      duration_unit: 't', underlying_symbol: sym,
    }
    if (meta.barrier !== null) p.barrier = String(meta.barrier)
    sendRef.current(p)
    const lv = ladderOn() ? ' [' + LETTERS[Math.min(levelRef.current, 11)] + ']' : ''
    addLog(meta.bot + ' FIRE ' + SYMN[sym] + ' ' + label(dec) + ' stake ' + stake + lv)
    clearTimeout(dog.current)
    dog.current = setTimeout(() => {
      if (busy.current && !openC.current) {
        busy.current = false
        addLog('No reply to the trade request, skipped')
      }
    }, 12000)
  }

  const evalTick = (sym) => {
    if (!runRef.current || !tradeOnRef.current) return
    const c = cfgRef.current
    const a = digs.current[sym] || []
    const rec = recMode()
    const mine = c.syms.includes(sym)
    if (busy.current) {
      if (rec && (c.rstrat === 'scan' || mine)) recoveryStep(sym, a, c)
      return
    }
    const g = gate.current
    if (g) {
      if (sym !== g.sym) return
      if (!g.ok) {
        if (isWin(g.type, a[a.length - 1], g.barrier)) g.ok = true
        return
      }
      gate.current = null
      setWaitTxt('')
    }
    if (rec) {
      if (c.rstrat !== 'scan' && !mine) return
      const rdec = recoveryStep(sym, a, c)
      if (rdec) place(sym, rdec)
      return
    }
    if (!mine) return
    const b = botRef.current
    if (a.length < b.need) return
    const dec = b.decide(a, c)
    if (dec) place(sym, dec)
  }

  const finish = (c) => {
    const o = openC.current
    if (!o) return
    const profit = Number(c.profit)
    if (Number.isNaN(profit)) return
    openC.current = null
    clearTimeout(dog.current)
    const ex = typeof c.exit_tick_display_value === 'string' ? +c.exit_tick_display_value.slice(-1) : NaN
    helpers.current.updHist(c.contract_id, {
      status: profit >= 0 ? 'win' : 'loss', profit, exit: Number.isNaN(ex) ? undefined : ex,
    })
    const wasRec = inRecovery()
    netRef.current += profit
    let endStop = false
    let note = ''
    let showIdx = 0
    let showW = 0
    if (ladderOn()) {
      const L = ladderList()
      let lvl = levelRef.current
      let w = winsRef.current
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
          if (cfgRef.current.end === 'stop') endStop = true
          lvl = 0
          note = ' · ladder finished'
        } else note = ' · jump to ' + LETTERS[lvl]
      }
      levelRef.current = lvl
      winsRef.current = w
      showIdx = lvl
      showW = w
    } else {
      const list = stakesList()
      const need = botRef.current.id === 'diff' ? clamp(Math.round(+cfgRef.current.rwins || 1), 1, 50) : 1
      let idx = idxRef.current
      let w = winsRef.current
      if (profit >= 0) {
        if (idx > 0) {
          w += 1
          if (w >= need) { note = ' · recovered, back to the first stake'; idx = 0; w = 0 }
          else note = ' · recovery ' + w + '/' + need
        }
      } else {
        idx += 1
        w = 0
        if (idx >= list.length) {
          if (cfgRef.current.end === 'stop') endStop = true
          idx = 0
          note = ' · list finished'
        } else note = ' · jump to stake ' + (idx + 1)
      }
      idxRef.current = idx
      winsRef.current = w
      showIdx = idx
      showW = w
    }
    if (!wasRec && inRecovery()) rfsm.current = {}
    if (profit < 0 && cfgRef.current.after !== 'now') {
      gate.current = { sym: o.meta.sym, type: o.meta.type, barrier: o.meta.barrier, ok: false }
      setWaitTxt('Cooling down after the loss: waiting for a winning digit on ' + SYMN[o.meta.sym] + ', then the next signal')
    } else {
      gate.current = null
      setWaitTxt('')
    }
    setStats((s) => ({
      net: netRef.current, wins: s.wins + (profit >= 0 ? 1 : 0), losses: s.losses + (profit < 0 ? 1 : 0),
      idx: showIdx, w: showW,
    }))
    addLog(
      (profit >= 0 ? 'WIN  ' : 'LOSS ') + SYMN[o.meta.sym] + ' ' + TN[o.meta.type] +
      (o.meta.barrier !== null ? ' ' + o.meta.barrier : '') + ' · ' + (profit >= 0 ? '+' : '') + profit.toFixed(2) +
      note + ' → next stake ' + curStake()
    )
    busy.current = false
    const c2 = cfgRef.current
    if (netRef.current <= -Math.abs(+c2.sl)) return stopBot('Stop loss reached')
    if (+c2.tp > 0 && netRef.current >= +c2.tp) return stopBot('Take profit reached')
    if (endStop) return stopBot('Reached the end of the ladder')
  }

  // messages from the trading socket
  useEffect(() => {
    const h = (m) => {
      if (m.msg_type === 'proposal_open_contract') {
        const c = m.proposal_open_contract
        const o = openC.current
        if (o && c && String(c.contract_id) === o.id && c.is_sold) {
          if (m.subscription) sendRef.current({ forget: m.subscription.id })
          finish(c)
        }
        return
      }
      const rid = m.req_id || (m.echo_req && m.echo_req.req_id)
      if (!rid || rid < 100000) return
      const r = reqs.current[rid]
      if (!r) return
      if (m.error) {
        if (r.kind === 'proposal' || r.kind === 'buy') {
          busy.current = false
          clearTimeout(dog.current)
          addLog('⚠ ' + (m.error.code || '') + ' ' + m.error.message)
          errs.current += 1
          if (errs.current >= 3) stopBot('Stopped after repeated errors')
        }
        return
      }
      if (m.msg_type === 'proposal' && r.kind === 'proposal') {
        if (r.done) return
        r.done = true
        const brid = ++seq.current
        reqs.current[brid] = { kind: 'buy', meta: r.meta, subId: m.subscription && m.subscription.id }
        sendRef.current({ buy: m.proposal.id, price: Number(m.proposal.ask_price) || r.meta.stake, req_id: brid })
      } else if (m.msg_type === 'buy' && r.kind === 'buy') {
        if (r.subId) sendRef.current({ forget: r.subId })
        errs.current = 0
        const id = m.buy.contract_id
        openC.current = { id: String(id), meta: r.meta }
        helpers.current.addHist({
          id, t: Date.now(), symbol: r.meta.sym, type: r.meta.type, barrier: r.meta.barrier,
          stake: Number(m.buy.buy_price), status: 'open',
        })
        sendRef.current({ proposal_open_contract: 1, contract_id: id, subscribe: 1, req_id: ++seq.current })
        clearTimeout(dog.current)
        dog.current = setTimeout(() => {
          if (openC.current) stopBot('No result received for the last trade, stopped for safety')
        }, 65000)
      }
    }
    bus.fns.add(h)
    return () => bus.fns.delete(h)
  }, [])

  // tick monitor for the selected markets
  useEffect(() => {
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
          const h = m.history || {}
          const pp = m.pip_size ?? h.pip_size ?? pip.current[sym] ?? 2
          pip.current[sym] = pp
          digs.current[sym] = (h.prices || []).map((p) => +Number(p).toFixed(pp).slice(-1)).slice(-keep)
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
          pip.current[sym] = t.pip_size
          const d = +t.quote.toFixed(t.pip_size).slice(-1)
          digs.current[sym] = [...(digs.current[sym] || []).slice(-(keep - 1)), d]
          evalTick(sym)
        }
      }
    }
    connect()
    const refresh = setInterval(() => force((x) => x + 1), 500)
    const vis = () => { if (document.visibilityState === 'visible' && sock) sock.close() }
    document.addEventListener('visibilitychange', vis)
    return () => {
      dead = true
      clearTimeout(retry)
      clearInterval(refresh)
      document.removeEventListener('visibilitychange', vis)
      if (sock) sock.close()
    }
  }, [monSyms.join(','), keep])

  useEffect(() => {
    if (!tradeOn && runRef.current) stopBot('Trading connection lost, agent stopped')
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
    if (ladderOn()) {
      const lad = c.ladder || []
      const bad = lad.findIndex((b) => !(Number(b.stake) >= 0.35))
      if (bad >= 0) return setMsg('Block ' + LETTERS[bad] + ' needs a stake of at least 0.35')
      if (lad.length < 2) return setMsg('Add at least one recovery block (B)')
    } else if (!parseStakes(c.stakes).length) {
      return setMsg('Add at least one stake (minimum 0.35)')
    }
    if (!(+c.sl > 0)) return setMsg('Set a stop loss above 0')
    if (!demo && !confirm('REAL account. The agent will place trades automatically with real money. Start?')) return
    gate.current = null
    setWaitTxt('')
    netRef.current = 0
    idxRef.current = 0
    levelRef.current = 0
    winsRef.current = 0
    rfsm.current = {}
    errs.current = 0
    busy.current = false
    openC.current = null
    setStats({ net: 0, wins: 0, losses: 0, idx: 0, w: 0 })
    runRef.current = true
    setRunning(true)
    setMsg('Agent online')
    addLog(botRef.current.name + ' ONLINE')
  }

  const togSym = (v) =>
    setC({ syms: cfg.syms.includes(v) ? cfg.syms.filter((x) => x !== v) : [...cfg.syms, v] })

  // ladder editing
  const ladder = cfg.ladder || DEF_LADDER
  const setBlock = (i, p) => setC({ ladder: ladder.map((b, j) => (j === i ? { ...b, ...p } : b)) })
  const addBlock = () => {
    const last = Number(ladder[ladder.length - 1].stake) || 1
    setC({ ladder: [...ladder, { stake: Math.round(last * 3.5 * 100) / 100, runs: 4 }] })
  }
  const delBlock = (i) => { setC({ ladder: ladder.filter((_, j) => j !== i) }); setMini({}) }

  const wsym = cfg.syms.includes(watch) ? watch : cfg.syms[0]
  const arr = (wsym && digs.current[wsym]) || []
  const decNow = arr.length >= bot.need ? bot.decide(arr, cfg) : null
  const recUI = isDiff && cfg.rstrat && cfg.rstrat !== 'same' && stats.idx > 0
  const scanW = clamp(Math.round(+cfg.rwin || 200), 50, 1000)
  const scanNow = scanOn ? scanBest(cfg, false) : null
  const scanRows = scanOn ? SYMS.map(([sym, nm]) => {
    const a = digs.current[sym] || []
    if (a.length < 50) return { sym, nm, ok: false }
    const w = a.slice(-scanW)
    const n = w.length
    return { sym, nm, ok: true, lo: (w.filter((d) => d <= 1).length / n) * 100, hi: (w.filter((d) => d >= 8).length / n) * 100 }
  }) : []
  const info = filterUI && arr.length >= 100 ? diffInfo(arr, cfg) : null
  const lastD = arr.length ? arr[arr.length - 1] : -1
  const rstate = running ? (busy.current ? 'trade' : gate.current ? 'wait' : 'scan') : 'idle'
  const shown = parseStakes(cfg.stakes).length ? parseStakes(cfg.stakes) : [1]
  const lad = ladderList()
  const calcList = calcStakes(cfg)
  const calcTotal = calcList.reduce((a, b) => a + b, 0)
  const calcSl = Math.abs(+cfg.sl || 0)
  let calcReach = 0
  let calcCum = 0
  for (let i = 0; i < calcList.length; i++) {
    if (calcCum + calcList[i] < calcSl) calcReach = i
    else break
    calcCum += calcList[i]
  }
  const nextStake0 = ladderUI ? lad[Math.min(stats.idx, lad.length - 1)].stake : shown[Math.min(stats.idx, shown.length - 1)]
  const nextStake = scanOn && stats.idx > 0
    ? Math.max(0.35, Math.round(nextStake0 * (1 - clamp(+cfg.rcut || 0, 0, 60) / 100) * 100) / 100)
    : nextStake0
  const live = running
    ? (rstate === 'trade' ? 'EXECUTING' : rstate === 'wait' ? 'COOLDOWN' : 'SCANNING') + ' ' + (SYMN[wsym] || '-') +
      ' :: digit ' + (arr.length ? arr[arr.length - 1] : '…') + (recUI ? ' :: RECOVERY (' + cfg.rstrat + ')' : ' :: ' + (decNow ? 'SIGNAL ' + label(decNow) : 'no signal'))
    : 'AGENT OFFLINE :: choose a strategy and press START'
  const status = rstate === 'idle' ? 'STANDBY' : rstate === 'scan' ? 'SCANNING' : rstate === 'trade' ? 'EXECUTING' : 'COOLING DOWN'

  return (
    <>
      <MatrixRain active={active} />

      <section className="card hero">
        <div className="ai-title">AI STRATEGIES</div>
        <div className="ai-sub">NEURAL DIGIT AGENTS // RULE-BASED</div>
        <Robot state={rstate} />
        <div className={'agent ' + rstate}>{bot.name} · {status}</div>
      </section>

      <section className="card">
        <b>Choose your agent</b>
        <div className="bots">
          {BOTS.map((b) => (
            <button key={b.id} disabled={running} className={'botc' + (b.id === bot.id ? ' on' : '')} onClick={() => setC({ bot: b.id })}>
              <b>{b.name}</b>
              <small>{b.desc}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <button className={'buy ' + (running ? 'odd' : 'even')} onClick={running ? () => stopBot('Stopped by you') : start}>
          {running ? 'STOP AGENT' : 'START AGENT'}
        </button>
        {msg && <div className="muted">{msg}</div>}
        {waitTxt && <div className="waitbox">⏳ {waitTxt}</div>}
        <div className="sum">
          <div><small>Net P/L</small><b className={stats.net >= 0 ? 'win' : 'loss'}>{stats.net >= 0 ? '+' : ''}{stats.net.toFixed(2)}</b></div>
          <div><small>Win / Loss</small><b>{stats.wins} / {stats.losses}</b></div>
          <div><small>{ladderUI ? 'Block ' + LETTERS[Math.min(stats.idx, 11)] + ' stake' : isDiff ? 'Stake ' + (stats.idx + 1) + (stats.idx > 0 ? ' · ' + stats.w + '/' + clamp(Math.round(+cfg.rwins || 1), 1, 50) : '') : 'Next stake'}</small><b>{nextStake}</b></div>
        </div>
      </section>

      {isDiff && (
        <section className="card">
          <b>DIFF-RADAR setup</b>
          <label>Signal
            <select disabled={running} value={cfg.dmode} onChange={(e) => setC({ dmode: e.target.value })}>
              <option value="classic">Classic: digit seen N+ times in the last M ticks</option>
              <option value="filter">Filtered: skip low-%, high-% and fast digits</option>
            </select>
          </label>
          {cfg.dmode !== 'filter' && (
            <div className="row">
              <label>Seen at least (times)
                <input type="number" min="2" max="50" disabled={running} value={cfg.ccount} onChange={(e) => setC({ ccount: e.target.value })} />
              </label>
              <label>In the last (ticks)
                <input type="number" min="5" max="100" disabled={running} value={cfg.cwin} onChange={(e) => setC({ cwin: e.target.value })} />
              </label>
            </div>
          )}
          <label>Staking
            <select disabled={running} value={cfg.dstake} onChange={(e) => setC({ dstake: e.target.value })}>
              <option value="list">Stake list (martingale steps)</option>
              <option value="ladder">Recovery ladder (blocks A, B, C…)</option>
            </select>
          </label>
          <div className="muted">
            {cfg.dmode === 'filter'
              ? 'Differs on the digit that just appeared unless the digit filter skips it.'
              : 'When the digit that just appeared has been seen ' + (cfg.ccount || 5) + '+ times in the last ' + (cfg.cwin || 20) + ' ticks, trade Differs on it.'}
          </div>
        </section>
      )}

      {isDiff && (
        <section className="card">
          <div className="pcthead">
            <b>STAKE CALCULATOR</b>
            <button className="smallbtn" onClick={() => setCalcOpen((o) => !o)}>{calcOpen ? 'Minimise' : 'Expand'}</button>
          </div>
          {calcOpen && (
            <>
              <div className="muted">Builds your stake list and recovery blocks from your main stake. Each recovery stake = losses so far × multiply by ÷ divide by.</div>
              <div className="row">
                <label>Main stake
                  <input type="number" min="0.35" step="0.05" disabled={running} value={cfg.cbase} onChange={(e) => setC({ cbase: e.target.value })} />
                </label>
                <label>Multiply by
                  <input type="number" min="1" step="0.5" disabled={running} value={cfg.cmult} onChange={(e) => setC({ cmult: e.target.value })} />
                </label>
              </div>
              <div className="row">
                <label>Divide by (wins to recover)
                  <input type="number" min="1" max="50" disabled={running} value={cfg.cdiv} onChange={(e) => setC({ cdiv: e.target.value })} />
                </label>
                <label>Recovery steps
                  <input type="number" min="1" max="11" disabled={running} value={cfg.csteps} onChange={(e) => setC({ csteps: e.target.value })} />
                </label>
              </div>
              <div className="row">
                <label>Count losses
                  <select disabled={running} value={cfg.cmode} onChange={(e) => setC({ cmode: e.target.value })}>
                    <option value="cum">All losses so far</option>
                    <option value="prev">Last stake only</option>
                  </select>
                </label>
                <label>Round up to
                  <select disabled={running} value={String(cfg.cround)} onChange={(e) => setC({ cround: +e.target.value })}>
                    {[0.01, 0.05, 0.1, 0.5, 1].map((n) => <option key={n} value={String(n)}>{n}</option>)}
                  </select>
                </label>
              </div>
              <div className="calcrow">
                {calcList.map((v, i) => <span key={i} className="cchip"><b>{LETTERS[i]}</b>{v.toFixed(2)}</span>)}
              </div>
              <div className="muted">
                If every step loses you are down {calcTotal.toFixed(2)}. With your stop loss of {calcSl} the agent can reach block {LETTERS[calcReach]} (stake {calcList[calcReach].toFixed(2)}).
              </div>
              <div className="row">
                <label>Auto-update stakes
                  <select disabled={running} value={cfg.cauto ? 'on' : 'off'} onChange={(e) => setC({ cauto: e.target.value === 'on' })}>
                    <option value="on">On: stakes follow these numbers</option>
                    <option value="off">Off: only when I tap Apply</option>
                  </select>
                </label>
                <button disabled={running} onClick={applyCalc}>Apply now</button>
              </div>
            </>
          )}
        </section>
      )}

      {isDiff && (
        <section className="card">
          <b>RECOVERY STRATEGY</b>
          <div className="muted">After a loss, trade this instead of Differs until the recovery stake has won the number of times you set, then go back to DIFF-RADAR.</div>
          <label>Strategy during recovery
            <select disabled={running} value={cfg.rstrat} onChange={(e) => setC({ rstrat: e.target.value })}>
              <option value="same">Same as main (Differs)</option>
              <option value="over1c">Over 1 after confirmation (about 80% win chance)</option>
              <option value="over0">Over 0 every tick (about 90% win chance)</option>
              <option value="under9">Under 9 every tick (about 90% win chance)</option>
              <option value="scan">Over 1 / Under 8 on the best market (scans all markets)</option>
            </select>
          </label>
          {cfg.rstrat === 'over1c' && (
            <>
              <div className="row">
                <label>Trade Over
                  <input type="number" min="0" max="8" disabled={running} value={cfg.rover} onChange={(e) => setC({ rover: e.target.value })} />
                </label>
                <label>Under means below
                  <input type="number" min="1" max="9" disabled={running} value={cfg.runder} onChange={(e) => setC({ runder: e.target.value })} />
                </label>
              </div>
              <label>Over digits to confirm
                <input type="number" min="1" max="5" disabled={running} value={cfg.rconf} onChange={(e) => setC({ rconf: e.target.value })} />
              </label>
              <div className="muted">After an under digit, wait for the confirming over digit(s), then trade Over {cfg.rover || 1} and keep going until an under digit appears.</div>
            </>
          )}
          {cfg.rstrat === 'scan' && (
            <>
              <div className="row">
                <label>Contracts to scan
                  <select disabled={running} value={cfg.rpick} onChange={(e) => setC({ rpick: e.target.value })}>
                    <option value="both">Over 1 and Under 8</option>
                    <option value="over1">Over 1 only</option>
                    <option value="under8">Under 8 only</option>
                  </select>
                </label>
                <label>Percent window (ticks)
                  <input type="number" min="50" max="1000" disabled={running} value={cfg.rwin} onChange={(e) => setC({ rwin: e.target.value })} />
                </label>
              </div>
              <div className="row">
                <label>Entry
                  <select disabled={running} value={cfg.rentry} onChange={(e) => setC({ rentry: e.target.value })}>
                    <option value="confirm">After confirmation</option>
                    <option value="tick">Every tick</option>
                  </select>
                </label>
                <label>Digits to confirm
                  <input type="number" min="1" max="5" disabled={running} value={cfg.rconf} onChange={(e) => setC({ rconf: e.target.value })} />
                </label>
              </div>
              <label>Make recovery stakes cheaper by (%)
                <input type="number" min="0" max="60" step="5" disabled={running} value={cfg.rcut} onChange={(e) => setC({ rcut: e.target.value })} />
              </label>
              <div className="muted">
                {scanNow
                  ? 'Best now: ' + (SYMS.find((x) => x[0] === scanNow.sym) || [0, scanNow.sym])[1] + ' · ' + (scanNow.type === 'DIGITOVER' ? 'Over 1 (0s and 1s ' : 'Under 8 (8s and 9s ') + scanNow.p.toFixed(1) + '%)'
                  : 'Loading ticks for all markets…'}
              </div>
              <div className="scangrid">
                <b>Market</b><b>0-1 %</b><b>8-9 %</b>
                {scanRows.map((r) => {
                  const bestRow = scanNow && scanNow.sym === r.sym
                  return [
                    <span key={r.sym + 'n'} className={bestRow ? 'best' : ''}>{r.nm}</span>,
                    <span key={r.sym + 'a'} className={bestRow && scanNow.type === 'DIGITOVER' ? 'best' : ''}>{r.ok ? r.lo.toFixed(1) : '…'}</span>,
                    <span key={r.sym + 'b'} className={bestRow && scanNow.type === 'DIGITUNDER' ? 'best' : ''}>{r.ok ? r.hi.toFixed(1) : '…'}</span>,
                  ]
                })}
              </div>
            </>
          )}
          {cfg.rstrat !== 'same' && (
            <>
              <div className="muted">
                {cfg.rstrat === 'over1c'
                  ? 'Over 1 pays about 22%, so a recovery stake of about losses × 4.5 ÷ wins needed repays a loss. Set the calculator to 4.5.'
                  : cfg.rstrat === 'scan' ? 'Over 1 and Under 8 pay about 22%, so a recovery stake near losses × 4.5 ÷ wins needed repays a loss. Set the calculator to 4.5, then the cut above makes it a little cheaper.' : 'This pays about 9%, like Differs, so recovery stakes stay near losses × 11 ÷ wins needed. Set the calculator to 11.'}
              </div>
              <button disabled={running} onClick={() => setC({ cmult: cfg.rstrat === 'over1c' || cfg.rstrat === 'scan' ? 4.5 : 11 })}>
                Set calculator multiplier to {cfg.rstrat === 'over1c' || cfg.rstrat === 'scan' ? '4.5' : '11'}
              </button>
            </>
          )}
          <div className="muted">A higher win chance means a smaller profit per win. Switching contracts changes how often and how much you win or lose, not the overall odds.</div>
        </section>
      )}

      {filterUI && (
        <section className="card">
          <div className="pcthead">
            <b>DIGIT FILTER</b>
            <button className="smallbtn" onClick={() => setFOpen((o) => !o)}>{fOpen ? 'Minimise' : 'Expand'}</button>
          </div>
          {fOpen && (
            <>
              <div className="muted">
                Trades Differs on the digit that just appeared, unless it is one of the skipped digits below.
                {info ? '' : ' Loading ticks…'}
              </div>
              <div className="fchips">
                {Array.from({ length: 10 }, (_, d) => {
                  const st = !info ? '' : info.low.has(d) ? 'low' : info.high.has(d) ? 'high' : info.fast.has(d) ? 'fast' : 'ok'
                  return (
                    <div key={d} className={'fchip ' + st + (d === lastD ? ' last' : '')}>
                      <b>{d}</b>
                      <small>{info ? info.now[d].toFixed(1) + '%' : '…'}</small>
                      <small>{st === 'ok' ? 'ok' : st === 'low' ? 'skip low' : st === 'high' ? 'skip high' : st === 'fast' ? 'fast' : ''}</small>
                    </div>
                  )
                })}
              </div>
              <div className="row">
                <label>Percent window (ticks)
                  <input type="number" min="100" max="2000" disabled={running} value={cfg.dwin} onChange={(e) => setC({ dwin: e.target.value })} />
                </label>
                <label>Skip lowest-% digits
                  <select disabled={running} value={cfg.dlow} onChange={(e) => setC({ dlow: +e.target.value })}>
                    {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
              </div>
              <div className="row">
                <label>Skip highest-% digits
                  <select disabled={running} value={cfg.dhigh} onChange={(e) => setC({ dhigh: +e.target.value })}>
                    {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                <label>Skip fast-moving digits
                  <select disabled={running} value={cfg.dfast ? 'on' : 'off'} onChange={(e) => setC({ dfast: e.target.value === 'on' })}>
                    <option value="on">On</option>
                    <option value="off">Off</option>
                  </select>
                </label>
              </div>
              <div className="row">
                <label>Fast = moved by (points)
                  <input type="number" min="0.1" step="0.1" disabled={running} value={cfg.dfastN} onChange={(e) => setC({ dfastN: e.target.value })} />
                </label>
                <label>…over the last (ticks)
                  <input type="number" min="5" max="200" disabled={running} value={cfg.dspeed} onChange={(e) => setC({ dspeed: e.target.value })} />
                </label>
              </div>
              <div className="muted">Percentages describe the past. Each new tick is independent, so a filter cannot predict the next digit.</div>
            </>
          )}
        </section>
      )}

      {ladderUI && (
        <section className="card">
          <div className="pcthead">
            <b>RECOVERY LADDER</b>
            <button className="smallbtn" onClick={() => setLadderOpen((o) => !o)}>{ladderOpen ? 'Minimise' : 'Expand'}</button>
          </div>
          {ladderOpen && (
            <>
              <div className="muted">
                A is your main stake. When a trade loses, the bot jumps to the next block and runs its stake until it has won the number of times you set, then goes back to A. A loss inside a block jumps to the next block.
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
                            <input type="number" min="0.35" step="0.05" disabled={running} value={b.stake} onChange={(e) => setBlock(i, { stake: e.target.value })} />
                          </label>
                          <label>Wins needed
                            {i === 0
                              ? <input disabled value="main" readOnly />
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
        <div className="pcthead">
          <b>LIVE FEED</b>
          <select value={wsym || ''} onChange={(e) => setWatch(e.target.value)} disabled={!cfg.syms.length}>
            {cfg.syms.map((v) => <option key={v} value={v}>{SYMN[v]}</option>)}
          </select>
        </div>
        <div className="stream">
          {arr.slice(-24).map((d, i, a) => <b key={i} className={i === a.length - 1 ? 'last' : ''}>{d}</b>)}
        </div>
        <div className="term">
          <div className="ln live">{'> ' + live}</div>
          {log.map((l, i) => <div className="ln" key={i}>{l}</div>)}
        </div>
      </section>

      <section className="card">
        <b>Agent settings</b>
        {!ladderUI && (
          <label>Stake list (martingale steps, comma separated)
            <input type="text" inputMode="text" disabled={running} value={cfg.stakes} onChange={(e) => setC({ stakes: e.target.value })} />
          </label>
        )}
        {!ladderUI && isDiff && (
          <label>Wins needed at each recovery stake
            <input type="number" min="1" max="50" disabled={running} value={cfg.rwins} onChange={(e) => setC({ rwins: e.target.value })} />
          </label>
        )}
        <div className="row">
          <label>{ladderUI ? 'After the last block loses' : 'At end of list'}
            <select disabled={running} value={cfg.end} onChange={(e) => setC({ end: e.target.value })}>
              <option value="restart">{ladderUI ? 'Restart at A' : 'Restart at first stake'}</option>
              <option value="stop">Stop the agent</option>
            </select>
          </label>
          <label>After a loss
            <select disabled={running} value={cfg.after} onChange={(e) => setC({ after: e.target.value })}>
              <option value="win">Wait for a winning digit</option>
              <option value="now">Trade on next signal</option>
            </select>
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
        <div className="muted">Agents follow fixed digit rules. They do not predict ticks and cannot remove risk.</div>
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
          const d = a.length >= bot.need ? bot.decide(a, cfg) : null
          return (
            <div className="arow" key={sym}>
              <button className={'sname' + (sym === wsym ? ' sel' : '')} onClick={() => setWatch(sym)}>{SYMN[sym]}</button>
              <b>{a.length ? a[a.length - 1] : '…'}</b>
              <span className={'sig' + (d ? ' on' : '')}>{d ? label(d) : a.length < bot.need ? 'loading' : 'scanning'}</span>
            </div>
          )
        })}
      </section>
    </>
  )
}
