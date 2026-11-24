// ═══ المزامنة مع الخادم — اختيارية: بلا رابطٍ خاص تعمل الصفحة وحدها في متصفّح العميل ═══
// الرابطُ الخاص: ‎/r/<المفتاح>‎ (أو ‎?رابط=<المفتاح>‎). وكل ما يُكتب يُحفظ محليًّا أولًا ثم يُزامَن،
// فإن ضعف الاتصال لحظةً لم تتوقف التجربة، وأُعيدت المحاولة حين يعود.

const params = new URLSearchParams(location.search)
const pathToken = decodeURIComponent(location.pathname).match(/\/r\/([A-Za-z0-9_-]{8,})/)
// ‏`ETHKA_DEMO_TOKEN`‏: نسخةُ العرض (`demo/`) تحاكي الخادم في المتصفح وتضع مفتاحها هنا
export const TOKEN = (pathToken && pathToken[1]) || params.get('رابط') || params.get('link') || globalThis.ETHKA_DEMO_TOKEN || ''
export const online = () => !!TOKEN

const base = '/api/link/' + encodeURIComponent(TOKEN)
const QKEY = 'ethka-workflow-queue:' + TOKEN

async function call(path, opts = {}, timeout = 15000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeout)
  try {
    const res = await fetch(base + path, {
      ...opts, signal: ctl.signal,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(body.error || 'http'), { status: res.status, body })
    return body
  } finally { clearTimeout(t) }
}

/** فتحُ الرابط: اسمُ الجهة، والحالةُ المحفوظة، وما يتيحه الخادم. */
export async function open() {
  if (!TOKEN) return null
  try { return await call('', { method: 'GET' }) } catch (e) { return { error: e.status || 'offline' } }
}

// ── طابورٌ محليّ لما لم يصل بعد (الأحداث، وطلب الجلسة)
const queue = () => { try { return JSON.parse(localStorage.getItem(QKEY) || '[]') } catch { return [] } }
const saveQueue = (q) => { try { localStorage.setItem(QKEY, JSON.stringify(q.slice(-200))) } catch {} }

let flushing = null
function flush() {
  if (!TOKEN) return
  if (flushing) return flushing
  flushing = (async () => {
    for (let item; (item = queue()[0]);) {
      try { await call(item.path, { method: 'POST', body: JSON.stringify(item.body) }) } catch (e) {
        if (!e.status || e.status >= 500 || e.status === 429) break
      }
      const current = queue()
      const index = current.findIndex((entry) => JSON.stringify(entry) === JSON.stringify(item))
      if (index >= 0) current.splice(index, 1)
      saveQueue(current)
    }
  })().finally(() => { flushing = null })
  return flushing
}

export function event(name, data = {}) {
  if (!TOKEN) return
  const q = queue(); q.push({ path: '/events', body: { name, data, at: new Date().toISOString() } }); saveQueue(q)
  flush()
}

export async function booking(form) {
  if (!TOKEN) return { queued: false, local: true }
  const q = queue(); q.push({ path: '/booking', body: form }); saveQueue(q)
  await flush()
  return { queued: queue().some((x) => x.path === '/booking') }
}

// ── الحالة: تُرفع بعد هدوء الكتابة
let timer = null
let pending = null
let running = null
let backoff = 2000
export function pushState(state, onResult) {
  if (!TOKEN) return
  pending = { state, onResult }
  clearTimeout(timer)
  timer = setTimeout(sendInBackground, 1200)
}

function sendInBackground() { void syncNow().catch(() => {}) }

export async function syncNow() {
  clearTimeout(timer)
  if (running) {
    const receipt = await running.catch(() => null)
    if (!pending) return receipt
    return syncNow()
  }
  if (!pending) return null
  const next = pending
  pending = null
  const body = JSON.stringify(next.state)
  running = call('/state', { method: 'PUT', body })
  try {
    const receipt = await running
    backoff = 2000
    next.onResult?.(receipt)
    return receipt
  } catch (error) {
    if (!error.status || error.status === 429 || error.status >= 500) {
      pending ||= next
      backoff = Math.min(backoff * 2, 60000)
    }
    throw error
  } finally {
    running = null
    if (pending) {
      clearTimeout(timer)
      timer = setTimeout(sendInBackground, backoff)
    }
  }
}

export async function share(body) { return call('/share', { method: 'POST', body: JSON.stringify(body) }) }
export async function arrange(body, timeout) { return call('/arrange', { method: 'POST', body: JSON.stringify(body) }, timeout) }
export async function transcribe(blob) {
  const res = await fetch(base + '/transcribe', { method: 'POST', body: blob, headers: { 'content-type': blob.type || 'audio/webm' } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error('transcribe'), { status: res.status, body })
  return body
}

addEventListener('online', () => { flush(); sendInBackground() })
setTimeout(flush, 3000)
