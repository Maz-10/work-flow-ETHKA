// ═══ بريدُ إذكاء — حين يُكمل العميلُ مهمةً تصل الفريقَ رسالةٌ بخلاصتها ═══
// نقيّةٌ محضة: تصوغ الرسالةَ ولا ترسلها. والإرسالُ في المضيف (`worker/index.js` بربط `send_email`).
// وصيغةُ الرسالة الخام على نهج عامل الموقع التعريفيّ (`mezan/site/worker/index.js`): نصٌّ UTF-8 بترميز base64،
// وعنوانٌ مرمَّز، ولا سطرَ جديدًا يُحقن في الترويسة.

import { ROLES, WORK, FREQUENCY, CHANNELS } from '../js/data.js'
import { activeStages, computeNumbers, range, handoffs } from '../js/calc.js'

export const MAIL = { to: 'hello@ethka.sa', from: 'workflow@ethka.sa' }

const oneLine = (s) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim()
const AR = new Intl.NumberFormat('ar-SA-u-nu-arab', { maximumFractionDigits: 1 })
const n = (x) => AR.format(x)
const label = (list, id) => list.find((x) => x.id === id)?.label
/** العددُ والمعدود: «موضع واحد»، «موضعان»، «٣ مواضع»، «١٢ موضعًا». */
const count = (x, [one, two, few, many]) => (x === 1 ? one : x === 2 ? two : n(x) + ' ' + (x % 100 >= 3 && x % 100 <= 10 ? few : many))

/** خلاصةُ المهمة المكتملة: عنوانٌ وأسطر. */
export function completionMail({ org, task, roles = [], teamUrl = '' }) {
  const roleOf = (id) => ROLES.find((r) => r.id === id)?.label || roles.find((r) => r.id === id)?.label
  const N = computeNumbers(task)
  const hr = range(N.monthlyHours)
  const H = handoffs(task, roles)
  const act = activeStages(task)
  const g = task.global || {}
  const lines = [
    'اكتملت خريطة مهمة جديدة في «رسم سير العمل».',
    '',
    'الجهة: ' + oneLine(org),
    'المهمة: ' + oneLine(task.title),
    'المراحل: ' + n(act.length) + (task.decisions?.length ? ' · نقاط القرار: ' + n(task.decisions.length) : ''),
    'التكرار الشهري: ' + (label(FREQUENCY, g.freq) || (g.freq === 'custom' && g.freqNum ? g.freqNum : 'غير محدد')),
    'ساعات العمل في الشهر (تقدير): ' + (hr ? n(hr[0]) + '–' + n(hr[1]) : 'لم تُحسب'),
    'الانتقال بين الأيدي: ' + (H.list.length ? count(H.list.length, ['موضع واحد', 'موضعان', 'مواضع', 'موضعًا']) + ' بين ' + count(H.roles, ['دور واحد', 'دورين', 'أدوار', 'دورًا']) : 'لا انتقال'),
    '',
    'المراحل:',
    ...act.map((s, i) => {
      const bits = [roleOf(s.actor?.v), (s.channels?.v || []).map((c) => label(CHANNELS, c)).filter(Boolean).join(' و'), label(WORK, s.work?.v)]
        .filter(Boolean)
      const fr = s.friction?.v === 'often' ? ' — تتعطل كثيرًا' : s.friction?.v === 'sometimes' ? ' — تتعطل أحيانًا' : ''
      return n(i + 1) + '. ' + oneLine(s.name) + (s.status === 'sometimes' ? ' (أحيانًا)' : '') + (bits.length ? ' — ' + bits.join(' · ') : '') + fr
    }),
  ]
  if (task.systems) lines.push('', 'الأنظمة المستخدمة: ' + oneLine(task.systems))
  if (teamUrl) lines.push('', 'الخريطة كاملة في لوحة الفريق:', teamUrl)
  lines.push('', '— صفحة رسم سير العمل · إذكاء')
  return { subject: 'اكتملت خريطة «' + oneLine(task.title) + '» — ' + oneLine(org), lines }
}

const b64 = (text) => { const bytes = new TextEncoder().encode(text); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin) }
const wrap76 = (s) => (s.match(/.{1,76}/g) || []).join('\r\n')

/** الرسالةُ الخام (RFC 5322) لربط `send_email`. */
export function rawMail({ subject, lines, replyTo = '' }, now = Date.now(), from = MAIL.from, to = MAIL.to) {
  const headers = [
    'From: =?UTF-8?B?' + b64('إذكاء — رسم سير العمل') + '?= <' + from + '>',
    'To: ' + to,
    'Subject: =?UTF-8?B?' + b64(oneLine(subject)) + '?=',
    'Date: ' + new Date(now).toUTCString(),
    'Message-ID: <' + now + '.' + Math.random().toString(36).slice(2, 8) + '@ethka.sa>',
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
  ]
  if (replyTo) headers.splice(2, 0, 'Reply-To: ' + oneLine(replyTo))
  return headers.join('\r\n') + '\r\n\r\n' + wrap76(b64(lines.join('\n'))) + '\r\n'
}
