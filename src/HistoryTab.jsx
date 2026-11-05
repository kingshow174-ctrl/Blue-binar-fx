import { useEffect, useRef, useState } from 'react'
import { bus } from './bus.js'

const SYNC_BASE = 1700000
const isOpenish = (h) => h.status === 'open' || h.status === 'unknown'
const isClosed = (h) => h.status === 'win' || h.status === 'loss'
const money = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const lastDig = (v) => {
  if (typeof v !== 'string') return undefined
  const m = v.match(/\d(?=\D*$)/)
  return m ? Number(m[0]) : undefined
}
const dur = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? h + 'h ' + m + 'm' : m ? m + 'm ' + (s % 60) + 's' : s + 's'
}

export default function HistoryTab({ hist, setHist, tradeOn, send, names, symn, fmtTime }) {
  const [sub, setSub] = useState(() => {
    try { return localStorage.bbfx_hsub === 'open' ? 'open' : 'closed' } catch (e) { return 'closed' }
  })
  const [filter, setFilter] = useState('all')
  const [shown, setShown] = useState(50)
  const [now, setNow] = useState(Date.now())
  const [note, setNote] = useState('')
  const histRef = useRef(hist)
  const sendRef = useRef(send)
  const onRef = useRef(tradeOn)
  const pend = useRef({})
  const seq = useRef(0)
  histRef.current = hist
  sendRef.current = send
  onRef.current = tradeOn

  const open = hist.filter(isOpenish)
  const closed = hist.filter(isClosed)
  const wins = closed.filter((h) => h.status === 'win').length
  const net = closed.reduce((a, h) => a + money(h.profit), 0)
  const unk = open.filter((h) => h.status === 'unknown').length
  const atRisk = open.reduce((a, h) => a + money(h.stake), 0)

  const pick = (v) => {
    setSub(v)
    setShown(50)
    try { localStorage.bbfx_hsub = v } catch (e) { /* ignore */ }
  }

  // Deriv's answer for a trade we asked about
  useEffect(() => {
    const h = (m) => {
      const rid = m.req_id || (m.echo_req && m.echo_req.req_id) || 0
      if (rid < SYNC_BASE || rid >= SYNC_BASE + 100000) return
      const id = pend.current[rid]
      delete pend.current[rid]
      if (id === undefined) return
      if (m.error) {
        setHist((l) => l.map((x) => (String(x.id) === String(id) && x.status === 'unknown' ? { ...x, miss: true } : x)))
        return
      }
      const c = m.proposal_open_contract
      if (!c) return
      const sold = Boolean(c.is_sold) || c.status === 'won' || c.status === 'lost'
      if (!sold) return
      let profit = Number(c.profit)
      if (!Number.isFinite(profit)) {
        const buy = Number(c.buy_price)
        const pay = Number(c.payout)
        if (c.status === 'won' && Number.isFinite(buy) && Number.isFinite(pay)) profit = pay - buy
        else if (c.status === 'lost' && Number.isFinite(buy)) profit = -buy
      }
      if (!Number.isFinite(profit)) return
      const ex = lastDig(c.exit_tick_display_value) ?? lastDig(c.sell_spot_display_value)
      setHist((l) => l.map((x) => {
        if (String(x.id) !== String(id)) return x
        const add = ex !== undefined && x.type !== 'Rise' && x.type !== 'Fall' ? { exit: ex } : {}
        return { ...x, status: profit >= 0 ? 'win' : 'loss', profit, miss: undefined, ...add }
      }))
    }
    bus.fns.add(h)
    return () => bus.fns.delete(h)
  }, [])

  // ask Deriv about trades that never reported a result
  const sync = (manual) => {
    if (!sendRef.current || !onRef.current) {
      if (manual) setNote('Not connected to Deriv yet')
      return
    }
    const t = Date.now()
    const cand = histRef.current.filter((h) => isOpenish(h) && (h.status === 'unknown' || t - h.t > 90000)).slice(0, 25)
    if (!cand.length) {
      if (manual) setNote('Nothing to check right now')
      return
    }
    cand.forEach((h, i) => {
      setTimeout(() => {
        seq.current += 1
        const rid = SYNC_BASE + (seq.current % 90000)
        pend.current[rid] = h.id
        if (sendRef.current) sendRef.current({ proposal_open_contract: 1, contract_id: Number(h.id), req_id: rid })
      }, i * 300)
    })
    if (manual) setNote('Checking ' + cand.length + ' trade' + (cand.length > 1 ? 's' : '') + ' with Deriv…')
  }
  useEffect(() => { if (tradeOn) sync(false) }, [tradeOn])
  useEffect(() => {
    const t = setInterval(() => sync(false), 60000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (sub !== 'open' || !open.length) return undefined
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [sub, open.length])

  const label = (h) => (names[h.type] || h.type) + (h.barrier != null ? ' ' + h.barrier : '')
  const rows = closed.filter((h) => filter === 'all' || (filter === 'wins' ? h.status === 'win' : h.status === 'loss'))

  return (
    <section className="card">
      <div className="hsub">
        <button className={sub === 'open' ? 'on' : ''} onClick={() => pick('open')}>Open positions <i>{open.length}</i></button>
        <button className={sub === 'closed' ? 'on' : ''} onClick={() => pick('closed')}>Closed positions <i>{closed.length}</i></button>
      </div>

      {sub === 'open' ? (
        <>
          <div className="sum">
            <div><small>Open</small><b>{open.length}</b></div>
            <div><small>Stake at risk</small><b>{atRisk.toFixed(2)}</b></div>
            <div><small>Unresolved</small><b>{unk}</b></div>
          </div>
          {!open.length && <div className="muted">No open positions</div>}
          {open.map((h) => (
            <div className="h" key={h.id}>
              <div>
                <b>{label(h)}</b>
                <small>{symn[h.symbol] || h.symbol}</small>
                <small>
                  {fmtTime(h.t)} · stake {h.stake} · {h.status === 'open' ? 'open for ' + dur(now - h.t) : h.miss ? 'not found on this account' : 'result unknown'}
                </small>
              </div>
              <div className={'pl ' + h.status}>{h.status === 'open' ? 'OPEN' : '?'}</div>
            </div>
          ))}
          {open.length > 0 && (
            <div className="hbtns">
              <button onClick={() => sync(true)}>Check with Deriv</button>
              {unk > 0 && <button onClick={() => { if (confirm('Remove the ' + unk + ' trade(s) with an unknown result?')) setHist((l) => l.filter((x) => x.status !== 'unknown')) }}>Remove unresolved</button>}
            </div>
          )}
          {note && <div className="muted">{note}</div>}
          <div className="muted left">Trades that are still running show here. If a trade never reports a result, Check with Deriv looks it up. This also runs by itself when you open this tab.</div>
        </>
      ) : (
        <>
          <div className="sum">
            <div><small>Trades</small><b>{closed.length}</b></div>
            <div><small>Win rate</small><b>{closed.length ? Math.round((wins / closed.length) * 100) + '%' : '-'}</b></div>
            <div><small>Net P/L</small><b className={net >= 0 ? 'win' : 'loss'}>{net >= 0 ? '+' : ''}{net.toFixed(2)}</b></div>
          </div>
          <div className="hfilt">
            {[['all', 'All'], ['wins', 'Wins'], ['losses', 'Losses']].map(([k, l]) => (
              <button key={k} className={filter === k ? 'on' : ''} onClick={() => { setFilter(k); setShown(50) }}>{l}</button>
            ))}
          </div>
          {!rows.length && <div className="muted">{closed.length ? 'Nothing matches this filter' : 'No closed positions yet'}</div>}
          {rows.slice(0, shown).map((h) => (
            <div className="h" key={h.id}>
              <div>
                <b>{label(h)}</b>
                <small>{symn[h.symbol] || h.symbol}</small>
                <small>{fmtTime(h.t)} · stake {h.stake}{h.exit != null ? ' · hit ' + h.exit : ''}</small>
              </div>
              <div className={'pl ' + h.status}>{(money(h.profit) >= 0 ? '+' : '') + money(h.profit).toFixed(2)}</div>
            </div>
          ))}
          {rows.length > shown && <button onClick={() => setShown((n) => n + 50)}>Show more ({rows.length - shown} left)</button>}
          {hist.length > 0 && (
            <button onClick={() => { if (confirm('Clear all history?')) setHist([]) }}>Clear history</button>
          )}
        </>
      )}
    </section>
  )
}
