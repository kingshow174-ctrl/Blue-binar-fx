import { useEffect, useRef, useState } from 'react'
import { login, handleCallback } from './auth.js'

const APP_ID = import.meta.env.VITE_DERIV_CLIENT_ID
const PUBLIC_WS = 'wss://api.derivws.com/trading/v1/options/ws/public'
const SYMS = [
  ['R_10', 'Volatility 10'], ['R_25', 'Volatility 25'], ['R_50', 'Volatility 50'],
  ['R_75', 'Volatility 75'], ['R_100', 'Volatility 100'],
  ['1HZ10V', 'Vol 10 (1s)'], ['1HZ25V', 'Vol 25 (1s)'], ['1HZ50V', 'Vol 50 (1s)'],
  ['1HZ75V', 'Vol 75 (1s)'], ['1HZ100V', 'Vol 100 (1s)'],
]
const SYMN = Object.fromEntries(SYMS)
const NAMES = {
  DIGITEVEN: 'Even', DIGITODD: 'Odd', DIGITMATCH: 'Matches',
  DIGITDIFF: 'Differs', DIGITOVER: 'Over', DIGITUNDER: 'Under',
}
const norm = (a) => {
  const id = a.account_id || a.accountId || a.loginid || a.id
  const t = String(a.account_type || a.type || '').toLowerCase()
  return { id, demo: t === 'demo' || /^(DOT|VRT)/.test(id || '') }
}
const loadHist = () => {
  try {
    return JSON.parse(localStorage.bbfx_hist || '[]').map((h) =>
      h.status === 'open' ? { ...h, status: 'unknown' } : h)
  } catch { return [] }
}
const fmtTime = (t) =>
  new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })

export default function App() {
  const pub = useRef(null)
  const trd = useRef(null)
  const pending = useRef(null)
  const tradeMeta = useRef(null)
  const subId = useRef(null)
  const noteTimer = useRef(null)
  const [token, setToken] = useState(sessionStorage.getItem('bbfx_token') || '')
  const [accounts, setAccounts] = useState([])
  const [accId, setAccId] = useState('')
  const [status, setStatus] = useState('connecting')
  const [tradeOn, setTradeOn] = useState(false)
  const [tab, setTab] = useState('trader')
  const [symbol, setSymbol] = useState('R_100')
  const [digits, setDigits] = useState([])
  const [price, setPrice] = useState('-')
  const [bal, setBal] = useState('')
  const [cur, setCur] = useState('USD')
  const [mode, setMode] = useState('eo')
  const [barrier, setBarrier] = useState(5)
  const [stake, setStake] = useState(1)
  const [dur, setDur] = useState(1)
  const [win, setWin] = useState(100)
  const [hist, setHist] = useState(loadHist)
  const [notice, setNotice] = useState('')

  const note = (t) => {
    setNotice(t)
    clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setNotice(''), 5000)
  }
  const pubSend = (o) => pub.current?.readyState === 1 && pub.current.send(JSON.stringify(o))
  const trdSend = (o) => trd.current?.readyState === 1 && trd.current.send(JSON.stringify(o))
  const headers = { Authorization: 'Bearer ' + token, 'Deriv-App-ID': APP_ID }
  const acct = accounts.find((a) => a.id === accId)

  useEffect(() => { localStorage.bbfx_hist = JSON.stringify(hist.slice(0, 100)) }, [hist])

  // OAuth callback
  useEffect(() => {
    if (location.pathname === '/callback') {
      handleCallback().then(setToken).catch((e) => note('Login failed: ' + e.message))
    }
  }, [])

  // Public ticks socket (auto-reconnect, preloads last 200 ticks)
  const symRef = useRef('R_100')
  const pipRef = useRef(2)
  const subbed = useRef(false)
  const histTimer = useRef(null)
  symRef.current = symbol

  const subscribeTicks = () => {
    if (subbed.current) return
    subbed.current = true
    clearTimeout(histTimer.current)
    pubSend({ ticks: symRef.current, subscribe: 1 })
  }

  useEffect(() => {
    let dead = false
    let retry
    const connect = () => {
      const s = new WebSocket(PUBLIC_WS)
      pub.current = s
      s.onopen = () => setStatus('online')
      s.onclose = () => {
        setStatus('offline')
        if (!dead) retry = setTimeout(connect, 2000)
      }
      s.onmessage = (e) => {
        const m = JSON.parse(e.data)
        if (m.msg_type === 'history') {
          const req = m.echo_req?.ticks_history
          if (req && req !== symRef.current) return
          const h = m.history || {}
          const pip = m.pip_size ?? h.pip_size ?? pipRef.current
          pipRef.current = pip
          const prices = h.prices || []
          setDigits(prices.map((p) => +Number(p).toFixed(pip).slice(-1)).slice(-200))
          if (prices.length) setPrice(Number(prices[prices.length - 1]).toFixed(pip))
          subscribeTicks()
          return
        }
        if (m.error) {
          if (m.echo_req?.ticks_history) subscribeTicks()
          return note('⚠ ' + m.error.message)
        }
        if (m.msg_type === 'tick') {
          const t = m.tick
          pipRef.current = t.pip_size
          const p = t.quote.toFixed(t.pip_size)
          setPrice(p)
          setDigits((d) => [...d.slice(-199), +p.slice(-1)])
        }
      }
    }
    connect()
    const vis = () => {
      if (document.visibilityState === 'visible') pub.current?.close()
    }
    document.addEventListener('visibilitychange', vis)
    return () => {
      dead = true
      clearTimeout(retry)
      document.removeEventListener('visibilitychange', vis)
      pub.current?.close()
    }
  }, [])

  useEffect(() => {
    if (status !== 'online') return
    subbed.current = false
    pubSend({ forget_all: 'ticks' })
    setDigits([])
    pubSend({ ticks_history: symbol, count: 200, end: 'latest', style: 'ticks' })
    clearTimeout(histTimer.current)
    histTimer.current = setTimeout(subscribeTicks, 3000)
  }, [symbol, status])

  // Accounts after login
  useEffect(() => {
    if (!token) return
    fetch('/api/accounts', { headers })
      .then((r) => r.json())
      .then((j) => {
        const raw = Array.isArray(j.data) ? j.data : j.data?.accounts || []
        const list = raw.map(norm).filter((a) => a.id)
        if (!list.length) throw new Error(JSON.stringify(j.errors || j).slice(0, 120))
        setAccounts(list)
        setAccId((list.find((a) => a.demo) || list[0]).id)
      })
      .catch((e) => { note('⚠ Accounts: ' + e.message); logout() })
  }, [token])

  // Authenticated trading socket (OTP URL)
  useEffect(() => {
    if (!token || !accId) return
    let dead = false
    let s
    fetch(`/api/otp/${accId}`, { method: 'POST', headers })
      .then((r) => r.json())
      .then((j) => {
        if (dead) return
        const url = j.data?.url
        if (!url) throw new Error(JSON.stringify(j.errors || j).slice(0, 120))
        s = new WebSocket(url)
        trd.current = s
        s.onopen = () => { setTradeOn(true); s.send(JSON.stringify({ balance: 1, subscribe: 1 })) }
        s.onclose = () => setTradeOn(false)
        s.onmessage = onTrade
      })
      .catch((e) => note('⚠ OTP: ' + e.message))
    return () => { dead = true; s?.close(); setTradeOn(false) }
  }, [token, accId])

  function onTrade(e) {
    const m = JSON.parse(e.data)
    if (m.error) {
      pending.current = null
      return note('⚠ ' + (m.error.code || '') + ' ' + m.error.message)
    }
    if (m.msg_type === 'balance') {
      setBal(Number(m.balance.balance).toFixed(2))
      setCur(m.balance.currency)
    } else if (m.msg_type === 'proposal' && pending.current) {
      const st = pending.current
      pending.current = null
      subId.current = m.subscription?.id
      tradeMeta.current = st
      trdSend({ buy: m.proposal.id, price: Number(m.proposal.ask_price) || st.stake })
    } else if (m.msg_type === 'buy') {
      if (subId.current) { trdSend({ forget: subId.current }); subId.current = null }
      const meta = tradeMeta.current || {}
      setHist((h) => [{
        id: m.buy.contract_id, t: Date.now(), symbol: meta.symbol, type: meta.type,
        barrier: meta.barrier, stake: Number(m.buy.buy_price), status: 'open',
      }, ...h].slice(0, 100))
      trdSend({ proposal_open_contract: 1, contract_id: m.buy.contract_id, subscribe: 1 })
    } else if (m.msg_type === 'proposal_open_contract') {
      const c = m.proposal_open_contract
      if (c.is_sold) {
        const profit = Number(c.profit)
        const ex = c.exit_tick_display_value != null ? String(c.exit_tick_display_value).slice(-1) : undefined
        setHist((h) => h.map((x) => String(x.id) === String(c.contract_id)
          ? { ...x, status: profit >= 0 ? 'win' : 'loss', profit, exit: ex } : x))
        if (m.subscription) trdSend({ forget: m.subscription.id })
      }
    }
  }

  const trade = (type) => {
    if (!tradeOn) return note('Log in first')
    if (pending.current) return
    if (acct && !acct.demo && !confirm('REAL account. Place this trade?')) return
    if (type === 'DIGITOVER' && barrier === 9) return note('Over needs digit 0-8')
    if (type === 'DIGITUNDER' && barrier === 0) return note('Under needs digit 1-9')
    const hasB = type !== 'DIGITEVEN' && type !== 'DIGITODD'
    const p = {
      proposal: 1, subscribe: 1, amount: +stake, basis: 'stake', contract_type: type, currency: cur,
      duration: +dur, duration_unit: 't', underlying_symbol: symbol,
    }
    if (hasB) p.barrier = String(barrier)
    pending.current = { stake: +stake || 1, symbol, type, barrier: hasB ? barrier : null }
    setTimeout(() => { pending.current = null }, 8000)
    trdSend(p)
  }

  function logout() {
    sessionStorage.removeItem('bbfx_token')
    setToken(''); setAccounts([]); setAccId(''); setBal('')
  }

  const last100 = digits.slice(-100)
  const counts = Array(10).fill(0)
  last100.forEach((d) => counts[d]++)
  const n = last100.length || 1
  const max = Math.max(...counts)
  const min = Math.min(...counts)
  const last = digits[digits.length - 1]
  const evenPct = Math.round((counts.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0) / n) * 100)

  const sample = digits.slice(-Math.max(10, Math.min(200, +win || 100)))
  const sn = sample.length || 1
  const cnt = (fn) => sample.filter(fn).length
  const pct = (x) => Math.round((x / sn) * 100)
  const kindOf = (d) =>
    mode === 'eo' ? (d % 2 ? ['O', 'r'] : ['E', 'g'])
    : mode === 'md' ? (d === barrier ? ['M', 'g'] : ['D', 'r'])
    : d > barrier ? ['O', 'g'] : d < barrier ? ['U', 'r'] : ['S', 'b']
  const title = mode === 'eo' ? 'EVEN ODD' : mode === 'md' ? 'MATCH DIFFER' : 'OVER UNDER'
  const bars =
    mode === 'eo'
      ? [['EVEN', cnt((d) => d % 2 === 0), 'g'], ['ODD', cnt((d) => d % 2 === 1), 'r']]
      : mode === 'md'
      ? [['MATCH ' + barrier, cnt((d) => d === barrier), 'g'], ['DIFFERS ' + barrier, cnt((d) => d !== barrier), 'r']]
      : [['OVER ' + barrier, cnt((d) => d > barrier), 'g'], ['SAME ' + barrier, cnt((d) => d === barrier), 'b'], ['UNDER ' + barrier, cnt((d) => d < barrier), 'r']]
    const closed = hist.filter((h) => h.status === 'win' || h.status === 'loss')
  const wins = closed.filter((h) => h.status === 'win').length
  const net = closed.reduce((a, h) => a + (h.profit || 0), 0)

  return (
    <div className="app">
      <header>
        <h1>Blue Binary <span>FX</span></h1>
        <div className="acct">
          <i className={'dot ' + (token ? (tradeOn ? 'online' : 'connecting') : status)} />
          {token ? (bal ? `${bal} ${cur}` : '...') : status}
        </div>
      </header>

      <section className="card">
        {!token ? (
          <button className="save" onClick={login}>Log in with Deriv</button>
        ) : (
          <div className="row">
            <select value={accId} onChange={(e) => setAccId(e.target.value)}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.demo ? 'DEMO' : 'REAL'} · {a.id}</option>)}
            </select>
            <button onClick={logout}>Log out</button>
          </div>
        )}
      </section>

      <div className="tabs">
        <button className={tab === 'trader' ? 'on' : ''} onClick={() => setTab('trader')}>Trader</button>
        <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>
          History{hist.length ? ` (${hist.length})` : ''}
        </button>
      </div>

      {tab === 'trader' && (
        <>
          <section className="card">
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {SYMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <div className="price">{price}</div>
            <div className="big">{last ?? '-'}</div>
            <div className="muted">Last digit · Even {evenPct}% / Odd {100 - evenPct}%</div>
            <div className="osu">
              {Array.from({ length: 30 }, (_, i) => {
                const d = digits[digits.length - 1 - i]
                if (d === undefined) return <b key={i} className="x">·</b>
                const [l, c] = kindOf(d)
                return <b key={i} className={c + (i === 0 ? ' new' : '')}>{l}</b>
              })}
            </div>
          </section>

          <section className="card">
            <div className="pcthead">
              <b>{title} PERCENTAGES</b>
              <input type="number" min="10" max="200" value={win} onChange={(e) => setWin(e.target.value)} />
            </div>
            {bars.map(([label, c, col]) => (
              <div className="prow" key={label}>
                <span>{label}</span>
                <div className="ptrack">
                  <div className={'pfill ' + col} style={{ width: pct(c) + '%' }}>{pct(c)}%</div>
                </div>
              </div>
            ))}
          </section>

          <section className="card">
            <div className="tabs">
              <button className={mode === 'eo' ? 'on' : ''} onClick={() => setMode('eo')}>Even / Odd</button>
              <button className={mode === 'md' ? 'on' : ''} onClick={() => setMode('md')}>Matches / Differs</button>
              <button className={mode === 'ou' ? 'on' : ''} onClick={() => setMode('ou')}>Over / Under</button>
            </div>
            {mode !== 'eo' && (
              <div className="pick">
                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
                  <button key={d} className={barrier === d ? 'on' : ''} onClick={() => setBarrier(d)}>{d}</button>
                ))}
              </div>
            )}
            <div className="row">
              <label>Stake<input type="number" min="0.35" step="0.1" value={stake} onChange={(e) => setStake(e.target.value)} /></label>
              <label>Ticks<input type="number" min="1" max="10" value={dur} onChange={(e) => setDur(e.target.value)} /></label>
            </div>
          </section>
        </>
      )}

      {tab === 'history' && (
        <section className="card">
          <div className="sum">
            <div><small>Trades</small><b>{closed.length}</b></div>
            <div><small>Wins</small><b>{wins}</b></div>
            <div><small>Net P/L</small><b className={net >= 0 ? 'win' : 'loss'}>{net >= 0 ? '+' : ''}{net.toFixed(2)}</b></div>
          </div>
          {!hist.length && <div className="muted">No trades yet</div>}
          {hist.map((h) => (
            <div className="h" key={h.id}>
              <div>
                <b>{NAMES[h.type] || h.type}{h.barrier != null ? ' ' + h.barrier : ''}</b>
                <small>{SYMN[h.symbol] || h.symbol}</small>
                <small>{fmtTime(h.t)} · stake {h.stake}{h.exit != null ? ` · exit digit ${h.exit}` : ''}</small>
              </div>
              <div className={'pl ' + h.status}>
                {h.status === 'open' ? '...' : h.status === 'unknown' ? '?' : (h.profit >= 0 ? '+' : '') + Number(h.profit).toFixed(2)}
              </div>
            </div>
          ))}
          {hist.length > 0 && (
            <button onClick={() => { if (confirm('Clear history?')) setHist([]) }}>Clear history</button>
          )}
        </section>
      )}

      {tab === 'trader' && (
        <div className="overlay">
          <div className="inner">
            {notice && <div className="notice">{notice}</div>}
            {mode === 'eo' && (
              <div className="row">
                <button className="buy even" onClick={() => trade('DIGITEVEN')}>EVEN</button>
                <button className="buy odd" onClick={() => trade('DIGITODD')}>ODD</button>
              </div>
            )}
            {mode === 'md' && (
              <div className="row">
                <button className="buy even" onClick={() => trade('DIGITMATCH')}>MATCHES {barrier}</button>
                <button className="buy odd" onClick={() => trade('DIGITDIFF')}>DIFFERS {barrier}</button>
              </div>
            )}
            {mode === 'ou' && (
              <div className="row">
                <button className="buy even" onClick={() => trade('DIGITOVER')}>OVER {barrier}</button>
                <button className="buy odd" onClick={() => trade('DIGITUNDER')}>UNDER {barrier}</button>
              </div>
            )}
          </div>
        </div>
      )}
      {tab === 'history' && notice && <div className="notice floating">{notice}</div>}
    </div>
  )
}
