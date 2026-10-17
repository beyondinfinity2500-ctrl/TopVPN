/**
 * Admin dashboard shell. Rendered by the Worker (never part of the static
 * build, so it is never a public asset). Contains no sensitive data itself:
 * the browser decides between the login view and the dashboard after checking
 * /admin/api/session, and every data route requires a valid session cookie.
 */

export function adminShell(authenticated: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>TopVPN — Advertising Admin</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#0b1220; color:#e4e7ec; font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
  header { display:flex; align-items:center; justify-content:space-between; padding:14px 20px; border-bottom:1px solid #1d2939; background:#101828; position:sticky; top:0; z-index:10; }
  header h1 { font-size:16px; margin:0; font-weight:650; }
  header .who { color:#98a2b3; font-size:12px; }
  main { max-width:1180px; margin:0 auto; padding:20px; }
  .card { background:#101828; border:1px solid #1d2939; border-radius:10px; padding:16px; }
  h2 { font-size:15px; margin:0 0 12px; }
  input, select, textarea, button { font:inherit; color:#e4e7ec; }
  input[type=text], input[type=password], input[type=date], select, textarea {
    background:#0b1220; border:1px solid #2b3a4d; border-radius:7px; padding:8px 10px; width:100%;
  }
  input:focus, select:focus, textarea:focus { outline:2px solid #3b82f6; outline-offset:1px; }
  button { background:#2970ff; border:0; border-radius:7px; padding:8px 14px; cursor:pointer; font-weight:600; }
  button:hover { background:#1c5fd6; }
  button.ghost { background:#1d2939; }
  button.danger { background:#b42318; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; }
  .row > * { flex:1 1 160px; }
  table { width:100%; border-collapse:collapse; margin-top:12px; }
  th, td { text-align:left; padding:9px 8px; border-bottom:1px solid #1d2939; font-size:13px; vertical-align:top; }
  th { color:#98a2b3; font-weight:600; white-space:nowrap; }
  tr.rowlink { cursor:pointer; }
  tr.rowlink:hover td { background:#15233a; }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; font-weight:600; }
  .pill.paid { background:#063a2c; color:#12b76a; }
  .pill.pending { background:#2c2a06; color:#f7c948; }
  .pill.failed, .pill.expired, .pill.cancelled { background:#3a0d0d; color:#f04438; }
  .pill.approved { background:#063a2c; color:#12b76a; }
  .pill.rejected { background:#3a0d0d; color:#f04438; }
  .pill.active, .pill.scheduled { background:#0c2a4d; color:#3b82f6; }
  .pill.completed { background:#2b3a4d; color:#98a2b3; }
  .pager { display:flex; gap:8px; align-items:center; margin-top:14px; justify-content:center; }
  .error { background:#3a0d0d; color:#fda29b; padding:10px 12px; border-radius:8px; margin:12px 0; }
  .hidden { display:none !important; }
  #login { max-width:380px; margin:8vh auto; }
  #detail { position:fixed; inset:0; background:rgba(4,10,20,.72); display:flex; }
  #detail .panel { margin:auto; width:min(760px, 94vw); max-height:90vh; overflow:auto; background:#101828; border:1px solid #2b3a4d; border-radius:12px; padding:20px; }
  dl { display:grid; grid-template-columns:170px 1fr; gap:6px 14px; margin:10px 0 16px; }
  dt { color:#98a2b3; }
  dd { margin:0; word-break:break-word; }
  .actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
  pre, .copybox { background:#0b1220; border:1px solid #1d2939; border-radius:8px; padding:10px; white-space:pre-wrap; word-break:break-word; font-size:12px; max-height:220px; overflow:auto; }
  img.preview { max-width:100%; border:1px solid #1d2939; border-radius:8px; }
  .note { color:#98a2b3; font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>TopVPN · Advertising Admin</h1>
  <div class="row" style="flex:0">
    <span class="who" id="who"></span>
    <button class="ghost hidden" id="logoutBtn">Log out</button>
  </div>
</header>
<main>
  <div class="card hidden" id="login">
    <h2>Sign in</h2>
    <div class="error hidden" id="loginError"></div>
    <p class="note">Admin access is restricted. Attempted logins are rate-limited.</p>
    <form id="loginForm" autocomplete="off" style="display:grid; gap:10px">
      <label>Password<br><input type="password" name="password" required></label>
      <button type="submit">Sign in</button>
    </form>
  </div>

  <div id="dashboard" class="hidden">
    <div class="card">
      <h2>Orders</h2>
      <div class="row">
        <label>Search<input type="text" id="q" placeholder="ID, name, email, website"></label>
        <label>Payment<select id="fPayment"><option value="">All</option><option>pending</option><option>paid</option><option>failed</option><option>expired</option><option>cancelled</option></select></label>
        <label>Approval<select id="fApproval"><option value="">All</option><option>pending</option><option>approved</option><option>rejected</option></select></label>
        <label>Campaign<select id="fCampaign"><option value="">All</option><option>pending</option><option>scheduled</option><option>active</option><option>completed</option><option>cancelled</option></select></label>
        <button class="ghost" id="clearFilters">Clear</button>
      </div>
      <div class="error hidden" id="listError"></div>
      <div style="overflow:auto">
      <table>
        <thead><tr>
          <th>Order</th><th>Customer</th><th>Plan</th><th>Total</th><th>Payment</th><th>Creative</th><th>Approval</th><th>Campaign</th>
        </tr></thead>
        <tbody id="orderRows"></tbody>
      </table>
      </div>
      <div class="pager">
        <button class="ghost" id="prevPage">‹ Prev</button>
        <span id="pageInfo"></span>
        <button class="ghost" id="nextPage">Next ›</button>
      </div>
    </div>
  </div>
</main>

<div id="detail" class="hidden"></div>

<script>
let csrf = null;
let page = 1;
const $ = (s) => document.querySelector(s);

function money(cents, currency) { return (cents / 100).toFixed(2) + ' ' + (currency || 'USD'); }
function pill(status) { return '<span class="pill ' + status + '">' + status + '</span>'; }
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

async function api(path, options) {
  // FormData sets its own multipart boundary, so the JSON default must not apply.
  const defaults = options && options.body instanceof FormData
    ? { credentials: 'same-origin' }
    : { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } };
  const res = await fetch(path, Object.assign(defaults, options || {}));
  let body = null;
  const text = await res.text();
  if (text) { try { body = JSON.parse(text); } catch (e) { body = { error: text }; } }
  if (!res.ok) throw new Error((body && body.error) || ('HTTP ' + res.status));
  return body;
}

async function init() {
  try {
    const s = await api('/admin/api/session');
    if (s.authenticated) { csrf = s.csrfToken; showDashboard(); }
    else { showLogin(); }
  } catch (e) { showLogin(); }
}

function showLogin() {
  $('#login').classList.remove('hidden');
  $('#dashboard').classList.add('hidden');
  $('#logoutBtn').classList.add('hidden');
  $('#who').textContent = '';
}

async function showDashboard() {
  $('#login').classList.add('hidden');
  $('#dashboard').classList.remove('hidden');
  $('#logoutBtn').classList.remove('hidden');
  await loadOrders();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#loginError');
  err.classList.add('hidden');
  try {
    const data = await api('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: e.target.password.value }) });
    csrf = data.csrfToken;
    await showDashboard();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/admin/api/logout', { method: 'POST' }); } catch (e) {}
  csrf = null;
  showLogin();
});

['q', 'fPayment', 'fApproval', 'fCampaign'].forEach((id) => {
  $('#' + id).addEventListener('input', () => { page = 1; loadOrders(); });
});
$('#clearFilters').addEventListener('click', () => {
  $('#q').value = ''; $('#fPayment').value = ''; $('#fApproval').value = ''; $('#fCampaign').value = '';
  page = 1; loadOrders();
});
$('#prevPage').addEventListener('click', () => { if (page > 1) { page--; loadOrders(); } });
$('#nextPage').addEventListener('click', () => { page++; loadOrders(); });

async function loadOrders() {
  const params = new URLSearchParams({ page: String(page) });
  const q = $('#q').value.trim();
  if (q) params.set('q', q);
  if ($('#fPayment').value) params.set('payment', $('#fPayment').value);
  if ($('#fApproval').value) params.set('approval', $('#fApproval').value);
  if ($('#fCampaign').value) params.set('campaign', $('#fCampaign').value);
  const err = $('#listError'); err.classList.add('hidden');
  try {
    const data = await api('/admin/api/orders?' + params.toString());
    const rows = $('#orderRows');
    rows.innerHTML = '';
    (data.orders || []).forEach((o) => {
      const tr = document.createElement('tr');
      tr.className = 'rowlink';
      tr.innerHTML =
        '<td><strong>' + esc(o.id) + '</strong><br><span class="note">' + esc(new Date(o.created_at).toLocaleString()) + '</span></td>' +
        '<td>' + esc(o.customer_name) + '<br><span class="note">' + esc(o.customer_email) + '<br>' + esc(o.customer_website) + '</span></td>' +
        '<td>' + esc(o.placement) + '<br><span class="note">' + o.duration_months + ' mo · ' + esc(o.creative_format) + '</span></td>' +
        '<td>' + money(o.amount_cents, o.currency) + '</td>' +
        '<td>' + pill(o.payment_status) + '</td>' +
        '<td><span class="note">' + esc(o.creative_format) + '</span></td>' +
        '<td>' + pill(o.approval_status) + '</td>' +
        '<td>' + pill(o.campaign_status) + '</td>';
      tr.addEventListener('click', () => openDetail(o.id));
      rows.appendChild(tr);
    });
    const pages = Math.max(1, Math.ceil(data.total / data.perPage));
    $('#pageInfo').textContent = 'Page ' + data.page + ' / ' + pages + ' · ' + data.total + ' orders';
    $('#prevPage').disabled = data.page <= 1;
    $('#nextPage').disabled = data.page >= pages;
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
}

async function openDetail(id) {
  const wrap = $('#detail');
  wrap.classList.remove('hidden');
  wrap.innerHTML = '<div class="panel">Loading…</div>';
  try {
    const data = await api('/admin/api/orders/' + encodeURIComponent(id));
    const o = data.order;
    let creativeHtml = '<span class="note">Loading creative…</span>';
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML =
      '<div class="row"><h2 style="flex:1">' + esc(o.id) + '</h2><button class="ghost" id="closeDetail">Close</button></div>' +
      '<dl>' +
      '<dt>Customer</dt><dd>' + esc(o.customer_name) + '<br>' + esc(o.customer_email) + '<br>' + esc(o.customer_website) + '</dd>' +
      '<dt>Plan</dt><dd>' + esc(o.placement) + ' · ' + o.duration_months + ' months · ' + esc(o.creative_format) + ' creative</dd>' +
      '<dt>Total</dt><dd>' + money(o.amount_cents, o.currency) + '</dd>' +
      '<dt>Payment</dt><dd>' + pill(o.payment_status) + (o.stripe_payment_reference ? '<br><span class="note">ref: ' + esc(o.stripe_payment_reference) + '</span>' : '') + '<br><span class="note">checkout session: ' + esc(o.stripe_checkout_session_id || '—') + '</span></dd>' +
      '<dt>Approval</dt><dd>' + pill(o.approval_status) + '</dd>' +
      '<dt>Campaign</dt><dd>' + pill(o.campaign_status) + '<br><span class="note">' + esc(o.campaign_start || 'not scheduled') + ' → ' + esc(o.campaign_end || '—') + '</span></dd>' +
      '<dt>Emails</dt><dd><span class="note">customer: ' + esc(o.customer_email_status || '—') + '<br>admin: ' + esc(o.admin_email_status || '—') + '</span></dd>' +
      '<dt>Created / updated</dt><dd><span class="note">' + esc(o.created_at) + '<br>' + esc(o.updated_at) + '</span></dd>' +
      '</dl>' +
      '<h2>Creative</h2>' +
      (o.creative_format === 'image' && o.creative_status
        ? '<p class="note">Status: <strong>' + esc(o.creative_status) + '</strong>' +
          (o.creative_width ? ' · ' + o.creative_width + '×' + o.creative_height + 'px (optimized WebP)' : '') +
          (o.creative_optimization_error ? '<br><span class="error">' + esc(o.creative_optimization_error) + '</span>' : '') +
          '</p>'
        : '') +
      '<div id="creativeBox">' + creativeHtml + '</div>' +
      (o.creative_format === 'image'
        ? '<h3 style="margin-top:12px">Replace creative (retry)</h3>' +
          '<div class="row">' +
          '<input type="file" id="replaceFile" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp">' +
          '<button class="ghost" id="replaceBtn">Upload replacement</button>' +
          '</div><p class="note">Re-runs optimization and stores a new WebP. Payment and approval are not affected.</p>'
        : '') +
      '<h2 style="margin-top:16px">Review actions</h2>' +
      '<div class="actions">' +
      '<button id="approveBtn">Mark approved</button><button class="danger" id="rejectBtn">Mark rejected</button>' +
      '</div>' +
      '<h2 style="margin-top:16px">Campaign status</h2>' +
      '<div class="row">' +
      '<label>Status<select id="campaignStatus"><option>pending</option><option>scheduled</option><option>active</option><option>completed</option><option>cancelled</option></select></label>' +
      '<label>Start date<input type="date" id="campaignStart"></label>' +
      '<button id="saveCampaign">Save</button>' +
      '</div>' +
      '<h2 style="margin-top:16px">Internal note</h2>' +
      '<textarea id="noteText" rows="3" placeholder="Add an internal note (not visible to the customer)"></textarea>' +
      '<div class="actions"><button class="ghost" id="addNote">Add note</button></div>' +
      (o.admin_notes ? '<h2 style="margin-top:16px">Notes</h2><pre>' + esc(o.admin_notes) + '</pre>' : '');
    wrap.innerHTML = '';
    wrap.appendChild(panel);
    panel.querySelector('#closeDetail').addEventListener('click', () => wrap.classList.add('hidden'));
    panel.querySelector('#campaignStatus').value = o.campaign_status;
    if (o.campaign_start) panel.querySelector('#campaignStart').value = o.campaign_start.slice(0, 10);

    // Creative preview (admin-only route).
    const box = panel.querySelector('#creativeBox');
    try {
      if (o.creative_format === 'image') {
        const img = document.createElement('img');
        img.className = 'preview';
        img.src = '/admin/api/orders/' + encodeURIComponent(o.id) + '/creative';
        box.innerHTML = ''; box.appendChild(img);
      } else {
        const c = await api('/admin/api/orders/' + encodeURIComponent(o.id) + '/creative');
        const pre = document.createElement('div');
        pre.className = 'copybox';
        pre.textContent = 'Destination: ' + (c.destinationUrl || '—') + '\\n\\n' + (c.copy || '');
        box.innerHTML = ''; box.appendChild(pre);
      }
    } catch (ex) { box.textContent = 'Could not load creative: ' + ex.message; }

    panel.querySelector('#approveBtn').addEventListener('click', () => setApproval(o.id, 'approved'));
    panel.querySelector('#rejectBtn').addEventListener('click', () => setApproval(o.id, 'rejected'));
    panel.querySelector('#saveCampaign').addEventListener('click', () => setCampaign(o.id, panel));
    panel.querySelector('#addNote').addEventListener('click', () => addNote(o.id, panel));
    const replaceBtn = panel.querySelector('#replaceBtn');
    if (replaceBtn) replaceBtn.addEventListener('click', () => replaceCreative(o.id, panel));
  } catch (ex) {
    wrap.innerHTML = '<div class="panel"><div class="error">' + esc(ex.message) + '</div><button class="ghost" onclick="document.getElementById(\'detail\').classList.add(\'hidden\')">Close</button></div>';
  }
}

async function postAction(id, path, body, panel) {
  try {
    await api('/admin/api/orders/' + encodeURIComponent(id) + '/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify(body),
    });
    await openDetail(id);
    await loadOrders();
  } catch (ex) {
    alert(ex.message);
  }
}
function setApproval(id, status) { postAction(id, 'approval', { status }); }
function setCampaign(id, panel) {
  postAction(id, 'campaign', { status: panel.querySelector('#campaignStatus').value, start: panel.querySelector('#campaignStart').value });
}
function addNote(id, panel) { postAction(id, 'note', { note: panel.querySelector('#noteText').value }); }

async function replaceCreative(id, panel) {
  const input = panel.querySelector('#replaceFile');
  if (!input.files || !input.files.length) { alert('Choose an image file first.'); return; }
  const form = new FormData();
  form.append('creative', input.files[0]);
  try {
    await api('/admin/api/orders/' + encodeURIComponent(id) + '/creative/replace', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: form,
    });
    await openDetail(id);
    await loadOrders();
  } catch (ex) {
    alert(ex.message);
  }
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#detail').classList.add('hidden'); });
window.addEventListener('DOMContentLoaded', init);
</script>
</body>
</html>`;
}
