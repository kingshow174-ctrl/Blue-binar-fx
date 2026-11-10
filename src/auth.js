const CLIENT_ID = import.meta.env.VITE_DERIV_CLIENT_ID
const REDIRECT = location.origin + '/callback'
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

// login({ fresh: true }) asks Deriv to show its login form again, so you can pick a different account
export async function login(opts) {
  const fresh = !!(opts && opts.fresh === true)
  const arr = crypto.getRandomValues(new Uint8Array(64))
  const verifier = Array.from(arr).map((v) => CHARS[v % 66]).join('')
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0')).join('')
  localStorage.setItem('pkce_code_verifier', verifier)
  localStorage.setItem('oauth_state', state)
  localStorage.setItem('bbfx_fresh', fresh ? '1' : '')
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: 'trade',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  if (fresh) q.set('prompt', 'login')
  location.href = 'https://auth.deriv.com/oauth2/auth?' + q
}

export async function handleCallback() {
  const p = new URLSearchParams(location.search)
  const fresh = localStorage.getItem('bbfx_fresh') === '1'
  localStorage.removeItem('bbfx_fresh')
  if (p.get('error')) {
    const why = p.get('error_description') || p.get('error')
    throw new Error(fresh
      ? 'Deriv did not accept a fresh login (' + why + '). Log out of Deriv in this browser or use a private tab, then tap Log in with Deriv.'
      : why)
  }
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
  localStorage.setItem('bbfx_token', j.access_token)
  localStorage.setItem('bbfx_exp', String(Date.now() + (j.expires_in || 3600) * 1000))
  history.replaceState({}, '', '/')
  return j.access_token
}
