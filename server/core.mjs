// ═══ نواةُ الخادم — منطقٌ واحد يعمل على مضيفين ═══
// ‏`server.mjs`‏ يشغّلها على Node بملفّات JSON، و`worker/index.js` يشغّلها على Cloudflare بقاعدة D1.
// فلا يُكتب منطقُ الروابط والحفظ والدمج والصلاحيات مرّتين، ولا يفترق مضيفٌ عن آخر بصمت.
//
// ما تحتاجه من مضيفها:
//   store      — مخزنُ مفاتيح غيرُ متزامن: get(k) · put(k, v) · list(prefix)  (القيمُ كائناتُ JSON)
//   teamKey    — مفتاحُ لوحة الفريق
//   mail(msg)  — اختياريّ: يُرسل { subject, lines, replyTo } إلى بريد إذكاء ويُرجع true/false
//   origin     — أصلُ الموقع لروابط البريد (مثل https://workflow.ethka.sa)
//   later(p)   — اختياريّ: يُبقي عملًا يجري بعد الردّ (ctx.waitUntil على Cloudflare)
//   ai         — اختياريّ: { capabilities(), arrange(), transcribe() }

import { redactTask } from './redact.mjs'
import { TEMPLATES } from '../js/data.js'
import { completionMail } from './mail.mjs'

const enc = new TextEncoder()
const json = (status, body, headers = {}) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }, body: JSON.stringify(body) })
const newToken = () => {
  const b = new Uint8Array(16); crypto.getRandomValues(b)
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
/** مقارنةٌ ثابتةُ الزمن — فلا يُستنبط المفتاحُ من توقيت الرفض. */
function sameKey(a, b) {
  const x = enc.encode(String(a || '')), y = enc.encode(String(b || ''))
  if (x.length !== y.length || !y.length) return false
  let d = 0
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]
  return d === 0
}

const NONE_AI = { capabilities: () => ({ arrange: false, transcribe: false }), arrange: async () => ({ result: null }), transcribe: async () => null }

// المرحلةُ مكتملةٌ إن عُرف من يتولاها وكم تأخذ وهل تتعطل (سؤالُ الانتظار أُزيل)
const stageDone = (s) => s.actor?.v && s.work?.v && s.friction?.v

/** دمجُ الحالة: لكل مهمةٍ أحدثُ نسختيها، فلا يُفقد شيءٌ رسمه أحدُ الطرفين. */
export function merge(stored, incoming) {
  if (!stored) return incoming
  const tasks = new Map((stored.tasks || []).map((t) => [t.id, t]))
  for (const t of incoming.tasks || []) {
    const mine = tasks.get(t.id)
    if (!mine || (t.updatedAt || 0) >= (mine.updatedAt || 0)) tasks.set(t.id, t)
  }
  const roles = new Map([...(stored.roles || []), ...(incoming.roles || [])].map((r) => [r.id, r]))
  const newer = (incoming.updatedAt || 0) >= (stored.updatedAt || 0) ? incoming : stored
  return { ...newer, tasks: [...tasks.values()], roles: [...roles.values()] }
}

/** ما يُحفظ على الخادم: بلا حساس، وبلا كلامٍ أصليّ لم يأذن العميل بحفظه. */
export function sanitize(state) {
  const s = JSON.parse(JSON.stringify(state))
  delete s.screen; delete s.cur
  for (const t of s.tasks || []) {
    if (!t.keepStory) t.story = ''
    redactTask(t)
  }
  return s
}

export function createApp({ store, teamKey, mail = null, origin = '', later = (p) => p, ai = NONE_AI }) {
  const hits = new Map()
  const limited = (token, kind, max) => {
    const k = token + ':' + kind, now = Date.now()
    const h = (hits.get(k) || []).filter((t) => now - t < 3600_000)
    h.push(now); hits.set(k, h)
    return h.length > max
  }

  const getLink = (t) => store.get('link:' + t)
  const putLink = (l) => store.put('link:' + l.token, l)
  const getState = (root) => store.get('state:' + root)
  const putState = (root, s) => store.put('state:' + root, s)
  const getTemplates = async () => (await store.get('templates')) || []
  const rootOf = async (l) => (l.parent ? getLink(l.parent) : l)

  async function status(l) {
    const tasks = (await getState(l.token))?.tasks || []
    const ev = l.events || []
    if (tasks.some((t) => t.completed)) return 'completed'
    if (tasks.length || ev.some((e) => e.name === 'start')) return 'started'
    if (ev.some((e) => e.name === 'opened')) return 'opened'
    return 'new'
  }

  const notify = (root, text) => {
    root.notices = [...(root.notices || []), { id: newToken().slice(0, 8), text, at: new Date().toISOString(), seenBy: [] }].slice(-30)
  }
  function noticesFor(link, root) {
    if (link.parent) return [] // الإشعاراتُ لصاحب الرابط الأصليّ
    const out = (root.notices || []).filter((n) => !n.seenBy.includes(link.token))
    out.forEach((n) => n.seenBy.push(link.token))
    return out.map(({ text }) => ({ text }))
  }

  /** بريدُ إذكاء: كلُّ مهمةٍ يكملها العميل تصل الفريقَ رسالةً بخلاصتها ورابطها في اللوحة. */
  function mailCompleted(root, state, before) {
    if (!mail) return
    const was = new Set((before?.tasks || []).filter((t) => t.completed).map((t) => t.id))
    for (const t of state.tasks || []) {
      if (!t.completed || was.has(t.id)) continue
      const msg = completionMail({ org: root.org, task: t, roles: state.roles || [], teamUrl: (origin || '') + '/team/#' + root.token })
      // نتيجةُ آخر إرسالٍ تُحفظ فتراها لوحةُ الفريق: انقطاعُ البريد لا يبقى صامتًا
      later(Promise.resolve(mail(msg)).catch(() => false).then((ok) => {
        if (!ok) console.log('workflow-mail: تعذّر الإرسال', root.token, t.id)
        return store.put('mail:last', { at: new Date().toISOString(), ok: !!ok, subject: msg.subject })
      }).catch(() => {}))
    }
  }

  // ── واجهةُ العميل
  async function client(method, token, rest, read) {
    const link = await getLink(token)
    if (!link || link.revoked) return json(404, { error: 'not_found' })
    const root = await rootOf(link)
    if (!root || root.revoked) return json(404, { error: 'not_found' })

    if (method === 'GET' && rest === '') {
      const out = {
        org: root.org, state: await getState(root.token), capabilities: ai.capabilities(),
        templates: await getTemplates(), notices: noticesFor(link, root),
        scope: link.stageId ? { taskId: link.taskId, stageId: link.stageId } : null,
      }
      if (out.notices.length) await putLink(root)
      return json(200, out)
    }
    if (method === 'PUT' && rest === '/state') {
      if (limited(token, 'state', 1200)) return json(429, { error: 'rate' })
      const incoming = await read(2_000_000)
      if (!incoming || !Array.isArray(incoming.tasks)) return json(400, { error: 'shape' })
      const before = await getState(root.token)
      const merged = merge(before, sanitize(incoming))
      // زميلٌ أكمل المرحلة التي أُرسلت إليه: إشعارٌ لصاحب الرابط
      if (link.parent && link.stageId && !link.doneNotified) {
        const s = merged.tasks.find((x) => x.id === link.taskId)?.stages.find((x) => x.id === link.stageId)
        if (s && stageDone(s)) {
          link.doneNotified = true; await putLink(link)
          notify(root, `أكمل زميلك خصائص «${s.name}».`)
          ;(root.events ||= []).push({ name: 'colleague-done', at: new Date().toISOString(), data: { stage: s.name } })
        }
      }
      await putState(root.token, merged)
      mailCompleted(root, merged, before)
      const notices = noticesFor(link, root)
      await putLink(root)
      return json(200, { ok: true, notices })
    }
    if (method === 'POST' && rest === '/events') {
      if (limited(token, 'events', 2000)) return json(429, { error: 'rate' })
      const e = await read(20_000)
      const name = String(e.name || '').slice(0, 40)
      if (!/^[a-z-]+$/.test(name)) return json(400, { error: 'name' })
      let data = {}
      try { data = e.data && typeof e.data === 'object' ? JSON.parse(JSON.stringify(e.data).slice(0, 400)) : {} } catch {}
      ;(root.events ||= []).push({ name, at: new Date().toISOString(), by: link.parent ? 'colleague' : 'owner', data })
      if (root.events.length > 3000) root.events = root.events.slice(-3000)
      await putLink(root)
      return json(200, { ok: true })
    }
    if (method === 'POST' && rest === '/share') {
      if (limited(token, 'share', 30)) return json(429, { error: 'rate' })
      const b = await read(5_000)
      const t = newToken()
      await putLink({ token: t, parent: root.token, createdAt: new Date().toISOString(), taskId: b.taskId ? String(b.taskId).slice(0, 40) : null, stageId: b.stageId ? String(b.stageId).slice(0, 40) : null, events: [] })
      ;(root.events ||= []).push({ name: 'shared', at: new Date().toISOString(), data: { stage: !!b.stageId } })
      await putLink(root)
      return json(200, { token: t })
    }
    if (method === 'POST' && rest === '/arrange') {
      if (limited(token, 'arrange', 30)) return json(429, { error: 'rate' })
      const b = await read(100_000)
      const tpl = b.templateId ? [...TEMPLATES, ...(await getTemplates())].find((x) => x.id === b.templateId) : null
      const r = await ai.arrange({ story: b.story, dept: b.dept, template: tpl, insert: !!b.insert, context: b.context })
      return r.result ? json(200, { result: r.result }) : json(503, { fallback: true })
    }
    if (method === 'POST' && rest === '/transcribe') return json(503, { fallback: true })
    return json(404, { error: 'not_found' })
  }

  // ── واجهةُ الفريق
  async function summary(l) {
    const st = await getState(l.token)
    const ev = l.events || []
    const steps = ev.filter((e) => e.name === 'step').map((e) => e.data?.screen)
    const all = await store.list('link:')
    return {
      token: l.token, org: l.org, createdAt: l.createdAt, status: await status(l), followup: l.followup || 'new',
      tasks: (st?.tasks || []).length, completed: (st?.tasks || []).filter((t) => t.completed).length,
      lastStep: steps[steps.length - 1] || null, lastActivity: ev.length ? ev[ev.length - 1].at : l.createdAt,
      revoked: !!l.revoked, colleagues: all.filter((x) => x.parent === l.token).length,
    }
  }

  async function team(method, rest, read, headers) {
    if (!sameKey(headers['x-team-key'], teamKey)) return json(401, { error: 'key' })
    const parts = rest.split('/').filter(Boolean)
    if (method === 'GET' && parts[0] === 'links' && !parts[1]) {
      const all = await store.list('link:')
      const list = await Promise.all(all.filter((l) => !l.parent).map(summary))
      list.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''))
      // مؤشراتُ المسار: كم فتح الرابط، وكم بدأ، وكم أكمل، وعند أي خطوة ينسحب العملاء
      const funnel = { links: list.length, opened: 0, started: 0, completed: 0, dropoff: {} }
      for (const l of list) {
        if (l.status !== 'new') funnel.opened++
        if (l.status === 'started' || l.status === 'completed') funnel.started++
        if (l.status === 'completed') funnel.completed++
        else if (l.lastStep && l.status !== 'new') funnel.dropoff[l.lastStep] = (funnel.dropoff[l.lastStep] || 0) + 1
      }
      return json(200, { links: list, funnel, mail: mail ? (await store.get('mail:last')) || { none: true } : { off: true } })
    }
    if (method === 'POST' && parts[0] === 'links' && !parts[1]) {
      const b = await read(5_000)
      const org = String(b.org || '').trim().slice(0, 120)
      if (!org) return json(400, { error: 'org' })
      const t = newToken()
      await putLink({ token: t, org, createdAt: new Date().toISOString(), events: [], notes: '', followup: 'new', taskNotes: {} })
      return json(200, { token: t })
    }
    const l = parts[0] === 'links' && parts[1] ? await getLink(parts[1]) : null
    if (parts[0] === 'links' && (!l || l.parent)) return json(404, { error: 'not_found' })
    if (method === 'GET' && l && !parts[2]) {
      const all = await store.list('link:')
      const children = all.filter((x) => x.parent === l.token).map((x) => ({ createdAt: x.createdAt, taskId: x.taskId, stageId: x.stageId, done: !!x.doneNotified }))
      return json(200, { link: { ...(await summary(l)), notes: l.notes || '', taskNotes: l.taskNotes || {}, events: (l.events || []).slice(-200), bookings: [] }, state: await getState(l.token), children })
    }
    if (method === 'PATCH' && l && !parts[2]) {
      const b = await read(50_000)
      if (typeof b.notes === 'string') l.notes = b.notes.slice(0, 20_000)
      if (['new', 'studying', 'scheduled', 'proposal'].includes(b.followup)) l.followup = b.followup
      if (b.taskNotes && typeof b.taskNotes === 'object') for (const [k, v] of Object.entries(b.taskNotes)) (l.taskNotes ||= {})[k] = String(v).slice(0, 10_000)
      if (typeof b.revoked === 'boolean') l.revoked = b.revoked
      await putLink(l)
      return json(200, { ok: true })
    }
    if (method === 'GET' && l && parts[2] === 'export') {
      return json(200, { org: l.org, exportedAt: new Date().toISOString(), state: await getState(l.token), notes: l.notes || '', taskNotes: l.taskNotes || {} },
        { 'content-disposition': `attachment; filename="workflow-${l.token.slice(0, 6)}.json"` })
    }
    if (parts[0] === 'templates') {
      const templates = await getTemplates()
      if (method === 'GET') return json(200, { templates })
      if (method === 'DELETE' && parts[1]) {
        await store.put('templates', templates.filter((t) => t.id !== parts[1]))
        return json(200, { ok: true })
      }
      if (method === 'POST') {
        // مهمةٌ مرسومة تصير قالبًا لمن بعدها: تُجرَّد من خصوصية جهتها
        const b = await read(20_000)
        const task = (await getState(String(b.token || '')))?.tasks?.find((t) => t.id === b.taskId)
        if (!task) return json(404, { error: 'task' })
        const act = task.stages.filter((s) => s.status !== 'no')
        const idx = new Map(act.map((s, i) => [s.id, i + 1]))
        const known = new Set(['lawyer', 'head', 'assistant', 'dept', 'top', 'firm', 'external'])
        const tpl = {
          id: 'x-' + newToken().slice(0, 10), dept: b.dept === 'general' ? 'general' : 'legal',
          title: String(b.title || task.title).slice(0, 80), sub: String(b.sub || '').slice(0, 80) || 'من خريطة جهة سابقة',
          entry: task.entryHint || '', exit: task.exitHint || '', keywords: String(b.keywords || task.title).slice(0, 200),
          stages: act.map((s) => ({ name: s.name, actor: known.has(s.actor?.v) ? s.actor.v : null, channels: (s.channels?.v || []).filter((c) => c !== 'unknown') })),
          decisions: (task.decisions || []).filter((d) => idx.has(d.after)).map((d) => ({ after: idx.get(d.after), q: d.q, back: d.back ? idx.get(d.back) || null : null, out: d.out || '' })),
          createdAt: new Date().toISOString(),
        }
        await store.put('templates', [...templates, tpl])
        return json(200, { template: tpl })
      }
    }
    return json(404, { error: 'not_found' })
  }

  /** الطلب: { method, path, headers (بأسماء صغيرة), read(limit) → JSON }  → { status, headers, body } أو null لغير الواجهة. */
  return async function handleApi({ method, path, headers, read }) {
    let m
    if ((m = path.match(/^\/api\/link\/([A-Za-z0-9_-]{8,64})(\/[a-z]+)?$/))) return client(method, m[1], m[2] || '', read)
    if (path.startsWith('/api/team/')) return team(method, path.slice('/api/team/'.length), read, headers)
    if (path.startsWith('/api/')) return json(404, { error: 'not_found' })
    return null
  }
}
