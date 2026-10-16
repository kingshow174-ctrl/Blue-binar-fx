import { useEffect, useRef, useState } from 'react'
import { login, handleCallback } from './auth.js'
import Multi from './Multi.jsx'
import Ai from './Ai.jsx'
import { bus } from './bus.js'

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
const TYPES = {
  eo: ['DIGITEVEN', 'DIGITODD'],
  md: ['DIGITMATCH', 'DIGITDIFF'],
  ou: ['DIGITOVER', 'DIGITUNDER'],
}
const hasBarrier = (t) => t !== 'DIGITEVEN' && t !== 'DIGITODD'
const isWin = (type, d, b) =>
  type === 'DIGITEVEN' ? d % 2 === 0
  : type === 'DIGITODD' ? d % 2 === 1
  : type === 'DIGITMATCH' ? d === b
  : type === 'DIGITDIFF' ? d !== b
  : type === 'DIGITOVER' ? d > b
  : d < b
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

const DEF_ALERT = { digits: [], thr: 15, dir: 'above', n: 100, syms: SYMS.map((x) => x[0]), sound: true }

export default function App() {
  const pub = useRef(null)
  const trd = useRef(null)
  const pending = useRef(null)
  const tradeMeta = useRef(null)
  const subId = useRef(null)
  const noteTimer = useRef(null)
  const armedProps = useRef({})
  const reqType = useRef({})
  const armTimer = useRef(null)
  const buying = useRef(false)
  const retried = useRef(false)
  const waiting = useRef([])
  const resultTimer = useRef(null)
  const symRef = useRef('R_100')
  const pipRef = useRef(2)
  const subbed = useRef(false)
  const histTimer = useRef(null)

  const [token, setToken] = useState(() => {
    const t = localStorage.getItem('bbfx_token') || sessionStorage.getItem('bbfx_token') || ''
    const exp = +localStorage.getItem('bbfx_exp') || 0
    if (t && exp && Date.now() > exp - 5000) {
      localStorage.removeItem('bbfx_token')
      localStorage.removeItem('bbfx_exp')
      return ''
    }
    return t
  })
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
  const [armKey, setArmKey] = useState(0)
  const [hist, setHist] = useState(loadHist)
  const [notice, setNotice] = useState('')
  const [result, setResult] = useState(null)
  const tabsRef = useRef(null)
  useEffect(() => {
    const el = tabsRef.current && tabsRef.current.querySelector('button.on')
    if (el && el.scrollIntoView) el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [tab])
  const [acctKey, setAcctKey] = useState(0)
  const [tpOpen, setTpOpen] = useState(false)

  symRef.current = symbol

  const note = (t) => {
    setNotice(t)
    clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setNotice(''), 5000)
  }
  const showResultTimer = () => {
    clearTimeout(resultTimer.current)
    resultTimer.current = setTimeout(() => setResult(null), 7000)
  }
  const pubSend = (o) => pub.current?.readyState === 1 && pub.current.send(JSON.stringify(o))
  const trdSend = (o) => trd.current?.readyState === 1 && trd.current.send(JSON.stringify(o))
  const headers = { Authorization: 'Bearer ' + token, 'Deriv-App-ID': APP_ID }
  const acct = accounts.find((a) => a.id === accId)
  const lastDigit = (v) => {
    if (v == null) return undefined
    const str = typeof v === 'number' ? v.toFixed(pipRef.current) : String(v)
    const d = +str.slice(-1)
    return Number.isNaN(d) ? undefined : d
  }

  useEffect(() => { localStorage.bbfx_hist = JSON.stringify(hist.slice(0, 100)) }, [hist])

  // ---------- Digit alerts (scans several markets in the background) ----------
  const [al, setAl] = useState(() => {
    try { return { ...DEF_ALERT, ...JSON.parse(localStorage.bbfx_alert || '{}') } } catch { return DEF_ALERT }
  })
  const [monOn, setMonOn] = useState(false)
  const [popups, setPopups] = useState([])
  const [alog, setAlog] = useState([])
  const [, force] = useState(0)
  const mon = useRef({})
  const monPip = useRef({})
  const monWs = useRef(null)
  const fired = useRef(new Set())
  const alRef = useRef(al)
  const audio = useRef(null)
  const ringTimer = useRef(null)
  alRef.current = al
  const alN = Math.max(10, Math.min(5000, +al.n || 100))
  const setA = (patch) => setAl((a) => ({ ...a, ...patch }))
  useEffect(() => { localStorage.bbfx_alert = JSON.stringify(al) }, [al])

  const unlockAudio = () => {
    try {
      if (!audio.current) audio.current = new (window.AudioContext || window.webkitAudioContext)()
      audio.current.resume()
    } catch (e) {}
  }
  const ring = () => {
    const ctx = audio.current
    if (ctx && alRef.current.sound) {
      const now = ctx.currentTime
      for (let i = 0; i < 6; i++) {
        const o = ctx.createOscillator()
        const g = ctx.createGain()
        const t = now + i * 0.22
        o.type = 'sine'
        o.frequency.value = i % 2 ? 880 : 1175
        g.gain.setValueAtTime(0.0001, t)
        g.gain.exponentialRampToValueAtTime(0.4, t + 0.02)
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
        o.connect(g)
        g.connect(ctx.destination)
        o.start(t)
        o.stop(t + 0.21)
      }
    }
    if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300])
  }
  const stopRing = () => { clearInterval(ringTimer.current); ringTimer.current = null }
  const startRing = () => {
    ring()
    if (!ringTimer.current) {
      let k = 0
      ringTimer.current = setInterval(() => { ring(); if (++k >= 6) stopRing() }, 2500)
    }
  }
  const dismiss = () => { setPopups([]); stopRing() }
  const go = (sym) => { setSymbol(sym); if (tab === 'history') setTab('alerts'); dismiss() }
  const pctOf = (arr, n, d) => {
    const w = arr.slice(-n)
    return w.length ? (w.filter((x) => x === d).length / w.length) * 100 : 0
  }
  const hitOf = (p) => {
    const thr = parseFloat(al.thr)
    return !Number.isNaN(thr) && (al.dir === 'above' ? p >= thr : p <= thr)
  }
  const checkAlerts = (sym) => {
    const a = alRef.current
    const n = Math.max(10, Math.min(5000, +a.n || 100))
    const thr = parseFloat(a.thr)
    if (Number.isNaN(thr)) return
    const arr = mon.current[sym] || []
    if (arr.length < n) return
    a.digits.forEach((d) => {
      const p = pctOf(arr, n, d)
      const hit = a.dir === 'above' ? p >= thr : p <= thr
      const key = sym + ':' + d
      if (hit && !fired.current.has(key)) {
        fired.current.add(key)
        const item = { id: key + ':' + Date.now(), t: Date.now(), sym, digit: d, pct: p }
        setAlog((l) => [item, ...l].slice(0, 30))
        setPopups((ps) => [item, ...ps.filter((x) => !(x.sym === sym && x.digit === d))].slice(0, 6))
        startRing()
      } else if (!hit) {
        fired.current.delete(key)
      }
    })
  }
  const toggleMon = () => {
    if (monOn) { setMonOn(false); dismiss(); return }
    if (!al.digits.length) return note('Pick at least one digit')
    if (!al.syms.length) return note('Pick at least one market')
    unlockAudio()
    setMonOn(true)
  }
  const togDigit = (d) =>
    setA({ digits: al.digits.includes(d) ? al.digits.filter((x) => x !== d) : [...al.digits, d].sort((a, b) => a - b) })
  const togSym = (v) =>
    setA({ syms: al.syms.includes(v) ? al.syms.filter((x) => x !== v) : [...al.syms, v] })

  useEffect(() => {
    if (!monOn) return
    let dead = false
    let retry
    const syms = al.syms
    const N = Math.max(10, Math.min(5000, +alRef.current.n || 100))
    fired.current.clear()
    const connect = () => {
      const sock = new WebSocket(PUBLIC_WS)
      monWs.current = sock
      const subd = new Set()
      const sub = (sym) => {
        if (subd.has(sym) || sock.readyState !== 1) return
        subd.add(sym)
        sock.send(JSON.stringify({ ticks: sym, subscribe: 1 }))
      }
      sock.onopen = () => {
        mon.current = {}
        syms.forEach((sym) => {
          sock.send(JSON.stringify({ ticks_history: sym, count: N, end: 'latest', style: 'ticks' }))
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
          const pip = m.pip_size ?? h.pip_size ?? monPip.current[sym] ?? 2
          monPip.current[sym] = pip
          mon.current[sym] = (h.prices || []).map((p) => +Number(p).toFixed(pip).slice(-1)).slice(-N)
          sub(sym)
          checkAlerts(sym)
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
          monPip.current[sym] = t.pip_size
          const d = +t.quote.toFixed(t.pip_size).slice(-1)
          mon.current[sym] = [...(mon.current[sym] || []).slice(-(N - 1)), d]
          checkAlerts(sym)
        }
      }
    }
    connect()
    const refresh = setInterval(() => force((x) => x + 1), 1000)
    const vis = () => { if (document.visibilityState === 'visible') monWs.current && monWs.current.close() }
    document.addEventListener('visibilitychange', vis)
    return () => {
      dead = true
      clearTimeout(retry)
      clearInterval(refresh)
      document.removeEventListener('visibilitychange', vis)
      monWs.current && monWs.current.close()
    }
  }, [monOn, al.syms.join(',')])

  useEffect(() => {
    if (!monOn) return
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
  }, [monOn])

  // ---------- Circles analysis (own socket, up to 5000 ticks) ----------
  const [circSym, setCircSym] = useState('R_10')
  const [circNIn, setCircNIn] = useState(1000)
  const [cd, setCd] = useState([])
  const circN = Math.max(100, Math.min(5000, +circNIn || 1000))
  useEffect(() => { setCircSym(symbol) }, [symbol])
  useEffect(() => {
    if (tab !== 'alerts') return
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
        sock.send(JSON.stringify({ ticks: circSym, subscribe: 1 }))
      }
      sock.onopen = () => {
        setCd([])
        sock.send(JSON.stringify({ ticks_history: circSym, count: circN, end: 'latest', style: 'ticks' }))
        subTimer = setTimeout(sub, 4000)
      }
      sock.onclose = () => { if (!dead) retry = setTimeout(run, 2000) }
      sock.onmessage = (e) => {
        const m = JSON.parse(e.data)
        if (m.msg_type === 'history') {
          const h = m.history || {}
          const pip = m.pip_size ?? h.pip_size ?? 2
          setCd((h.prices || []).map((p) => +Number(p).toFixed(pip).slice(-1)).slice(-circN))
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
    const start = setTimeout(run, 600)
    return () => {
      dead = true
      clearTimeout(start)
      clearTimeout(retry)
      clearTimeout(subTimer)
      sock && sock.close()
    }
  }, [tab, circSym, circN])

  // pick up a login finished in another window
  useEffect(() => {
    const sync = () => {
      const t = localStorage.getItem('bbfx_token') || ''
      setToken((cur) => (t && t !== cur ? t : cur))
    }
    window.addEventListener('storage', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.removeEventListener('storage', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [])

  // ---------- OAuth callback ----------
  useEffect(() => {
    if (location.pathname === '/callback') {
      handleCallback().then(setToken).catch((e) => note('Login failed: ' + e.message))
    }
  }, [])

  // ---------- Public ticks socket (auto-reconnect, preloads last 200 ticks) ----------
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
          const dgt = +p.slice(-1)
          setPrice(p)
          setDigits((d) => [...d.slice(-199), dgt])
          if (waiting.current.length) {
            const ep = t.epoch ?? 0
            waiting.current.forEach((w) => {
              if (w.done || w.symbol !== symRef.current || ep <= w.pt) return
              w.seen++
              if (w.seen >= w.need) {
                w.done = true
                setResult({ digit: dgt, win: isWin(w.type, dgt, w.barrier), profit: null })
                showResultTimer()
                setHist((h) => h.map((x) => (String(x.id) === String(w.id) ? { ...x, exit: dgt } : x)))
              }
            })
          }
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

  // ---------- Accounts after login ----------
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
      .catch((e) => {
        note('⚠ Accounts: ' + e.message)
        if (/expired|unauthor|invalid_token|401/i.test(e.message)) autoLogin()
        else setTimeout(() => setAcctKey((k) => k + 1), 4000)
      })
  }, [token, acctKey])

  // ---------- Authenticated trading socket (auto-reconnect + keep-alive) ----------
  const autoLogin = () => {
    const last = +sessionStorage.getItem('bbfx_relogin') || 0
    if (Date.now() - last < 120000) { note('Session expired. Tap Log out, then log in again.'); return }
    sessionStorage.setItem('bbfx_relogin', String(Date.now()))
    login()
  }

  useEffect(() => {
    if (!token) return
    const t = setInterval(() => {
      const exp = +localStorage.getItem('bbfx_exp') || 0
      if (exp && Date.now() > exp - 20000) autoLogin()
    }, 15000)
    return () => clearInterval(t)
  }, [token])

  useEffect(() => {
    if (!token || !accId) return
    let dead = false
    let s
    let retry
    let ping
    const connect = () => {
      if (dead) return
      fetch('/api/otp/' + accId, { method: 'POST', headers })
        .then((r) => r.json())
        .then((j) => {
          if (dead) return
          const url = j.data?.url
          if (!url) {
            const txt = JSON.stringify(j.errors || j)
            if (/expired|unauthor|invalid_token|401/i.test(txt)) return autoLogin()
            throw new Error(txt.slice(0, 120))
          }
          s = new WebSocket(url)
          trd.current = s
          s.onopen = () => {
            setTradeOn(true)
            s.send(JSON.stringify({ balance: 1, subscribe: 1 }))
            clearInterval(ping)
            ping = setInterval(() => { if (s.readyState === 1) s.send(JSON.stringify({ ping: 1 })) }, 25000)
          }
          s.onclose = () => {
            clearInterval(ping)
            setTradeOn(false)
            if (!dead) retry = setTimeout(connect, 1500)
          }
          s.onmessage = onTrade
        })
        .catch((e) => {
          note('Reconnecting… ' + e.message)
          if (!dead) retry = setTimeout(connect, 4000)
        })
    }
    connect()
    const vis = () => {
      if (document.visibilityState === 'visible' && (!s || s.readyState > 1)) {
        clearTimeout(retry)
        connect()
      }
    }
    document.addEventListener('visibilitychange', vis)
    return () => {
      dead = true
      clearTimeout(retry)
      clearInterval(ping)
      document.removeEventListener('visibilitychange', vis)
      if (s) s.close()
      setTradeOn(false)
    }
  }, [token, accId])

  // ---------- Keep live proposals ready so a tap buys immediately ----------
  useEffect(() => {
    armedProps.current = {}
    if (!tradeOn) return
    clearTimeout(armTimer.current)
    armTimer.current = setTimeout(() => {
      trdSend({ forget_all: 'proposal' })
      reqType.current = {}
      TYPES[mode].forEach((type, i) => {
        if (type === 'DIGITOVER' && barrier === 9) return
        if (type === 'DIGITUNDER' && barrier === 0) return
        const rid = i + 1
        reqType.current[rid] = type
        const p = {
          proposal: 1, subscribe: 1, req_id: rid, amount: +stake || 1, basis: 'stake',
          contract_type: type, currency: cur, duration: +dur || 1, duration_unit: 't',
          underlying_symbol: symbol,
        }
        if (hasBarrier(type)) p.barrier = String(barrier)
        trdSend(p)
      })
    }, 250)
    return () => clearTimeout(armTimer.current)
  }, [tradeOn, symbol, mode, barrier, stake, dur, cur, armKey])

  function onTrade(e) {
    const m = JSON.parse(e.data)
    if (m.echo_req && m.echo_req.ping) return
    bus.emit(m)
    if (m.msg_type !== 'proposal_open_contract' && ((m.req_id || 0) >= 500 || (m.echo_req && (m.echo_req.req_id || 0) >= 500))) return
    if (m.error) {
      const meta = tradeMeta.current
      if (m.echo_req?.buy && meta && !retried.current) {
        retried.current = true
        pending.current = meta
        const p = {
          proposal: 1, subscribe: 1, req_id: 99, amount: meta.stake, basis: 'stake',
          contract_type: meta.type, currency: meta.cur || 'USD', duration: meta.dur,
          duration_unit: 't', underlying_symbol: meta.symbol,
        }
        if (hasBarrier(meta.type)) p.barrier = String(meta.barrier)
        trdSend(p)
        return note('Deriv busy, retrying…')
      }
      pending.current = null
      buying.current = false
      if (m.echo_req?.buy) setArmKey((k) => k + 1)
      return note('⚠ ' + (m.error.code || '') + ' ' + m.error.message)
    }
    if (m.msg_type === 'balance') {
      setBal(Number(m.balance.balance).toFixed(2))
      setCur(m.balance.currency)
    } else if (m.msg_type === 'proposal') {
      const rid = m.req_id
      if (rid === 99) {
        const st = pending.current
        if (!st) return
        pending.current = null
        subId.current = m.subscription?.id
        tradeMeta.current = st
        trdSend({ buy: m.proposal.id, price: Number(m.proposal.ask_price) || st.stake })
      } else if (reqType.current[rid]) {
        armedProps.current[reqType.current[rid]] = { id: m.proposal.id, ask: m.proposal.ask_price }
      }
    } else if (m.msg_type === 'buy') {
      buying.current = false
      if (subId.current) { trdSend({ forget: subId.current }); subId.current = null }
      const meta = tradeMeta.current || {}
      setHist((h) => [{
        id: m.buy.contract_id, t: Date.now(), symbol: meta.symbol, type: meta.type,
        barrier: meta.barrier, stake: Number(m.buy.buy_price), status: 'open',
      }, ...h].slice(0, 100))
      waiting.current.push({
        id: m.buy.contract_id, type: meta.type, barrier: meta.barrier, symbol: meta.symbol,
        need: meta.dur || 1, pt: m.buy.purchase_time || 0, seen: 0,
      })
      trdSend({ proposal_open_contract: 1, contract_id: m.buy.contract_id, subscribe: 1 })
      setArmKey((k) => k + 1)
    } else if (m.msg_type === 'proposal_open_contract') {
      const c = m.proposal_open_contract
      if (c.is_sold) {
        const profit = Number(c.profit)
        const ex = lastDigit(c.exit_tick_display_value ?? c.exit_tick ?? c.sell_spot_display_value ?? c.sell_spot)
        waiting.current = waiting.current.filter((w) => String(w.id) !== String(c.contract_id))
        setHist((h) => h.map((x) => (String(x.id) === String(c.contract_id)
          ? { ...x, status: profit >= 0 ? 'win' : 'loss', profit, exit: ex ?? x.exit } : x)))
        setResult((r) => ({ ...(r || {}), digit: ex ?? r?.digit, win: profit >= 0, profit }))
        showResultTimer()
        if (m.subscription) trdSend({ forget: m.subscription.id })
      }
    }
  }

  const trade = (type) => {
    if (!tradeOn) return note('Log in first')
    if (buying.current) return
    if (type === 'DIGITOVER' && barrier === 9) return note('Over needs digit 0-8')
    if (type === 'DIGITUNDER' && barrier === 0) return note('Under needs digit 1-9')
    const meta = {
      stake: +stake || 1, symbol, type, dur: +dur || 1, cur,
      barrier: hasBarrier(type) ? barrier : null,
    }
    tradeMeta.current = meta
    retried.current = false
    buying.current = true
    setTimeout(() => { buying.current = false }, 8000)
    const a = armedProps.current[type]
    if (a?.id) {
      delete armedProps.current[type]
      trdSend({ buy: a.id, price: Number(a.ask) || meta.stake })
    } else {
      pending.current = meta
      const p = {
        proposal: 1, subscribe: 1, req_id: 99, amount: meta.stake, basis: 'stake',
        contract_type: type, currency: cur, duration: meta.dur, duration_unit: 't',
        underlying_symbol: symbol,
      }
      if (hasBarrier(type)) p.barrier = String(barrier)
      trdSend(p)
    }
  }

  function logout() {
    sessionStorage.removeItem('bbfx_token')
    localStorage.removeItem('bbfx_token')
    localStorage.removeItem('bbfx_exp')
    setToken(''); setAccounts([]); setAccId(''); setBal('')
  }

  const last = digits[digits.length - 1]
  const last100 = digits.slice(-100)
  const evenPct = last100.length
    ? Math.round((last100.filter((d) => d % 2 === 0).length / last100.length) * 100) : 0

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
  const cn = cd.length || 1
  const ccount = Array(10).fill(0)
  cd.forEach((d) => { ccount[d]++ })
  const cmax = Math.max(...ccount)
  const cmin = Math.min(...ccount)
  const csecond = Math.max(-1, ...ccount.filter((c) => c < cmax))
  const clast = cd[cd.length - 1]
  const ccls = (c) => (cd.length === 0 ? '' : c === cmax ? 'g' : c === cmin ? 'r' : c === csecond ? 'b' : '')
  const cols = '110px repeat(' + al.digits.length + ', 1fr)'

  return (
    <div className={'app' + (tab === 'alerts' ? ' al' : '') + (tab === 'alerts' && tpOpen ? ' open' : '')}>
      <div className="topbar">
        <header>
          <h1>Blue Matrix <span>Trader</span></h1>
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

        <div className="tabs toptabs" ref={tabsRef}>
          <button className={tab === 'trader' ? 'on' : ''} onClick={() => setTab('trader')}>Trader</button>
          <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>
            History{hist.length ? ` (${hist.length})` : ''}
          </button>
          <button className={tab === 'alerts' ? 'on' : ''} onClick={() => setTab('alerts')}>
            Alerts{monOn ? ' 🔔' : ''}
          </button>
          <button className={tab === 'multi' ? 'on' : ''} onClick={() => setTab('multi')}>Multipurpose</button>
          <button className={'aib' + (tab === 'ai' ? ' on' : '')} onClick={() => setTab('ai')}>🤖 AI Strategies</button>
        </div>
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

      {tab === 'alerts' && (
        <>
          <section className="card">
            <div className="pcthead">
              <b>CIRCLES ANALYSIS</b>
              <input type="number" min="100" max="5000" value={circNIn} onChange={(e) => setCircNIn(e.target.value)} />
            </div>
            <select value={circSym} onChange={(e) => setCircSym(e.target.value)}>
              {SYMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <div className="circles">
              {ccount.map((c, d) => (
                <div className="cwrap" key={d}>
                  <i className="pill">
                    {(al.digits.includes(d) ? '🔔' : '') + (al.digits.includes(d) && mode !== 'eo' && barrier === d ? ' ' : '') + (mode !== 'eo' && barrier === d ? 'TRADE' : '')}
                  </i>
                  <div className={'circ ' + ccls(c) + (mode !== 'eo' && barrier === d ? ' tsel' : '')}>
                    <b>{d}</b>
                    <small>{cd.length ? ((c / cn) * 100).toFixed(1) + '%' : '…'}</small>
                  </div>
                  <i className="tri">{clast === d ? '▲' : ''}</i>
                </div>
              ))}
            </div>
            <div className="muted">
              {cd.length < circN ? 'Loading ' + cd.length + '/' + circN + ' ticks…' : 'Last ' + circN + ' ticks'} · green most · blue 2nd · red least
            </div>
            <div className="muted">white outline = your trade digit · 🔔 = alert digit</div>
            {circSym !== symbol && (
              <button onClick={() => setCircSym(symbol)}>
                Showing {SYMN[circSym]}. Tap to show your trading market ({SYMN[symbol]})
              </button>
            )}
          </section>

          <section className="card">
            <div className="pcthead">
              <b>DIGIT ALERTS</b>
              <button className={'armbtn ' + (monOn ? 'on' : '')} onClick={toggleMon}>{monOn ? 'Stop' : 'Start'}</button>
            </div>
            <div className="muted">
              {monOn ? 'Monitoring. Keep this page open and the screen on.' : 'Pick digits and a percentage, then tap Start.'}
            </div>
            <div className="muted">Digits to watch</div>
            <div className="pick">
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
                <button key={d} disabled={monOn} className={al.digits.includes(d) ? 'on' : ''} onClick={() => togDigit(d)}>{d}</button>
              ))}
            </div>
            <div className="row">
              <label>Ring when digit is
                <select disabled={monOn} value={al.dir} onChange={(e) => setA({ dir: e.target.value })}>
                  <option value="above">at or above</option>
                  <option value="below">at or below</option>
                </select>
              </label>
              <label>Percent
                <input type="number" min="0" max="100" step="0.5" disabled={monOn} value={al.thr} onChange={(e) => setA({ thr: e.target.value })} />
              </label>
            </div>
            <div className="row">
              <label>Over last ticks
                <input type="number" min="10" max="5000" disabled={monOn} value={al.n} onChange={(e) => setA({ n: e.target.value })} />
              </label>
              <label>Sound
                <select value={al.sound ? 'on' : 'off'} onChange={(e) => setA({ sound: e.target.value === 'on' })}>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </label>
            </div>
            <button onClick={() => { unlockAudio(); ring() }}>Test sound</button>
          </section>

          <section className="card">
            <div className="muted">Markets to scan</div>
            <div className="chips">
              {SYMS.map(([v, l]) => (
                <button key={v} disabled={monOn} className={al.syms.includes(v) ? 'on' : ''} onClick={() => togSym(v)}>{l}</button>
              ))}
            </div>
          </section>

          {monOn && (
            <section className="card">
              <div className="muted">Live scan (last {alN} ticks, green = alert level reached)</div>
              <div className="srow" style={{ gridTemplateColumns: cols }}>
                <span />
                {al.digits.map((d) => <b key={d} className="sh">{d}</b>)}
              </div>
              {al.syms.map((sym) => {
                const arr = mon.current[sym] || []
                const ready = arr.length >= alN
                return (
                  <div className="srow" key={sym} style={{ gridTemplateColumns: cols }}>
                    <button className={'sname' + (sym === symbol ? ' sel' : '')} onClick={() => go(sym)}>{SYMN[sym]}</button>
                    {al.digits.map((d) => {
                      const p = pctOf(arr, alN, d)
                      return (
                        <span key={d} className={'sc' + (ready && hitOf(p) ? ' hit' : '')}>
                          {ready ? Math.round(p) + '%' : '…'}
                        </span>
                      )
                    })}
                  </div>
                )
              })}
            </section>
          )}

          {alog.length > 0 && (
            <section className="card">
              <div className="muted">Recent alerts</div>
              {alog.map((p) => (
                <div className="h" key={p.id}>
                  <div>
                    <b>{SYMN[p.sym]}</b>
                    <small>digit {p.digit} · {p.pct.toFixed(1)}% · {fmtTime(p.t)}</small>
                  </div>
                  <button onClick={() => go(p.sym)}>Go</button>
                </div>
              ))}
            </section>
          )}
        </>
      )}

      <div className="ai aiwrap" style={{ display: tab === 'ai' ? 'grid' : 'none' }}>
        <Ai
          active={tab === 'ai'}
          tradeOn={tradeOn}
          send={trdSend}
          cur={cur}
          demo={acct ? acct.demo : true}
          addHist={(e) => setHist((h) => [e, ...h].slice(0, 100))}
          updHist={(id, p) => setHist((h) => h.map((x) => (String(x.id) === String(id) ? { ...x, ...p } : x)))}
        />
      </div>

      <div className="multiwrap" style={{ display: tab === 'multi' ? 'grid' : 'none' }}>
        <Multi
          active={tab === 'multi'}
          tradeOn={tradeOn}
          send={trdSend}
          cur={cur}
          demo={acct ? acct.demo : true}
          addHist={(e) => setHist((h) => [e, ...h].slice(0, 100))}
          updHist={(id, p) => setHist((h) => h.map((x) => (String(x.id) === String(id) ? { ...x, ...p } : x)))}
        />
      </div>

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
                <small>{fmtTime(h.t)} · stake {h.stake}{h.exit != null ? ` · hit ${h.exit}` : ''}</small>
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

      {(tab === 'trader' || tab === 'alerts') && (
        <div className="overlay">
          <div className="inner">
            {tab === 'alerts' && (
              <div className="tp">
                <div className="tphead" onClick={() => setTpOpen((o) => !o)}>
                  <b>{SYMN[symbol]}</b>
                  <span>
                    {mode === 'eo' ? 'Even/Odd' : mode === 'md' ? 'Match/Differ ' + barrier : 'Over/Under ' + barrier} · {stake} · {dur}t {tpOpen ? '▾' : '▴'}
                  </span>
                </div>
                {tpOpen && (
                  <>
                    <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
                      {SYMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <div className="tabs">
                      <button className={mode === 'eo' ? 'on' : ''} onClick={() => setMode('eo')}>Even/Odd</button>
                      <button className={mode === 'md' ? 'on' : ''} onClick={() => setMode('md')}>Match/Differ</button>
                      <button className={mode === 'ou' ? 'on' : ''} onClick={() => setMode('ou')}>Over/Under</button>
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
                  </>
                )}
              </div>
            )}
            {result && (
              <div className={'result ' + (result.win ? 'win' : 'loss')}>
                <b className="hit">{result.digit ?? '?'}</b>
                <span>
                  {result.win ? 'WIN' : 'LOSS'}
                  {result.profit != null ? ` ${result.profit >= 0 ? '+' : ''}${Number(result.profit).toFixed(2)}` : ''}
                </span>
              </div>
            )}
            {notice && <div className="notice">{notice}</div>}
            <div className="row">
              {mode === 'eo' && (<>
                <button className="buy even" onClick={() => trade('DIGITEVEN')}>EVEN</button>
                <button className="buy odd" onClick={() => trade('DIGITODD')}>ODD</button>
              </>)}
              {mode === 'md' && (<>
                <button className="buy even" onClick={() => trade('DIGITMATCH')}>MATCHES {barrier}</button>
                <button className="buy odd" onClick={() => trade('DIGITDIFF')}>DIFFERS {barrier}</button>
              </>)}
              {mode === 'ou' && (<>
                <button className="buy even" onClick={() => trade('DIGITOVER')}>OVER {barrier}</button>
                <button className="buy odd" onClick={() => trade('DIGITUNDER')}>UNDER {barrier}</button>
              </>)}
            </div>
          </div>
        </div>
      )}

      {tab === 'history' && notice && <div className="notice floating">{notice}</div>}

      {popups.length > 0 && (
        <div className="alertpop">
          <div className="ap-card">
            <b>🔔 Digit alert</b>
            {popups.map((p) => (
              <div className="ap-row" key={p.id}>
                <div>
                  <b>{SYMN[p.sym]}</b>
                  <small>digit {p.digit} is at {p.pct.toFixed(1)}% (last {alN} ticks). Switch to this volatility.</small>
                </div>
                <button className="save" onClick={() => go(p.sym)}>Switch</button>
              </div>
            ))}
            <button onClick={dismiss}>Dismiss</button>
          </div>
        </div>
      )}
    </div>
  )
}
