// ═══ عاملُ Cloudflare — صفحةُ رسم سير العمل ولوحةُ الفريق وواجهتهما ═══
// النواةُ نفسُها التي يشغّلها Node (`server/core.mjs`)، والمخزنُ قاعدةُ D1، والبريدُ ربطُ `send_email`
// إلى hello@ethka.sa على نهج عامل الموقع التعريفيّ.
//
// الربطُ المطلوب (في wrangler.toml):
//   DB            — قاعدةُ D1 (جدولٌ واحد kv، يُنشأ من migrations/ أو تلقائيًّا عند أوّل طلب)
//   WORKFLOW_MAIL — ربطُ send_email وجهتُه hello@ethka.sa (موثَّقةٌ في Email Routing لنطاق ethka.sa)
//   (والملفّاتُ الساكنة مضمومةٌ في العامل نفسِه: worker/assets.gen.js يولّده build-assets.mjs عند كل نشر)
// والسرُّ: TEAM_KEY (wrangler secret put TEAM_KEY) — وبلاه تُرفض لوحةُ الفريق كلُّها.

import { createApp } from '../server/core.mjs'
import { rawMail, MAIL } from '../server/mail.mjs'
import FILES from './assets.gen.js'

let ready = null
function ensureTable(db) {
  ready ||= db.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL)').run()
  return ready
}

function d1Store(db) {
  return {
    async get(k) {
      await ensureTable(db)
      const row = await db.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first()
      return row ? JSON.parse(row.v) : null
    },
    async put(k, v) {
      await ensureTable(db)
      await db.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at')
        .bind(k, JSON.stringify(v), Date.now()).run()
    },
    async list(prefix) {
      await ensureTable(db)
      const { results } = await db.prepare('SELECT v FROM kv WHERE k >= ? AND k < ?').bind(prefix, prefix + '￿').all()
      return results.map((r) => JSON.parse(r.v))
    },
  }
}

/** يرسل بالربط ويُخبر بالنتيجة — فلا يُدَّعى إرسالٌ لم يقع. */
function mailer(env) {
  if (!env.WORKFLOW_MAIL) return null
  const from = env.MAIL_FROM || MAIL.from
  return async (msg) => {
    try {
      const { EmailMessage } = await import('cloudflare:email')
      await env.WORKFLOW_MAIL.send(new EmailMessage(from, MAIL.to, rawMail(msg, Date.now(), from)))
      console.log('workflow-mail: أُرسل إلى ' + MAIL.to + ' — ' + msg.subject)
      return true
    } catch (e) { console.log('workflow-mail:', String(e && e.message || e)); return false }
  }
}

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), geolocation=(), microphone=(self)',
}
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
function asset(path) {
  const f = FILES[path]
  if (!f) return null
  const headers = { 'content-type': f.type, ...SECURITY }
  if (f.type.startsWith('text/html')) Object.assign(headers, { 'content-security-policy': CSP, 'x-robots-tag': 'noindex', 'cache-control': 'no-cache' })
  else headers['cache-control'] = f.type.startsWith('font/') ? 'public, max-age=31536000, immutable' : 'no-cache'
  return new Response(f.b64 ? bytes(f.b64) : f.text, { headers })
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = decodeURIComponent(url.pathname)
    try {
      if (path.startsWith('/api/')) {
        if (!env.DB) return Response.json({ error: 'no_db' }, { status: 503 })
        const api = createApp({
          store: d1Store(env.DB), teamKey: env.TEAM_KEY || '', mail: mailer(env), origin: url.origin,
          later: (p) => ctx.waitUntil(p),
        })
        const headers = {}
        for (const [k, v] of request.headers) headers[k.toLowerCase()] = v
        const read = async (limit) => {
          const text = await request.text()
          if (text.length > limit) throw Object.assign(new Error('large'), { code: 413 })
          try { return JSON.parse(text || '{}') } catch { throw Object.assign(new Error('json'), { code: 400 }) }
        }
        const out = await api({ method: request.method, path, headers, read })
        return new Response(out.body, { status: out.status, headers: { ...out.headers, ...SECURITY } })
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method', { status: 405 })
      // الرابطُ الخاصّ لكل جهة: ‎/r/<المفتاح>‎ يقدّم الصفحةَ نفسَها، والمفتاحُ تقرؤه الصفحة
      if (path === '/' || /^\/r\/[A-Za-z0-9_-]{8,64}\/?$/.test(path)) return asset('/index.html')
      if (path === '/team' || path === '/team/') return asset('/team.html')
      if (/^\/(css|js|fonts)\//.test(path)) { const r = asset(path); if (r) return r }
      return new Response('غير موجود', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY } })
    } catch (e) {
      const code = e && (e.code === 413 || e.code === 400) ? e.code : 500
      if (code === 500) console.log('workflow-error:', String(e && e.stack || e))
      return Response.json({ error: 'server' }, { status: code })
    }
  },
}
