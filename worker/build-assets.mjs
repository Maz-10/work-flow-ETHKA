// ═══ يضمّ الصفحتين وأصولهما إلى العامل نفسِه ═══
// يُشغَّل تلقائيًّا قبل كل نشر (`[build]` في wrangler.toml). يجمع ما يُقدَّم للمتصفّح وحده
// (index.html · team.html · css · js · fonts) في وحدةٍ مولَّدة يقرؤها العامل — فلا يُرفع الخادمُ ولا البيانات.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, extname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2' }
const files = ['index.html', 'team.html']
const walk = (d) => readdirSync(join(ROOT, d)).forEach((f) => {
  const p = join(d, f)
  statSync(join(ROOT, p)).isDirectory() ? walk(p) : TYPES[extname(p)] && files.push(p)
})
;['css', 'js', 'fonts'].forEach(walk)

const out = {}
for (const f of files) {
  const buf = readFileSync(join(ROOT, f))
  const type = TYPES[extname(f)]
  const path = '/' + relative(ROOT, join(ROOT, f)).split('\\').join('/')
  out[path] = type.startsWith('font/') ? { type, b64: buf.toString('base64') } : { type, text: buf.toString('utf8') }
}
writeFileSync(join(ROOT, 'worker/assets.gen.js'), '// ملفٌّ مولَّد من worker/build-assets.mjs — لا يُحرَّر بيد.\nexport default ' + JSON.stringify(out) + '\n')
console.log('أصول العامل:', files.length, 'ملفًّا')
