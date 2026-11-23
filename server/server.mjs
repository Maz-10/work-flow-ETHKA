// ═══ خادمُ التطوير على Node — النواةُ نفسُها (`core.mjs`) بمخزن ملفّات ═══
// للتشغيل المحليّ والاختبار؛ والنشرُ الفعليّ على Cloudflare (`worker/index.js`).
//
//   PORT=8787 TEAM_KEY=… node server/server.mjs
//
// لا بريدَ هنا: الرسالةُ التي كانت ستصل hello@ethka.sa تُكتب ملفًّا في DATA_DIR/outbox لتُراجَع.

import { createServer } from 'node:http'
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, normalize, extname, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { createApp } from './core.mjs'
import { rawMail } from './mail.mjs'
import * as AI from './arrange/index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = normalize(join(HERE, '..'))
const DATA = process.env.DATA_DIR || join(ROOT, 'data')
const PORT = Number(process.env.PORT || 8787)
const TEAM_KEY = process.env.TEAM_KEY || randomBytes(12).toString('base64url')
if (!process.env.TEAM_KEY) console.log(`مفتاح لوحة الفريق لهذه الجلسة: ${TEAM_KEY}`)

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' }
const PUBLIC = ['index.html', 'team.html', 'css', 'js', 'fonts']

// ── مخزنُ مفاتيح على ملفٍّ واحد، يُكتب ذرّيًّا بعد هدوءٍ قصير
await mkdir(join(DATA, 'outbox'), { recursive: true })
const KV_FILE = join(DATA, 'kv.json')
const kv = new Map(Object.entries((() => { try { return JSON.parse(readFileSync(KV_FILE, 'utf8')) } catch { return {} } })()))
let writing = null
function flush() {
  clearTimeout(writing)
  writing = setTimeout(async () => {
    const tmp = KV_FILE + '.' + process.pid + '.tmp'
    await writeFile(tmp, JSON.stringify(Object.fromEntries(kv)))
    await rename(tmp, KV_FILE)
  }, 150)
}
const store = {
  async get(k) { const v = kv.get(k); return v == null ? null : structuredClone(v) },
  async put(k, v) { kv.set(k, structuredClone(v)); flush() },
  async list(prefix) { return [...kv.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => structuredClone(v)) },
}

// ── «البريد» المحليّ: ملفٌّ في الصادر
async function mail(msg) {
  const now = Date.now()
  await writeFile(join(DATA, 'outbox', now + '.eml'), rawMail(msg, now))
  await writeFile(join(DATA, 'outbox', now + '.txt'), msg.subject + '\n\n' + msg.lines.join('\n'))
  console.log('بريدٌ إلى hello@ethka.sa (محليًّا في outbox):', msg.subject)
  return true
}

const api = createApp({ store, teamKey: TEAM_KEY, mail, origin: process.env.ORIGIN || `http://localhost:${PORT}`, ai: AI })

async function serveFile(res, rel) {
  const p = normalize(join(ROOT, rel))
  if (!p.startsWith(ROOT + sep) || !PUBLIC.includes(rel.split('/')[0])) return end(res, 404, 'not found')
  try {
    if (!(await stat(p)).isFile()) throw new Error()
    res.writeHead(200, {
      'content-type': MIME[extname(p)] || 'application/octet-stream',
      'cache-control': extname(p) === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    })
    res.end(await readFile(p))
  } catch { end(res, 404, 'not found') }
}
const end = (res, code, text) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }); res.end(text) }

async function readBody(req, limit) {
  const chunks = []; let size = 0
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('large'), { code: 413 }); chunks.push(c) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw Object.assign(new Error('json'), { code: 400 }) }
}

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const out = await api({ method: req.method, path, headers: req.headers, read: (limit) => readBody(req, limit) })
    if (out) { res.writeHead(out.status, out.headers); return res.end(out.body) }
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405, 'method')
    if (path === '/' || /^\/r\/[A-Za-z0-9_-]{8,64}\/?$/.test(path)) return serveFile(res, 'index.html')
    if (path === '/team' || path === '/team/') return serveFile(res, 'team.html')
    return serveFile(res, path.replace(/^\/+/, ''))
  } catch (e) {
    res.writeHead(e.code === 413 ? 413 : e.code === 400 ? 400 : 500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'server' }))
    if (!e.code) console.error(e)
  }
}).listen(PORT, () => console.log(`رسم سير العمل: http://localhost:${PORT}  ·  لوحة الفريق: http://localhost:${PORT}/team/`))
