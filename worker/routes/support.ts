/**
 * Support assistant routes.
 *
 *   POST /api/support/chat    public, rate-limited, rule-based answers (no AI cost)
 *   GET  /support/widget.js   tiny lazy-loaded launcher script for account pages
 *
 * The widget renders only a launcher button until opened; the panel and the
 * first API request happen strictly on user action, so page load is unaffected.
 */
import type { Env } from '../env';
import { json } from './api';
import { bumpRateLimit } from '../db';
import { answerSupportQuestion } from '../support/chat';

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

export async function supportChat(request: Request, env: Env): Promise<Response> {
  if (env.SUPPORT_CHAT_ENABLED === 'false') {
    return json({ error: 'Support chat is disabled.' }, 503);
  }

  let message = '';
  try {
    const body = (await request.json()) as { message?: unknown };
    if (typeof body?.message === 'string') message = body.message;
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  message = message.trim();
  if (!message) return json({ error: 'A question is required.' }, 400);
  if (message.length > 1000) return json({ error: 'Message is too long.' }, 422);

  // Fixed-window abuse guard: 20 questions per 5 minutes per IP.
  const ip = clientIp(request);
  const bucket = Math.floor(Date.now() / 1000 / 300);
  const window = await env.DB.prepare(
    `INSERT INTO ads_rate_limits (key, bucket, count, window_start) VALUES (?, ?, 1, ?)
       ON CONFLICT (key, bucket) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(`support-chat:${ip}`, bucket, bucket)
    .first<{ count: number }>();
  if ((window?.count ?? 1) > 20) {
    return json({ error: 'Too many questions. Please try again in a few minutes.' }, 429);
  }

  const answer = answerSupportQuestion(message);
  return json({
    reply: answer.reply,
    ticketSuggestion: answer.ticketSuggestion,
    source: 'assistant-guidance', // never confirmed account data
  });
};

const WIDGET_JS = `(function(){
if(window.__topvpnSupport)return;window.__topvpnSupport=true;
var open=false,panel=null,log=null,input=null,sendBtn=null,busy=false;
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x)e.textContent=x;return e}
function bubble(c,x){var b=el('div','tvsp-msg '+c);b.textContent=x;log.appendChild(b);log.scrollTop=log.scrollHeight;return b}
function buildPanel(){
  panel=el('div','tvsp-panel');panel.setAttribute('role','dialog');panel.setAttribute('aria-label','Support assistant');
  var head=el('div','tvsp-head'),title=el('strong',null,'TopVPN Assistant'),x=el('button','tvsp-x','\\u00d7');
  x.type='button';x.setAttribute('aria-label','Close support assistant');x.addEventListener('click',toggle);
  head.appendChild(title);head.appendChild(x);
  log=el('div','tvsp-log');log.setAttribute('role','log');log.setAttribute('aria-live','polite');
  var foot=el('form','tvsp-foot');
  input=el('input','tvsp-in');input.maxLength=1000;input.placeholder='Ask about setup, orders, renewal\\u2026';input.setAttribute('aria-label','Your question');
  sendBtn=el('button','tvsp-send','Send');sendBtn.type='submit';
  foot.appendChild(input);foot.appendChild(sendBtn);
  foot.addEventListener('submit',submit);
  var note=el('div','tvsp-note','Guidance only \\u2014 your account data is in My VPN.');
  panel.appendChild(head);panel.appendChild(log);panel.appendChild(foot);panel.appendChild(note);
  document.body.appendChild(panel);
  bubble('tvsp-ai','Hi! I can help with VPN setup (Android, iOS, Windows, macOS), connection problems, orders, renewal and account access.');
}
function ticketLink(){var a=el('a','tvsp-ticket','Open a support ticket');a.href='/account/support';log.appendChild(a);log.scrollTop=log.scrollHeight}
function submit(ev){
  ev.preventDefault();if(busy)return;var q=input.value.trim();if(!q)return;
  input.value='';bubble('tvsp-me',q);busy=true;sendBtn.disabled=true;
  var load=bubble('tvsp-ai tvsp-load','\\u2026');
  var ctrl=new AbortController();var timer=setTimeout(function(){ctrl.abort()},15000);
  fetch('/api/support/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:q}),signal:ctrl.signal})
  .then(function(r){return r.json()}).then(function(d){
    if(d&&d.reply){load.textContent=d.reply;if(d.ticketSuggestion)ticketLink()}
    else{load.textContent='Sorry \\u2014 the assistant is unavailable right now. Please try again later.'}
  }).catch(function(){load.textContent='Connection problem \\u2014 please try again.'})
  .finally(function(){clearTimeout(timer);busy=false;sendBtn.disabled=false});
}
function toggle(){
  if(!panel)buildPanel();
  open=!open;panel.classList.toggle('tvsp-open',open);
  this.setAttribute('aria-expanded',open?'true':'false');
  if(open)input.focus();
}
var btn=el('button','tvsp-launcher','?');
btn.type='button';btn.setAttribute('aria-label','Open support assistant');btn.setAttribute('aria-expanded','false');
btn.addEventListener('click',toggle);
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&open)toggle()});
var css='.tvsp-launcher{position:fixed;right:18px;bottom:18px;z-index:9999;width:52px;height:52px;border-radius:50%;border:0;background:#D4AF37;color:#0B1020;font-size:22px;font-weight:700;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.35)}'+
'.tvsp-panel{display:none;position:fixed;right:18px;bottom:80px;z-index:9999;width:min(360px,92vw);height:min(480px,70vh);background:#11162A;border:1px solid #2A3352;border-radius:14px;color:#E6E8EE;flex-direction:column;overflow:hidden;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.45)}'+
'.tvsp-panel.tvsp-open{display:flex}@media(max-width:480px){.tvsp-panel{right:8px;bottom:78px;width:calc(100vw - 16px)}}'+
'.tvsp-head{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #232A44;background:#0E1326}'+
'.tvsp-x{background:none;border:0;color:#98A2B3;font-size:20px;cursor:pointer;line-height:1}'+
'.tvsp-log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}'+
'.tvsp-msg{padding:8px 12px;border-radius:10px;max-width:85%;white-space:pre-wrap;word-break:break-word}'+
'.tvsp-ai{background:#1D2440;align-self:flex-start}.tvsp-me{background:#D4AF37;color:#0B1020;align-self:flex-end;font-weight:500}'+
'.tvsp-load{color:#98A2B3}.tvsp-ticket{align-self:flex-start;color:#F5D77A;font-size:.9rem}'+
'.tvsp-foot{display:flex;gap:8px;padding:10px;border-top:1px solid #232A44}'+
'.tvsp-in{flex:1;padding:9px 10px;border-radius:8px;border:1px solid #2A3352;background:#0E1326;color:inherit}'+
'.tvsp-send{padding:9px 14px;border-radius:8px;border:0;background:#D4AF37;color:#0B1020;font-weight:600;cursor:pointer}'+
'.tvsp-send:disabled{opacity:.6;cursor:wait}'+
'.tvsp-note{padding:6px 12px;border-top:1px solid #232A44;color:#98A2B3;font-size:11px}';
var style=document.createElement('style');style.textContent=css;document.head.appendChild(style);
document.body.appendChild(btn);
})();`;

export function supportWidgetScript(): Response {
  return new Response(WIDGET_JS, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
