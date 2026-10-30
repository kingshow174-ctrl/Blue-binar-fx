import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const API = 'https://api.derivws.com'
const TOKEN_URL = 'https://auth.deriv.com/oauth2/token'

const readBody = (req) =>
  new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)) })
const out = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}
const pass = async (res, r) => {
  const t = await r.text()
  try { out(res, r.status, JSON.parse(t)) } catch { out(res, r.status, { error: t }) }
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x')
    const h = {
      Authorization: req.headers.authorization || '',
      'Deriv-App-ID': req.headers['deriv-app-id'] || '',
    }

    if (req.method === 'POST' && url.pathname === '/api/token') {
      const b = JSON.parse(await readBody(req))
      const r = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: b.client_id,
          code: b.code,
          code_verifier: b.code_verifier,
          redirect_uri: b.redirect_uri,
        }),
      })
      return pass(res, r)
    }

    if (req.method === 'POST' && url.pathname === '/api/ai') {
      const key = process.env.GROQ_API_KEY
      if (!key) return out(res, 500, { error: 'GROQ_API_KEY is not set on the server (Render, Environment)' })
      const b = JSON.parse(await readBody(req))
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
          temperature: 0.2,
          max_tokens: 450,
          messages: [
            {
              role: 'system',
              content: 'You are a cautious quantitative analyst reviewing a scan of Deriv digit contracts. The digits come from a random number generator, so the next digit cannot be predicted and a past pattern does not make a digit more likely. Explain in plain language, in under 150 words, what the numbers show, whether they are beyond chance, what the payout costs, and the main risk. Never promise profit. End with one line: Verdict: TRADE or Verdict: WAIT, and say TRADE only if every check passed.',
            },
            { role: 'user', content: String(b.summary || '').slice(0, 4000) },
          ],
        }),
      })
      const j = await r.json()
      const text = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : ''
      return out(res, r.ok ? 200 : r.status, { text, error: j.error ? j.error.message : '' })
    }

    if (req.method === 'GET' && url.pathname === '/api/accounts') {
      return pass(res, await fetch(`${API}/trading/v1/options/accounts`, { headers: h }))
    }

    const m = url.pathname.match(/^\/api\/otp\/([\w-]+)$/)
    if (req.method === 'POST' && m) {
      return pass(res, await fetch(`${API}/trading/v1/options/accounts/${m[1]}/otp`, { method: 'POST', headers: h }))
    }

    const dist = path.resolve('dist')
    let file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname)
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory())
      file = path.join(dist, 'index.html')
    if (!fs.existsSync(file)) return out(res, 404, { error: 'not found' })
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  } catch (e) {
    out(res, 500, { error: String(e) })
  }
}).listen(process.env.PORT || 3001, () => console.log('API proxy on :3001'))
