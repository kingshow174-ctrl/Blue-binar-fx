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
const norm = (a) => {
  const id = a.account_id || a.accountId || a.loginid || a.id
  const t = String(a.account_type || a.type || '').toLowerCase()
  return { id, demo: t === 'demo' || /^(DOT|VRT)/.test(id || '') }
}

export default function App() {
  const pub = useRef(null)
  const trd = useRef(null)
  const pending = useRef(false)
  const subId = useRef(null)
  const [token, setToken] = useState(sessionStorage.getItem('bbfx_token') || '')
  const [accounts, setAccounts] = useState([])
  const [accId, setAccId] = useState('')
  const [status, setStatus] = useState('connecting')
  const [tradeOn, setTradeOn] = useState(false)
  const [symbol, setSymbol] = useState('R_100')
  const [digits, setDigits] = useState([])
  const [price, setPrice] = useState('-')
  const [bal, setBal] = useState('')
  const [cur, setCur] = useState('USD')
  const [mode, setMode] = useState('eo')
  const [barrier, setBarrier] = useState(5)
  const [stake, setStake] = useState(1)
  const [dur, setDur] = useState(1)
  const [log, setLog] = useState([])

  const addLog = (t) => setLog((l) => [t, ...l].slice(0, 15))
  const pubSend = (o) => pub.current?.readyState === 1 && pub.current.send(JSON.stringify(o))
  const trdSend = (o) => trd.current?.readyState === 1 && trd.current.send(JSON.stringify(o))
  const headers = { Authorization: 'Bearer ' + token, 'Deriv-App-ID': APP_ID }
  const acct = accounts.find((a) => a.id === accId)

  // OAuth callback
  useEffect(() => {
    if (location.pathname === '/callback') {
      handleCallback().then(setToken).catch((e) => addLog('Login failed: ' + e.message))
    }
  }, [])

  // Public ticks socket
  useEffect(() => {
    const s = new WebSocket(PUBLIC_WS)
    pub.current = s
    s.onopen = () => setStatus('online')
    s.onclose = () => setStatus('offline')
    s.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.error) return addLog('⚠ ' + m.error.message)
      if (m.msg_type === 'tick') {
        const t = m.tick
        const p = t.quote.toFixed(t.pip_size)
        setPrice(p)
        setDigits((d) => [...d.slice(-199), +p.slice(-1)])
      }
    }
    return () => s.close()
  }, [])

  useEffect(() => {
    if (status !== 'online') return
    pubSend({ forget_all: 'ticks' })
    setDigits([])
    pubSend({ ticks: symbol, subscribe: 1 })
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
      .catch((e) => { addLog('⚠ Accounts: ' + e.message); logout() })
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
      .catch((e) => addLog('⚠ OTP: ' + e.message))
    return () => { dead = true; s?.close(); setTradeOn(false) }
  }, [token, accId])

  function onTrade(e) {
    const m = JSON.parse(e.data)
    if (m.error) { pending.current = false; return addLog('⚠ ' + (m.error.code || '') + ' ' + m.error.message) }
    if (m.msg_type === 'balance') {
      setBal(Number(m.balance.balance).toFixed(2))
      setCur(m.balance.currency)
    } else if (m.msg_type === 'proposal' && pending.current) {
      const st = pending.current
      subId.current = m.subscription?.id
      pending.current = false
      trdSend({ buy: m.proposal.id, price: Number(m.proposal.ask_price) || st })
    } else if (m.msg_type === 'buy') {
      if (subId.current) { trdSend({ forget: subId.current }); subId.current = null }
      addLog(`Bought #${m.buy.contract_id} @ ${m.buy.buy_price}`)
      trdSend({ proposal_open_contract: 1, contract_id: m.buy.contract_id, subscribe: 1 })
    } else if (m.msg_type === 'proposal_open_contract') {
      const c = m.proposal_open_contract
      if (c.is_sold) {
        addLog(`${c.profit >= 0 ? '✅ WIN' : '❌ LOSS'} ${c.profit} ${c.currency || ''}`)
        if (m.subscription) trdSend({ forget: m.subscription.id })
      }
    }
  }

  const trade = (type) => {
    if (!tradeOn) return addLog('Log in first')
    if (acct && !acct.demo && !confirm('REAL account. Place this trade?')) return
    const p = {
      proposal: 1, subscribe: 1, amount: +stake, basis: 'stake', contract_type: type, currency: cur,
      duration: +dur, duration_unit: 't', underlying_symbol: symbol,
    }
    if (type === 'DIGITOVER' && barrier === 9) return addLog('Over needs digit 0-8')
    if (type === 'DIGITUNDER' && barrier === 0) return addLog('Under needs digit 1-9')
    if (type !== 'DIGITEVEN' && type !== 'DIGITODD') p.barrier = String(barrier)
    pending.current = +stake || 1
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

      <section className="card">
        <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
          {SYMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <div className="price">{price}</div>
        <div className="big">{last ?? '-'}</div>
        <div className="muted">Last digit · Even {evenPct}% / Odd {100 - evenPct}%</div>
        <div className="strip">
          {digits.slice(-20).map((d, i) => <b key={i} className={d % 2 ? 'o' : 'e'}>{d}</b>)}
        </div>
      </section>

      <section className="card">
        <div className="muted">Digit frequency (last {last100.length})</div>
        <div className="bars">
          {counts.map((c, i) => (
            <div key={i} className={'bar' + (i === last ? ' cur' : '')}>
              <small>{Math.round((c / n) * 100)}%</small>
              <div className="track">
                <div className={'fill' + (c === max ? ' hi' : c === min ? ' lo' : '')} style={{ height: (c / n) * 100 * 4 + '%' }} />
              </div>
              <span>{i}</span>
            </div>
          ))}
        </div>
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
        {mode === 'ou' ? (
          <div className="row">
            <button className="buy even" onClick={() => trade('DIGITOVER')}>OVER {barrier}</button>
            <button className="buy odd" onClick={() => trade('DIGITUNDER')}>UNDER {barrier}</button>
          </div>
        ) : mode === 'eo' ? (
          <div className="row">
            <button className="buy even" onClick={() => trade('DIGITEVEN')}>EVEN</button>
            <button className="buy odd" onClick={() => trade('DIGITODD')}>ODD</button>
          </div>
        ) : (
          <div className="row">
            <button className="buy even" onClick={() => trade('DIGITMATCH')}>MATCHES {barrier}</button>
            <button className="buy odd" onClick={() => trade('DIGITDIFF')}>DIFFERS {barrier}</button>
          </div>
        )}
      </section>

      <section className="card">
        <div className="muted">Activity</div>
        {log.map((l, i) => <div key={i} className="log">{l}</div>)}
      </section>
    </div>
  )
}
