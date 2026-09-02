#!/usr/bin/env node
// Проверки перед выкаткой. Блокируют мерж. Ноль зависимостей.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const p = (...a) => path.join(ROOT, ...a)
const fails = []
const fail = (rule, detail) => fails.push({ rule, detail })
const ok = []

const data = JSON.parse(fs.readFileSync(p('client.json'), 'utf8'))
const verified = JSON.parse(fs.readFileSync(p('verified.json'), 'utf8'))
const b = data.business

/* 1. Незаполненные поля */
const missing = []
;(function walk (n, t) {
  if (n === null) return missing.push(t)
  if (Array.isArray(n)) return n.forEach((v, i) => walk(v, t + '[' + i + ']'))
  if (typeof n === 'object') Object.entries(n).filter(([k]) => !k.startsWith('_')).forEach(([k, v]) => walk(v, t ? t + '.' + k : k))
})(data, '')
missing.length ? fail('client.json заполнен', missing.length + ' поле(й) пусты: ' + missing.join(', ')) : ok.push('client.json заполнен')

/* 2. Лицензии */
const today = new Date().toISOString().slice(0, 10)
const exp = (data.licenses || []).filter(l => l.expires && l.expires < today)
exp.length ? fail('лицензии действуют', exp.map(l => l.name + ' истекла ' + l.expires).join('; ')) : ok.push('лицензии действуют')

/* 3. site/ соответствует client.json */
const BUILD = p('site/.build.json')
if (!fs.existsSync(BUILD)) fail('site/ собран', 'нет site/.build.json — запусти npm run build')
else {
  const meta = JSON.parse(fs.readFileSync(BUILD, 'utf8'))
  if (meta.draft) fail('site/ не черновик', 'собрано с --draft, в проде так нельзя')
  const h = hash(fs.readFileSync(p('client.json')))
  if (meta.clientHash !== h) fail('site/ соответствует client.json', 'client.json менялся после сборки — забыл npm run build')
  if (!meta.draft && meta.clientHash === h) ok.push('site/ соответствует client.json')
}

/* 4. Собираем HTML */
const pages = []
;(function scan (dir) {
  if (!fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name)
    e.isDirectory() ? scan(f) : e.name.endsWith('.html') && pages.push(f)
  }
})(p('site'))
if (!pages.length) fail('страницы собраны', 'в site/ нет ни одной HTML-страницы')

const all = pages.map(f => ({ file: path.relative(p('site'), f), html: fs.readFileSync(f, 'utf8') }))

/* 5. Запрещённые строки */
const banned = [/lorem\s+ipsum/i, /\bTODO\b/, /\bXXX\b/, /example\.com/i, /\b555-\d{4}\b/, /\bFIXME\b/]
for (const { file, html } of all) {
  for (const re of banned) if (re.test(html)) fail('нет заглушек', file + ' содержит ' + re)
}
if (!fails.some(f => f.rule === 'нет заглушек')) ok.push('нет заглушек')

/* 6. NAP символ в символ */
const napIssues = []
if (b.gbpName && b.gbpName !== b.name) napIssues.push('business.name "' + b.name + '" не совпадает с business.gbpName "' + b.gbpName + '"')
for (const { file, html } of all) {
  if (!html.includes(escapeHtml(b.name))) napIssues.push(file + ': нет названия "' + b.name + '"')
}
if (b.phone) {
  const wrong = all.filter(a => /href="tel:([^"]+)"/.test(a.html) && [...a.html.matchAll(/href="tel:([^"]+)"/g)].some(m => m[1] !== b.phone))
  wrong.forEach(a => napIssues.push(a.file + ': tel:-ссылка не совпадает с client.json'))
}
const hardcoded = all.filter(a => /\(\d{3}\)\s?\d{3}-\d{4}|\b\d{3}-\d{3}-\d{4}\b/.test(a.html))
  .filter(a => !b.phoneDisplay || !a.html.includes(b.phoneDisplay))
hardcoded.forEach(a => napIssues.push(a.file + ': телефон в тексте мимо client.json'))
napIssues.length ? napIssues.forEach(d => fail('NAP символ в символ', d)) : ok.push('NAP символ в символ')

/* 7. Цифры не разошлись с verified.json */
const flat = JSON.stringify(data)
const drift = verified.figures.filter(f => !flat.includes(f.value))
drift.length ? drift.forEach(f => fail('цифры совпадают с verified.json', f.what + ' = ' + f.value + ' — в client.json нет'))
             : ok.push('цифры совпадают с verified.json')

/* 8. JSON-LD */
const REQUIRED = ['name', 'telephone', 'address', 'areaServed', 'url', 'image', 'priceRange', 'openingHoursSpecification']
const ldIssues = []
for (const { file, html } of all) {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)
  if (!m) { ldIssues.push(file + ': нет JSON-LD'); continue }
  let ld
  try { ld = JSON.parse(m[1].replace(/\\u003c/g, '<')) } catch (e) { ldIssues.push(file + ': JSON-LD не парсится — ' + e.message); continue }
  const graph = ld['@graph'] || [ld]
  const biz = graph.find(n => n['@id'] && String(n['@id']).endsWith('#business'))
  if (!biz) { ldIssues.push(file + ': нет узла бизнеса'); continue }
  for (const k of REQUIRED) if (biz[k] === undefined || biz[k] === '') ldIssues.push(file + ': в JSON-LD нет ' + k)
  if (!graph.some(n => n.dateModified)) ldIssues.push(file + ': нет dateModified')
  if (biz.aggregateRating && !b.reviewsUrl) ldIssues.push(file + ': aggregateRating без реальных отзывов')
}
ldIssues.length ? ldIssues.slice(0, 12).forEach(d => fail('JSON-LD валиден', d)) : ok.push('JSON-LD валиден')

/* 9. Внутренние ссылки живы */
const exists = href => {
  const clean = href.split('#')[0].split('?')[0]
  if (clean === '' || clean === '/') return fs.existsSync(p('site/index.html'))
  const f = p('site', clean.replace(/^\//, ''))
  return fs.existsSync(f) || fs.existsSync(path.join(f, 'index.html'))
}
const dead = []
for (const { file, html } of all) {
  for (const m of html.matchAll(/(?:href|src)="(\/[^"]*)"/g)) {
    if (m[1].startsWith('/api/')) continue
    if (!exists(m[1])) dead.push(file + ' → ' + m[1])
  }
}
dead.length ? dead.forEach(d => fail('внутренние ссылки живы', d)) : ok.push('внутренние ссылки живы')

/* 10. robots.txt пускает ИИ-краулеров */
const robots = fs.existsSync(p('site/robots.txt')) ? fs.readFileSync(p('site/robots.txt'), 'utf8') : ''
const blocked = data.aiCrawlers.filter(a => !robots.includes('User-agent: ' + a))
blocked.length ? fail('robots.txt пускает ИИ-краулеров', 'не указаны: ' + blocked.join(', ')) : ok.push('robots.txt пускает ИИ-краулеров')

/* 11. Бюджет первого экрана для 4G */
const BUDGET = 150 * 1024
const home = fs.existsSync(p('site/index.html')) ? fs.statSync(p('site/index.html')).size : 0
const css = fs.existsSync(p('site/assets/css/theme.css')) ? fs.statSync(p('site/assets/css/theme.css')).size : 0
const total = home + css
total > BUDGET ? fail('бюджет первого экрана', Math.round(total / 1024) + ' КБ при лимите ' + BUDGET / 1024 + ' КБ')
               : ok.push('бюджет первого экрана — ' + Math.round(total / 1024) + ' КБ')

/* 12. Слово sauna только в образовательном контексте */
const sauna = all.filter(a => /\bsauna\b/i.test(a.html))
  .filter(a => !/not a sauna|is not a sauna|gym sauna|Finnish sauna|same as a sauna|sauna is/i.test(a.html))
sauna.forEach(a => fail('слово sauna только про чужое', a.file))
if (!sauna.length) ok.push('слово sauna только про чужое')

/* Отчёт */
console.log('')
for (const o of ok) console.log('  ok    ' + o)
for (const f of fails) console.log('  ПАДАЕТ  ' + f.rule + ' — ' + f.detail)
console.log('')
if (fails.length) { console.log('  ' + fails.length + ' проверок не прошли\n'); process.exit(1) }
console.log('  все проверки прошли\n')

function escapeHtml (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }
function hash (buf) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (const ch of buf) { h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677) }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}
