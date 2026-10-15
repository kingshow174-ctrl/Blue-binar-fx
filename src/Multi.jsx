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
const test = (cond, n, d) =>
  cond === 'lt' ? d < n : cond === 'gt' ? d > n : cond === 'eq' ? d === n : cond === 'even' ? d % 2 === 0 : d % 2 === 1
const parseStakes = (s) =>
  String(s).split(/[\s,;]+/).map(Number).filter((x) => isFinite(x) && x >= 0.35)
const DEF = {
  condK: 1, cond: 'lt', condN: 2, type: 'DIGITOVER', barrier: 1, dur: 1,
  stakes: '1, 2, 4, 8', end: 'restart', sl: 10, tp: 10, syms: ['R_100'],
}

export default function Multi({ tradeOn, send, cur, demo, addHist, updHist }) {
  const [cfg, setCfg] = useState(() => {
    try { return { ...DEF, ...JSON.parse(localStorage.bbfx_multi || '{}') } } catch { return DEF }
  })
  const [running, setRunning] = useState(false)
  const [stats, setStats] = useState({ net: 0, trades: 0, wins: 0, losses: 0, idx: 0 })
  const [log, setLog] = useState([])
  const [msg, setMsg] = useState('')
  const [watch, setWatch] = useState('')
  const [, force] = useState(0)

  const cfgRef = useRef(cfg)
  const runRef = useRef(false)
  const busy = useRef(false)
  const idxRef = useRef(0)
  const netRef = useRef(0)
  const errs = useRef(0)
  const digs = useRef({})
  const pip = useRef({})
  const reqs = useRef({})
  const openC = useRef(null)
  const seq = useRef(500)
  const dog = useRef(null)
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
  const addLog = (t) => setLog((l) => [t, ...l].slice(0, 12))
  const nid = () => ++seq.current
  const stakesList = () => {
    const l = parseStakes(cfgRef.current.stakes)
    return l.length ? l : [1]
  }

  const stopBot = (why) => {
    runRef.current = false
    setRunning(false)
    clearTimeout(dog.current)
    busy.current = false
    openC.current = null
    setMsg(why ? '■ ' + why : 'Stopped')
    if (why) addLog('■ ' + why)
  }

  const place = (sym) => {
    const c = cfgRef.current
    const list = stakesList()
    const stake = list[Math.min(idxRef.current, list.length - 1)]
    const barrier = hasB(c.type) ? +c.barrier : null
    busy.current = true
    const rid = nid()
    reqs.current[rid] = { kind: 'proposal', meta: { sym, stake, type: c.type, barrier, dur: +c.dur || 1 } }
    const p = {
      proposal: 1, subscribe: 1, req_id: rid, amount: stake, basis: 'stake',
      contract_type: c.type, currency: curRef.current || 'USD', duration: +c.dur || 1,
      duration_unit: 't', underlying_symbol: sym,
    }
    if (barrier !== null) p.barrier = String(barrier)
    sendRef.current(p)
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
    const c = cfgRef.current
    const k = Math.max(1, +c.condK || 1)
    const a = digs.current[sym] || []
    if (a.length < k) return
    if (a.slice(-k).every((d) => test(c.cond, +c.condN, d))) place(sym)
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
    setStats((s) => ({
      net: netRef.current, trades: s.trades + 1, wins: s.wins + (profit >= 0 ? 1 : 0),
      losses: s.losses + (profit < 0 ? 1 : 0), idx,
    }))
    addLog(
      (profit >= 0 ? '✅ ' : '❌ ') + SYMN[o.meta.sym] + ' ' + TYPEN[o.meta.type] +
      (o.meta.barrier !== null ? ' ' + o.meta.barrier : '') + ' · stake ' + o.meta.stake +
      ' · ' + (profit >= 0 ? '+' : '') + profit.toFixed(2)
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
      if (!rid || rid < 500) return
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
        const brid = nid()
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
        sendRef.current({ proposal_open_contract: 1, contract_id: id, subscribe: 1, req_id: nid() })
        clearTimeout(dog.current)
        dog.current = setTimeout(() => {
          if (openC.current) stopBot('No result received for the last trade, stopped for safety')
        }, 60000 + r.meta.dur * 3000)
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
    if (!tradeOn && runRef.current) stopBot('Trading connection lost, bot stopped')
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
    if (c.type === 'DIGITOVER' && +c.barrier === 9) return setMsg('Over needs a digit 0-8')
    if (c.type === 'DIGITUNDER' && +c.barrier === 0) return setMsg('Under needs a digit 1-9')
    if (!demo && !confirm('REAL account. The bot will place trades automatically with real money. Start?')) return
    netRef.current = 0
    idxRef.current = 0
    errs.current = 0
    busy.current = false
    openC.current = null
    setStats({ net: 0, trades: 0, wins: 0, losses: 0, idx: 0 })
    runRef.current = true
    setRunning(true)
    setMsg('Running')
  }

  const togSym = (v) =>
    setC({ syms: cfg.syms.includes(v) ? cfg.syms.filter((x) => x !== v) : [...cfg.syms, v] })

  const wsym = cfg.syms.includes(watch) ? watch : cfg.syms[0]
  const arr = (wsym && digs.current[wsym]) || []
  const bnum = +cfg.barrier
  const k = Math.max(1, +cfg.condK || 1)
  const metOf = (a) => a.length >= k && a.slice(-k).every((d) => test(cfg.cond, +cfg.condN, d))
  const kindOf = (d) =>
    cfg.type === 'DIGITOVER' || cfg.type === 'DIGITUNDER'
      ? (d > bnum ? ['O', 'g'] : d < bnum ? ['U', 'r'] : ['S', 'b'])
      : cfg.type === 'DIGITMATCH' || cfg.type === 'DIGITDIFF'
      ? (d === bnum ? ['M', 'g'] : ['D', 'r'])
      : (d % 2 ? ['O', 'r'] : ['E', 'g'])
  const ldpLabel =
    cfg.type === 'DIGITOVER' || cfg.type === 'DIGITUNDER'
      ? 'O over ' + bnum + ' · S same · U under'
      : cfg.type === 'DIGITMATCH' || cfg.type === 'DIGITDIFF'
      ? 'M = digit ' + bnum + ' · D = other digits'
      : 'E even · O odd'
  const list = parseStakes(cfg.stakes)
  const shown = list.length ? list : [1]
  const nextStake = shown[Math.min(stats.idx, shown.length - 1)]
  const needN = ['lt', 'gt', 'eq'].includes(cfg.cond)

  return (
    <>
      <section className="card">
        <div className="pcthead">
          <b>LDP</b>
          <span className={'badge ' + (metOf(arr) ? 'on' : '')}>{metOf(arr) ? 'CONDITION MET' : 'waiting'}</span>
        </div>
        <select value={wsym || ''} onChange={(e) => setWatch(e.target.value)} disabled={!cfg.syms.length}>
          {cfg.syms.map((v) => <option key={v} value={v}>{SYMN[v]}</option>)}
        </select>
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
        <div className="sum">
          <div><small>Net P/L</small><b className={stats.net >= 0 ? 'win' : 'loss'}>{stats.net >= 0 ? '+' : ''}{stats.net.toFixed(2)}</b></div>
          <div><small>Win / Loss</small><b>{stats.wins} / {stats.losses}</b></div>
          <div><small>Next stake</small><b>{nextStake}</b></div>
        </div>
      </section>

      <section className="card">
        <b>Strategy</b>
        <div className="row">
          <label>Last digits to check
            <input type="number" min="1" max="10" disabled={running} value={cfg.condK} onChange={(e) => setC({ condK: e.target.value })} />
          </label>
          <label>Condition
            <select disabled={running} value={cfg.cond} onChange={(e) => setC({ cond: e.target.value })}>
              {CONDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        </div>
        {needN && (
          <label>Digit
            <input type="number" min="0" max="9" disabled={running} value={cfg.condN} onChange={(e) => setC({ condN: e.target.value })} />
          </label>
        )}
        <div className="row">
          <label>Then trade
            <select disabled={running} value={cfg.type} onChange={(e) => setC({ type: e.target.value })}>
              {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label>Ticks
            <input type="number" min="1" max="10" disabled={running} value={cfg.dur} onChange={(e) => setC({ dur: e.target.value })} />
          </label>
        </div>
        {hasB(cfg.type) && (
          <div className="pick">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
              <button key={d} disabled={running} className={bnum === d ? 'on' : ''} onClick={() => setC({ barrier: d })}>{d}</button>
            ))}
          </div>
        )}
        <div className="muted">
          When the last {k} digit{k > 1 ? 's' : ''} {CONDN[cfg.cond]}{needN ? ' ' + cfg.condN : ''} → {TYPEN[cfg.type]}{hasB(cfg.type) ? ' ' + bnum : ''}
        </div>
      </section>

      <section className="card">
        <b>Stakes, stop loss, take profit</b>
        <label>Stake list (martingale steps, comma separated)
          <input type="text" inputMode="decimal" disabled={running} value={cfg.stakes} onChange={(e) => setC({ stakes: e.target.value })} />
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
        <label>Take profit (0 = off)
          <input type="number" min="0" step="0.5" disabled={running} value={cfg.tp} onChange={(e) => setC({ tp: e.target.value })} />
        </label>
        <div className="muted">Stakes go up after each loss, so losses can grow fast. Pick a stop loss you can afford.</div>
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
          const met = metOf(a)
          return (
            <div className="mrow" key={sym}>
              <button className={'sname' + (sym === wsym ? ' sel' : '')} onClick={() => setWatch(sym)}>{SYMN[sym]}</button>
              <b>{a.length ? a[a.length - 1] : '…'}</b>
              <span className={'met' + (met ? ' on' : '')}>{met ? 'MET' : 'wait'}</span>
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
