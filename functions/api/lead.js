// Приём заявки. Без базы: заявка живёт только в момент отправки,
// поэтому два независимых канала — Telegram и email. Один упал, второй доставил.
// Переменные: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, RESEND_API_KEY, FROM_EMAIL, OWNER_EMAIL

const REDIRECT = (url, to) => Response.redirect(new URL(to, url).toString(), 303)

const toE164 = raw => {
  const s = String(raw).trim()
  if (s.startsWith('+')) {
    const d = s.slice(1).replace(/\D/g, '')
    return d.length >= 8 && d.length <= 15 ? '+' + d : null
  }
  const d = s.replace(/\D/g, '')
  if (d.length === 10) return '+1' + d
  if (d.length === 11 && d[0] === '1') return '+' + d
  return null
}

const clean = (v, max) => String(v ?? '').trim().slice(0, max)

export async function onRequestPost ({ request, env }) {
  const url = request.url
  let form
  try { form = await request.formData() } catch { return new Response('Bad request', { status: 400 }) }

  // honeypot: стоит ноль, закрывает примитивных ботов
  if (clean(form.get('company'), 100)) return REDIRECT(url, '/thanks/')

  const name = clean(form.get('name'), 80)
  const email = clean(form.get('email'), 120)
  const when = clean(form.get('when'), 120)
  const message = clean(form.get('message'), 1200)
  const people = clean(form.get('people'), 3)
  const phone = toE164(clean(form.get('phone'), 30) || '')

  const errors = []
  if (name.length < 2) errors.push('name')
  if (!phone) errors.push('phone')
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) errors.push('email')
  if (!when) errors.push('when')
  if (errors.length) {
    return new Response('Please check: ' + errors.join(', '), {
      status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' }
    })
  }

  const received = new Date().toLocaleString('en-US', { timeZone: 'Pacific/Honolulu' })
  const lines = [
    'NEW APPLICATION', '',
    'Name:    ' + name,
    'Phone:   ' + phone,
    'Email:   ' + email,
    'People:  ' + (people || '-'),
    'When:    ' + when,
    message ? '\n' + message : '',
    '', 'Received ' + received + ' HST'
  ].filter(l => l !== '').join('\n')

  const results = await Promise.allSettled([
    sendTelegram(env, lines),
    sendEmail(env, name, phone, lines)
  ])

  const failed = results.filter(r => r.status === 'rejected')
  if (failed.length === results.length) {
    console.error('LEAD LOST - both channels failed', lines, failed.map(f => String(f.reason)))
    return new Response('We could not deliver your application. Please write to us on Instagram.', {
      status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' }
    })
  }
  if (failed.length) console.error('lead: channel failed', failed.map(f => String(f.reason)))

  return REDIRECT(url, '/thanks/')
}

async function sendTelegram (env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) throw new Error('telegram not configured')
  const api = 'https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage'
  const r = await fetch(api, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true })
  })
  if (!r.ok) throw new Error('telegram ' + r.status + ' ' + await r.text())
}

async function sendEmail (env, name, phone, text) {
  if (!env.RESEND_API_KEY || !env.OWNER_EMAIL || !env.FROM_EMAIL) throw new Error('email not configured')
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.FROM_EMAIL, to: [env.OWNER_EMAIL],
      subject: 'Application - ' + name + ' - ' + phone, text
    })
  })
  if (!r.ok) throw new Error('resend ' + r.status + ' ' + await r.text())
}

export const onRequestGet = () => new Response('Method not allowed', { status: 405 })
