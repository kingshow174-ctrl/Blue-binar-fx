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
    desc: 'Digit seen 4+ times in the last 20 and just appeared → Differs on it',
    decide: (a) => {
      const w = a.slice(-20)
      const d = w[w.length - 1]
      return w.filter((x) => x === d).length >= 4 ? { type: 'DIGITDIFF', barrier: d } : null
    },
  },
  {
    id: 'wave', name: 'UNDER-WAVE', need: 2,
    desc: '2 digits in a row at 8 or 9 → Under 8',
    decide: (a) => (a.slice(-2).every((d) => d >= 8) ? { type: 'DIGITUNDER', barrier: 8 } : null),
  },
]
const BOTN = Object.fromEntries(BOTS.map((b) => [b.id, b]))
const DEF = { bot: 'neo', syms: ['R_100'], stakes: '1, 2, 4, 8', end: 'restart', after: 'win', sl: 10, tp: 10 }

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
    try { return { ...DEF, ...JSON.parse(localStorage.bbfx_ai || '{}') } } catch { return DEF }
  })
  const [running, setRunning] = useState(false)
  const [stats, setStats] = useState({ net: 0, wins: 0, losses: 0, idx: 0 })
  const [log, setLog] = useState([])
  const [msg, setMsg] = useState('')
  const [waitTxt, setWaitTxt] = useState('')
  const [watch, setWatch] = useState('')
  const [, force] = useState(0)

  const cfgRef = useRef(cfg)
  const botRef = useRef(BOTS[0])
  const runRef = useRef(false)
  const busy = useRef(false)
  const idxRef = useRef(0)
  const netRef = useRef(0)
  const errs = useRef(0)
  const digs = useRef({})
  const pip = useRef({})
  const reqs = useRef({})
  const openC = useRef(null)
  const seq = useRef(100000)
  const dog = useRef(null)
  const gate = useRef(null)
  const sendRef = useRef(send)
  const tradeOnRef = useRef(tradeOn)
  const curRef = useRef(cur)
  const helpers = useRef({})
  const bot = BOTN[cfg.bot] || BOTS[0]
  cfgRef.current = cfg
  botRef.current = bot
  sendRef.current = send
  tradeOnRef.current = tradeOn
  curRef.current = cur
  helpers.current = { addHist, updHist }

  useEffect(() => { localStorage.bbfx_ai = JSON.stringify(cfg) }, [cfg])
  const setC = (p) => setCfg((c) => ({ ...c, ...p }))
  const addLog = (t) => setLog((l) => ['[' + stamp() + '] ' + t, ...l].slice(0, 14))
  const stakesList = () => {
    const l = parseStakes(cfgRef.current.stakes)
    return l.length ? l : [1]
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
    const list = stakesList()
    const stake = list[Math.min(idxRef.current, list.length - 1)]
    const meta = {
      sym, stake, type: dec.type, barrier: hasB(dec.type) ? dec.barrier : null, bot: botRef.current.name,
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
    addLog(meta.bot + ' FIRE ' + SYMN[sym] + ' ' + label(dec) + ' stake ' + stake)
    clearTimeout(dog.current)
    dog.current = setTimeout(() => {
      if (busy.current && !openC.current) {
        busy.current = false
        addLog('No reply to the trade request, skipped')
      }
    }, 12000)
  }

  const evalTick = (sym) => {
    if (!runRef.current || busy.current || !tradeOnRef.current) return
    const a = digs.current[sym] || []
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
    const b = botRef.current
    if (a.length < b.need) return
    const dec = b.decide(a)
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
    netRef.current += profit
    const list = stakesList()
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
    if (profit < 0 && cfgRef.current.after !== 'now') {
      gate.current = { sym: o.meta.sym, type: o.meta.type, barrier: o.meta.barrier, ok: false }
      setWaitTxt('Cooling down after the loss: waiting for a winning digit on ' + SYMN[o.meta.sym] + ', then the next signal')
    } else {
      gate.current = null
      setWaitTxt('')
    }
    setStats((s) => ({
      net: netRef.current, wins: s.wins + (profit >= 0 ? 1 : 0), losses: s.losses + (profit < 0 ? 1 : 0), idx,
    }))
    addLog(
      (profit >= 0 ? 'WIN  ' : 'LOSS ') + SYMN[o.meta.sym] + ' ' + TN[o.meta.type] +
      (o.meta.barrier !== null ? ' ' + o.meta.barrier : '') + ' · ' + (profit >= 0 ? '+' : '') + profit.toFixed(2)
    )
    busy.current = false
    const c2 = cfgRef.current
    if (netRef.current <= -Math.abs(+c2.sl)) return stopBot('Stop loss reached')
    if (+c2.tp > 0 && netRef.current >= +c2.tp) return stopBot('Take profit reached')
    if (endStop) return stopBot('Reached the end of the stake list')
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
          const h = m.history || {}
          const pp = m.pip_size ?? h.pip_size ?? pip.current[sym] ?? 2
          pip.current[sym] = pp
          digs.current[sym] = (h.prices || []).map((p) => +Number(p).toFixed(pp).slice(-1)).slice(-60)
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
          digs.current[sym] = [...(digs.current[sym] || []).slice(-59), d]
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
  }, [cfg.syms.join(',')])

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
    if (!parseStakes(c.stakes).length) return setMsg('Add at least one stake (minimum 0.35)')
    if (!(+c.sl > 0)) return setMsg('Set a stop loss above 0')
    if (!demo && !confirm('REAL account. The agent will place trades automatically with real money. Start?')) return
    gate.current = null
    setWaitTxt('')
    netRef.current = 0
    idxRef.current = 0
    errs.current = 0
    busy.current = false
    openC.current = null
    setStats({ net: 0, wins: 0, losses: 0, idx: 0 })
    runRef.current = true
    setRunning(true)
    setMsg('Agent online')
    addLog(botRef.current.name + ' ONLINE')
  }

  const togSym = (v) =>
    setC({ syms: cfg.syms.includes(v) ? cfg.syms.filter((x) => x !== v) : [...cfg.syms, v] })

  const wsym = cfg.syms.includes(watch) ? watch : cfg.syms[0]
  const arr = (wsym && digs.current[wsym]) || []
  const decNow = arr.length >= bot.need ? bot.decide(arr) : null
  const rstate = running ? (busy.current ? 'trade' : gate.current ? 'wait' : 'scan') : 'idle'
  const shown = parseStakes(cfg.stakes).length ? parseStakes(cfg.stakes) : [1]
  const nextStake = shown[Math.min(stats.idx, shown.length - 1)]
  const live = running
    ? (rstate === 'trade' ? 'EXECUTING' : rstate === 'wait' ? 'COOLDOWN' : 'SCANNING') + ' ' + (SYMN[wsym] || '-') +
      ' :: digit ' + (arr.length ? arr[arr.length - 1] : '…') + ' :: ' + (decNow ? 'SIGNAL ' + label(decNow) : 'no signal')
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
          <div><small>Next stake</small><b>{nextStake}</b></div>
        </div>
      </section>

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
        <label>Stake list (martingale steps, comma separated)
          <input type="text" inputMode="decimal" disabled={running} value={cfg.stakes} onChange={(e) => setC({ stakes: e.target.value })} />
        </label>
        <div className="row">
          <label>At end of list
            <select disabled={running} value={cfg.end} onChange={(e) => setC({ end: e.target.value })}>
              <option value="restart">Restart at first stake</option>
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
          const d = a.length >= bot.need ? bot.decide(a) : null
          return (
            <div className="arow" key={sym}>
              <button className={'sname' + (sym === wsym ? ' sel' : '')} onClick={() => setWatch(sym)}>{SYMN[sym]}</button>
              <b>{a.length ? a[a.length - 1] : '…'}</b>
              <span className={'sig' + (d ? ' on' : '')}>{d ? label(d) : 'scanning'}</span>
            </div>
          )
        })}
      </section>
    </>
  )
}
