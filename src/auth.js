const CLIENT_ID = import.meta.env.VITE_DERIV_CLIENT_ID
const REDIRECT = location.origin + '/callback'
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

export async function login() {
  const arr = crypto.getRandomValues(new Uint8Array(64))
  const verifier = Array.from(arr).map((v) => CHARS[v % 66]).join('')
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0')).join('')
  localStorage.setItem('pkce_code_verifier', verifier)
  localStorage.setItem('oauth_state', state)
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: 'trade',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  location.href = 'https://auth.deriv.com/oauth2/auth?' + q
}

export async function handleCallback() {
  const p = new URLSearchParams(location.search)
  if (p.get('error')) throw new Error(p.get('error_description') || p.get('error'))
  if (p.get('state') !== localStorage.getItem('oauth_state')) throw new Error('State mismatch')
  const r = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      code: p.get('code'),
      code_verifier: localStorage.getItem('pkce_code_verifier'),
      redirect_uri: REDIRECT,
    }),
  })
  const j = await r.json()
  if (!j.access_token) throw new Error(j.error_description || j.error || 'Token exchange failed')
  localStorage.removeItem('pkce_code_verifier')
  localStorage.removeItem('oauth_state')
  sessionStorage.setItem('bbfx_token', j.access_token)
  history.replaceState({}, '', '/')
  return j.access_token
}
