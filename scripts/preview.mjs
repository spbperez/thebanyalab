#!/usr/bin/env node
// Однофайловый просмотр всего сайта: удобно открыть на телефоне или отдать владельцу.
// Не деплоится, в site/ не попадает. npm run preview
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const p = (...a) => path.join(ROOT, ...a)
const SITE = p('site')
if (!fs.existsSync(SITE)) { console.error('Сначала npm run build или npm run build:draft'); process.exit(1) }

const files = []
;(function scan (d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name)
    e.isDirectory() ? scan(f) : e.name.endsWith('.html') && files.push(f)
  }
})(SITE)

const routeOf = f => {
  const rel = path.relative(SITE, f).replace(/index\.html$/, '')
  return '/' + rel
}

const pages = files.map(f => {
  const html = fs.readFileSync(f, 'utf8')
  const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'))
    .replace(/<a class="skip"[\s\S]*?<\/a>/, '')
  const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1]
  return { route: routeOf(f), title, body }
}).sort((a, b) => a.route.length - b.route.length || a.route.localeCompare(b.route))

const css = fs.readFileSync(p('assets/css/theme.css'), 'utf8')

const out = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Banya Lab — предпросмотр</title>
<style>${css}
.pv-page[hidden]{display:none!important}
.pv-bar{position:fixed;left:0;right:0;bottom:0;z-index:20;display:flex;gap:.75rem;overflow-x:auto;
  padding:.6rem .9rem;background:rgba(10,10,10,.94);border-top:1px solid var(--hair);
  font:400 .75rem/1 var(--sans);letter-spacing:.06em}
.pv-bar button{background:none;border:0;color:var(--dim);white-space:nowrap;padding:.35rem .1rem;cursor:pointer;font:inherit}
.pv-bar button[aria-current="true"]{color:var(--ember)}
body{padding-bottom:3.25rem}
</style></head><body>
${pages.map(pg => `<div class="pv-page" id="pv:${pg.route}" hidden>${pg.body}</div>`).join('\n')}
<nav class="pv-bar" aria-label="Предпросмотр страниц">
${pages.map(pg => `<button data-route="${pg.route}">${pg.route}</button>`).join('\n')}
</nav>
<script>
(function(){
  var show=function(r){
    document.querySelectorAll('.pv-page').forEach(function(el){el.hidden=el.id!=='pv:'+r});
    document.querySelectorAll('.pv-bar button').forEach(function(b){b.setAttribute('aria-current',String(b.dataset.route===r))});
    window.scrollTo(0,0);
  };
  document.addEventListener('click',function(e){
    var b=e.target.closest('.pv-bar button'); if(b){show(b.dataset.route);return}
    var a=e.target.closest('a'); if(!a)return;
    var h=a.getAttribute('href')||'';
    if(h.charAt(0)==='/'){e.preventDefault();show(h.split('#')[0])}
    else if(h.charAt(0)==='#'){e.preventDefault()}
  });
  document.querySelectorAll('form').forEach(function(f){f.addEventListener('submit',function(e){e.preventDefault();show('/thanks/')})});
  show('/');
})();
</script>
</body></html>`

fs.writeFileSync(p('preview.html'), out)
console.log('  preview.html — ' + pages.length + ' страниц, ' + Math.round(out.length / 1024) + ' КБ')
