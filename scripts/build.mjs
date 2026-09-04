#!/usr/bin/env node
// Генератор. Ноль зависимостей. Три конструкции: {{путь}}, {{> _partial}}, {{#each массив}}…{{/each}}
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DRAFT = process.argv.includes('--draft')
const p = (...a) => path.join(ROOT, ...a)

const die = (msg, list = []) => {
  console.error('\n  СБОРКА ОСТАНОВЛЕНА\n  ' + msg)
  for (const l of list) console.error('    · ' + l)
  console.error('')
  process.exit(1)
}

const data = JSON.parse(fs.readFileSync(p('client.json'), 'utf8'))

/* ---------- 1. Обязательные данные ---------- */
const missing = []
const walk = (node, trail) => {
  if (node === null) { missing.push(trail); return }
  if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${trail}[${i}]`))
  if (typeof node === 'object') return Object.entries(node)
    .filter(([k]) => !k.startsWith('_'))
    .forEach(([k, v]) => walk(v, trail ? `${trail}.${k}` : k))
}
walk(data, '')
const optional = new Set(data._optional || [])
const blocking = missing.filter(m => !optional.has(m))
if (blocking.length && !DRAFT) {
  die('В client.json не заполнено ' + blocking.length + ' обязательное(ых) поле(й). Сайт без них не собирается:', blocking)
}

/* ---------- 2. Лицензии ---------- */
const today = new Date().toISOString().slice(0, 10)
const expired = (data.licenses || []).filter(l => l.expires && l.expires < today)
if (expired.length) die('Просроченные лицензии:', expired.map(l => `${l.name} ${l.number} — истекла ${l.expires}`))

/* ---------- 3. Фото на диске ---------- */
const photos = []
const collectPhotos = n => {
  if (typeof n === 'string' && /^\/assets\/img\//.test(n)) photos.push(n)
  else if (Array.isArray(n)) n.forEach(collectPhotos)
  else if (n && typeof n === 'object') Object.values(n).forEach(collectPhotos)
}
collectPhotos(data)
const noFile = photos.filter(f => !fs.existsSync(p(f.slice(1))))
if (noFile.length) die('Фото указаны в client.json, но их нет на диске:', noFile)

/* ---------- 4. Шаблонизатор ---------- */
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const PH = '—'

const get = (ctx, expr) => {
  if (expr === 'this') return ctx.this
  let cur = ctx
  for (const key of expr.split('.')) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[key]
  }
  return cur
}

const partial = name => fs.readFileSync(p('templates', name + '.html'), 'utf8')

// находит парный {{/each}} с учётом вложенности
const eachBlock = tpl => {
  const open = /\{\{#each\s+([\w.]+)\s*\}\}/g
  const m = open.exec(tpl)
  if (!m) return null
  let depth = 1, i = open.lastIndex
  const token = /\{\{#each\s+[\w.]+\s*\}\}|\{\{\/each\}\}/g
  token.lastIndex = i
  let t
  while ((t = token.exec(tpl))) {
    depth += t[0] === '{{/each}}' ? -1 : 1
    if (depth === 0) return { start: m.index, bodyStart: i, bodyEnd: t.index, end: token.lastIndex, expr: m[1] }
  }
  throw new Error('{{#each ' + m[1] + '}} без закрывающего {{/each}}')
}

const render = (tpl, ctx, depth = 0) => {
  if (depth > 12) throw new Error('слишком глубокая вложенность шаблонов')

  // партиалы
  let guard = 0
  while (/\{\{>\s*[\w-]+\s*\}\}/.test(tpl)) {
    if (++guard > 12) throw new Error('циклическое включение партиалов')
    tpl = tpl.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, n) => partial(n))
  }

  // циклы
  let blk
  while ((blk = eachBlock(tpl))) {
    const arr = get(ctx, blk.expr)
    if (arr !== undefined && !Array.isArray(arr)) throw new Error('{{#each ' + blk.expr + '}} — это не массив')
    const body = tpl.slice(blk.bodyStart, blk.bodyEnd)
    const out = (arr || []).map((item, i) => render(
      body,
      { ...ctx, ...(item && typeof item === 'object' && !Array.isArray(item) ? item : {}), this: item, _index: i + 1, _last: i === arr.length - 1 },
      depth + 1
    )).join('')
    tpl = tpl.slice(0, blk.start) + out + tpl.slice(blk.end)
  }

  // подстановки
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, expr) => {
    const v = get(ctx, expr)
    if (v === undefined) throw new Error('нет поля {{' + expr + '}}')
    if (v === null) return optional.has(expr) ? '' : PH
    if (expr.startsWith('raw.')) return String(v)
    return esc(v)
  })
}

/* ---------- 5. Производные значения ---------- */
const b = data.business
const origin = b.domain ? 'https://' + b.domain : ''
const telHref = b.phone ? 'tel:' + b.phone : ''

const businessNode = {
  '@type': b.schemaType,
  '@id': origin + '/#business',
  name: b.name,
  description: b.shortDescription,
  url: origin + '/',
  telephone: b.phone || undefined,
  email: b.email || undefined,
  priceRange: b.priceRange,
  image: origin + '/assets/img/og.jpg',
  address: {
    '@type': 'PostalAddress',
    streetAddress: b.address.street || undefined,
    addressLocality: b.address.city,
    addressRegion: b.address.state,
    postalCode: b.address.zip || undefined,
    addressCountry: b.address.country
  },
  areaServed: b.areaServed.map(n => ({ '@type': 'City', name: n })),
  sameAs: [b.instagram, b.gbpUrl].filter(Boolean)
}
if (Array.isArray(b.hours)) {
  businessNode.openingHoursSpecification = b.hours.map(h => ({
    '@type': 'OpeningHoursSpecification', dayOfWeek: h.days, opens: h.opens, closes: h.closes
  }))
}

const jsonld = (extra = []) => JSON.stringify({ '@context': 'https://schema.org', '@graph': [businessNode, ...extra] }, null, 0)
  .replace(/</g, '\\u003c')

const pageNode = (url, title, modified) => ({
  '@type': 'WebPage', '@id': origin + url + '#page', url: origin + url, name: title,
  isPartOf: { '@id': origin + '/#business' }, dateModified: modified
})

/* ---------- 6. Страницы ---------- */
const OUT = p('site')
try {
  fs.rmSync(OUT, { recursive: true, force: true })
} catch {
  // на смонтированной папке без права на удаление чистка невозможна — пишем поверх
  console.error('  site/ не удалось очистить, файлы перезаписываются поверх')
}
fs.mkdirSync(OUT, { recursive: true })

const built = []
const emit = (url, html) => {
  const file = url === '/' ? 'index.html' : url.replace(/^\//, '').replace(/\/$/, '') + '/index.html'
  fs.mkdirSync(path.join(OUT, path.dirname(file)), { recursive: true })
  fs.writeFileSync(path.join(OUT, file), html)
  built.push(url)
}

const base = {
  ...data,
  computed: {
    origin, telHref, year: new Date().getFullYear(), buildDate: today,
    // пустой массив = строки контакта просто нет, а не пустая ссылка в подвале
    phoneLinks: b.phone ? [{ href: telHref, label: b.phoneDisplay || b.phone }] : []
  }
}

const page = (tplName, url, title, description, extraSchema = [], extra = {}) => {
  const ctx = {
    ...base, ...extra,
    page: { url, title, description, canonical: origin + url, noindex: extra.noindex ? 'noindex,nofollow' : 'index,follow' },
    raw: { jsonld: jsonld([pageNode(url, title, today), ...extraSchema]) }
  }
  emit(url, render(fs.readFileSync(p('templates', tplName + '.html'), 'utf8'), ctx))
}

const serviceNodes = data.rituals.map(r => ({
  '@type': 'Service', '@id': origin + '/ritual/#' + r.slug, name: r.name, description: r.summary,
  serviceType: 'Russian banya ritual', provider: { '@id': origin + '/#business' }, areaServed: b.areaServed.join(', ')
}))

page('index', '/', b.name + ' — ' + data.seo.titleSuffix, data.seo.description, serviceNodes)
page('ritual', '/ritual/', 'The Two Rituals — ' + b.name, 'The Lab Session at the dock and the Ocean Session under sail. What happens, how long, what it costs.', serviceNodes)
page('masters', '/masters/', 'The Masters — ' + b.name, 'Max and Yura. Why a banya is the master who holds it.')
page('answers', '/answers/', 'Answers — ' + b.name, 'Direct answers to what people ask before their first banya.', [{
  '@type': 'FAQPage', '@id': origin + '/answers/#faq',
  mainEntity: data.answers.map(a => ({
    '@type': 'Question', name: a.question,
    acceptedAnswer: { '@type': 'Answer', text: [a.short, ...a.body].join(' ') }
  }))
}])
for (const a of data.answers) {
  page('answer', '/answers/' + a.slug + '/', a.question + ' — ' + b.name, a.short, [{
    '@type': 'FAQPage', '@id': origin + '/answers/' + a.slug + '/#faq',
    mainEntity: [{ '@type': 'Question', name: a.question, acceptedAnswer: { '@type': 'Answer', text: [a.short, ...a.body].join(' ') } }]
  }], { answer: a })
}
page('apply', '/apply/', 'Apply — ' + b.name, 'Send an application. A master replies to arrange a date.')
page('pay', '/pay/', 'Payment — ' + b.name, 'Payment page for confirmed guests.', [], { noindex: true })
page('thanks', '/thanks/', 'Received — ' + b.name, 'Your application has been received.', [], { noindex: true })

/* ---------- 7. Статика ---------- */
const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    e.isDirectory() ? copyDir(path.join(from, e.name), path.join(to, e.name))
                    : fs.copyFileSync(path.join(from, e.name), path.join(to, e.name))
  }
}
copyDir(p('assets'), path.join(OUT, 'assets'))

fs.writeFileSync(path.join(OUT, 'robots.txt'),
  data.aiCrawlers.map(a => `User-agent: ${a}\nAllow: /\n`).join('\n') +
  `\nUser-agent: *\nAllow: /\nDisallow: /pay/\nDisallow: /thanks/\n` +
  (origin ? `\nSitemap: ${origin}/sitemap.xml\n` : '\n'))

fs.writeFileSync(path.join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  built.filter(u => !['/pay/', '/thanks/'].includes(u))
    .map(u => `  <url><loc>${origin}${u}</loc><lastmod>${today}</lastmod></url>`).join('\n') +
  `\n</urlset>\n`)

fs.writeFileSync(path.join(OUT, '_headers'),
  `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: DENY\n`)

fs.writeFileSync(p('site/.build.json'), JSON.stringify({
  draft: DRAFT, builtAt: new Date().toISOString(), pages: built,
  clientHash: hash(fs.readFileSync(p('client.json')))
}, null, 2))

function hash (buf) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (const ch of buf) { h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677) }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

console.log(`  Собрано ${built.length} страниц${DRAFT ? ' — ЧЕРНОВИК, ' + blocking.length + ' обязательное(ых) поле(й) не заполнено' : ''}`)
