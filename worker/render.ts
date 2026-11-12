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
<title>TopVPN â€” Advertising Admin</title>
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
  /* --- dashboard layout: sidebar + views --- */
  #dashboard { display:flex; gap:18px; align-items:flex-start; }
  .sidenav { display:flex; flex-direction:column; gap:4px; min-width:170px; position:sticky; top:64px; }
  .navbtn { text-align:left; padding:9px 14px; border-radius:8px; border:1px solid transparent; background:transparent; color:#98a2b3; font:inherit; cursor:pointer; }
  .navbtn:hover { color:#e4e7ec; background:#101828; }
  .navbtn.active { color:#e4e7ec; background:#101828; border-color:#1d2939; font-weight:600; }
  .views { flex:1; min-width:0; }
  .view { display:none; }
  .view.active { display:block; }
  .statgrid { display:grid; grid-template-columns:repeat(auto-fill, minmax(170px, 1fr)); gap:10px; margin-bottom:14px; }
  .stat { background:#101828; border:1px solid #1d2939; border-radius:10px; padding:12px 14px; }
  .stat .k { color:#98a2b3; font-size:12px; }
  .stat .v { font-size:20px; font-weight:700; margin-top:2px; }
  .stat .v.warn { color:#f5d77a; }
  .stat .v.bad { color:#ff9aa6; }
  .stat .v.ok { color:#8ce3b8; }
  .toolbar { display:flex; gap:8px; align-items:end; flex-wrap:wrap; margin:8px 0; }
  .toolbar label { display:grid; gap:4px; font-size:12px; color:#98a2b3; }
  .toolbar input, .toolbar select { padding:8px 10px; border-radius:8px; border:1px solid #2b3a4d; background:#0b1220; color:#e4e7ec; }
  @media (max-width: 820px) {
    #dashboard { flex-direction:column; }
    .sidenav { flex-direction:row; overflow-x:auto; min-width:0; width:100%; position:static; }
    .navbtn { white-space:nowrap; }
  }
</style>
</head>
<body>
<header>
  <h1>TopVPN — Advertising Admin</h1>
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
    <nav class="sidenav" aria-label="Admin sections">
      <button type="button" class="navbtn active" data-view="overview">Overview</button>
      <button type="button" class="navbtn" data-view="orders">Ads Orders</button>
      <button type="button" class="navbtn" data-view="customers">Customers</button>
      <button type="button" class="navbtn" data-view="coupons">Coupons</button>
      <button type="button" class="navbtn" data-view="tickets">Support</button>
      <button type="button" class="navbtn" data-view="audit">Audit Log</button>
    </nav>

    <div class="views">
      <section id="view-overview" class="view active">
        <div class="statgrid" id="statGrid"></div>
        <div class="card">
          <h2>Recent orders</h2>
          <div style="overflow:auto">
          <table>
            <thead><tr><th>Order</th><th>Customer</th><th>Plan</th><th>Total</th><th>Payment</th><th>Provider</th><th>State</th></tr></thead>
            <tbody id="recentOrderRows"></tbody>
          </table>
          </div>
        </div>
        <div class="card">
          <h2>Recent activity</h2>
          <div class="error hidden" id="overviewError"></div>
          <table>
            <thead><tr><th>Action</th><th>Target</th><th>Detail</th><th>When</th></tr></thead>
            <tbody id="recentAuditRows"></tbody>
          </table>
        </div>
      </section>

      <section id="view-orders" class="view">
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
      </section>

      <section id="view-customers" class="view">
        <div class="card">
          <h2>Customers</h2>
          <div class="toolbar">
            <label>Search email<input type="text" id="customerSearch" placeholder="customer@example.com"></label>
            <button class="ghost" id="customerSearchBtn">Search</button>
          </div>
          <div class="error hidden" id="customerError"></div>
          <div style="overflow:auto">
          <table>
            <thead><tr><th>Customer</th><th>Registered</th><th>Orders</th><th>Paid</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody id="customerRows"></tbody>
          </table>
          </div>
        </div>
      </section>

      <section id="view-coupons" class="view">
        <div class="card">
          <h2>Coupons</h2>
          <div class="error hidden" id="couponError"></div>
          <div style="overflow:auto">
          <table>
            <thead><tr><th>Code</th><th>Discount</th><th>Applies to</th><th>First purchase</th><th>Window</th><th>Redeemed</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody id="couponRows"></tbody>
          </table>
          </div>
        </div>
        <div class="card">
          <h2>New coupon</h2>
          <form id="couponForm" style="display:grid; gap:10px; max-width:560px">
            <label>Code<br><input name="code" required placeholder="WELCOME10"></label>
            <div class="row">
              <label>Type<br><select name="discountType"><option value="fixed">Fixed (cents)</option><option value="percent">Percent</option></select></label>
              <label>Value<br><input name="discountValue" type="number" min="1" required></label>
              <label>Applies to<br><select name="appliesPlanId"><option value="">Any plan</option><option value="monthly">Monthly</option><option value="annual">Annual</option><option value="two-year">Two-Year</option></select></label>
            </div>
            <div class="row">
              <label>Starts (UTC, optional)<br><input name="startsAt" type="date"></label>
              <label>Expires (UTC, optional)<br><input name="expiresAt" type="date"></label>
              <label>Max redemptions<br><input name="maxRedemptions" type="number" min="1" placeholder="unlimited"></label>
              <label>Per customer<br><input name="perCustomerLimit" type="number" min="1" value="1"></label>
            </div>
            <label style="display:flex; gap:8px; align-items:center"><input type="checkbox" name="firstPurchaseOnly" style="width:auto"> First purchase only</label>
            <button type="submit">Create coupon</button>
          </form>
        </div>
      </section>

      <section id="view-tickets" class="view">
        <div class="card">
          <h2>Support tickets</h2>
          <div class="toolbar">
            <label>Status<select id="ticketStatus"><option value="">All</option><option>open</option><option>pending</option><option>closed</option></select></label>
          </div>
          <div class="error hidden" id="ticketError"></div>
          <div style="overflow:auto">
          <table>
            <thead><tr><th>Ticket</th><th>Customer</th><th>Subject</th><th>Status</th><th>Updated</th></tr></thead>
            <tbody id="ticketRows"></tbody>
          </table>
          </div>
        </div>
      </section>

      <section id="view-audit" class="view">
        <div class="card">
          <h2>Audit log</h2>
          <div class="error hidden" id="auditError"></div>
          <div style="overflow:auto">
          <table>
            <thead><tr><th>When</th><th>Action</th><th>Target</th><th>Detail</th><th>IP</th></tr></thead>
            <tbody id="auditRows"></tbody>
          </table>
          </div>
        </div>
      </section>
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
  await loadOverview();
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
        '<td>' + esc(o.placement) + '<br><span class="note">' + o.duration_months + ' mo — ' + esc(o.creative_format) + '</span></td>' +
        '<td>' + money(o.amount_cents, o.currency) + '</td>' +
        '<td>' + pill(o.payment_status) + '</td>' +
        '<td><span class="note">' + esc(o.creative_format) + '</span></td>' +
        '<td>' + pill(o.approval_status) + '</td>' +
        '<td>' + pill(o.campaign_status) + '</td>';
      tr.addEventListener('click', () => openDetail(o.id));
      rows.appendChild(tr);
    });
    const pages = Math.max(1, Math.ceil(data.total / data.perPage));
    $('#pageInfo').textContent = 'Page ' + data.page + ' / ' + pages + ' — ' + data.total + ' orders';
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
  wrap.innerHTML = '<div class="panel">Loadingâ€¦</div>';
  try {
    const data = await api('/admin/api/orders/' + encodeURIComponent(id));
    const o = data.order;
    let creativeHtml = '<span class="note">Loading creativeâ€¦</span>';
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML =
      '<div class="row"><h2 style="flex:1">' + esc(o.id) + '</h2><button class="ghost" id="closeDetail">Close</button></div>' +
      '<dl>' +
      '<dt>Customer</dt><dd>' + esc(o.customer_name) + '<br>' + esc(o.customer_email) + '<br>' + esc(o.customer_website) + '</dd>' +
      '<dt>Plan</dt><dd>' + esc(o.placement) + ' — ' + o.duration_months + ' months — ' + esc(o.creative_format) + ' creative</dd>' +
      '<dt>Total</dt><dd>' + money(o.amount_cents, o.currency) + '</dd>' +
      '<dt>Payment</dt><dd>' + pill(o.payment_status) + (o.stripe_payment_reference ? '<br><span class="note">ref: ' + esc(o.stripe_payment_reference) + '</span>' : '') + '<br><span class="note">checkout session: ' + esc(o.stripe_checkout_session_id || 'â€”') + '</span></dd>' +
      '<dt>Approval</dt><dd>' + pill(o.approval_status) + '</dd>' +
      '<dt>Campaign</dt><dd>' + pill(o.campaign_status) + '<br><span class="note">' + esc(o.campaign_start || 'not scheduled') + ' â†’ ' + esc(o.campaign_end || 'â€”') + '</span></dd>' +
      '<dt>Emails</dt><dd><span class="note">customer: ' + esc(o.customer_email_status || 'â€”') + '<br>admin: ' + esc(o.admin_email_status || 'â€”') + '</span></dd>' +
      '<dt>Created / updated</dt><dd><span class="note">' + esc(o.created_at) + '<br>' + esc(o.updated_at) + '</span></dd>' +
      '</dl>' +
      '<h2>Creative</h2>' +
      (o.creative_format === 'image' && o.creative_status
        ? '<p class="note">Status: <strong>' + esc(o.creative_status) + '</strong>' +
          (o.creative_width ? ' — ' + o.creative_width + 'أ—' + o.creative_height + 'px (optimized WebP)' : '') +
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
        pre.textContent = 'Destination: ' + (c.destinationUrl || 'â€”') + '\\n\\n' + (c.copy || '');
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
    wrap.innerHTML = '<div class="panel"><div class="error">' + esc(ex.message) + '</div><button class="ghost">Close</button></div>';
    wrap.querySelector('button').addEventListener('click', () => wrap.classList.add('hidden'));
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

/* ---------- VPN commerce views ---------- */

const loaders = {
  overview: loadOverview,
  orders: loadOrders,
  customers: loadCustomers,
  coupons: loadCoupons,
  tickets: loadTickets,
  audit: loadAudit,
};

function showView(name) {
  document.querySelectorAll('.navbtn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  const loader = loaders[name];
  if (loader) loader().catch((ex) => console.error(ex));
}

document.querySelectorAll('.navbtn').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

function fmtMoney(cents, currency) { return money(cents, currency); }
function fmtWhen(iso) { try { return new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; } catch { return iso || ''; } }
function statePill(o) {
  const cls = o === 'active' || o === 'succeeded' || o === 'paid' ? 'ok' : (o === 'provisioning_failed' || o === 'reconciliation_required' ? 'bad' : 'warn');
  return '<span class="pill ' + cls + '">' + esc(o) + '</span>';
}

async function loadOverview() {
  const err = $('#overviewError'); err.classList.add('hidden');
  try {
    const data = await api('/admin/api/vpn/overview');
    const s = data.stats || {};
    const cards = [
      ['Customers', s.customers_total, ''],
      ['New (7 days)', s.customers_new_week, ''],
      ['Orders total', s.orders_total, ''],
      ['Orders today', s.orders_today, ''],
      ['Orders this month', s.orders_month, ''],
      ['Gross revenue', fmtMoney(s.gross_cents || 0, 'USD'), 'ok'],
      ['Discounts', '-' + fmtMoney(s.discounts_cents || 0, 'USD'), 'warn'],
      ['Refunds', '-' + fmtMoney(s.refunds_cents || 0, 'USD'), 'bad'],
      ['Net revenue', fmtMoney(data.netRevenueCents || 0, 'USD'), 'ok'],
      ['Active services', s.services_active, 'ok'],
      ['Expired services', s.services_expired, 'warn'],
      ['Provisioning pending', s.provisioning_pending, 'warn'],
      ['Provisioning failed', s.provisioning_failed, 'bad'],
      ['Open tickets', s.tickets_open, s.tickets_open ? 'warn' : ''],
    ];
    $('#statGrid').innerHTML = cards.map((c) =>
      '<div class="stat"><div class="k">' + esc(c[0]) + '</div><div class="v ' + c[2] + '">' + esc(String(c[1] ?? '0')) + '</div></div>'
    ).join('');

    const rows = $('#recentOrderRows');
    rows.innerHTML = '';
    (data.recentOrders || []).forEach((o) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td><strong>' + esc(o.id) + '</strong><br><span class="note">' + esc(fmtWhen(o.created_at)) + '</span></td>' +
        '<td>' + esc(o.customer_email) + '</td>' +
        '<td>' + esc(o.plan_id) + '</td>' +
        '<td>' + esc(money(o.amount_cents, o.currency)) + '</td>' +
        '<td>' + statePill(o.payment_status) + '</td>' +
        '<td>' + esc(o.payment_provider || 'stripe') + '</td>' +
        '<td>' + statePill(o.order_status) + '</td>';
      rows.appendChild(tr);
    });
    if (!(data.recentOrders || []).length) rows.innerHTML = '<tr><td colspan="7" class="note">No orders yet.</td></tr>';

    const audit = $('#recentAuditRows');
    audit.innerHTML = '';
    (data.recentAudit || []).forEach((a) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(a.action) + '</td><td>' + esc(a.target || '') + '</td><td>' + esc(a.detail || '') + '</td><td class="note">' + esc(fmtWhen(a.created_at)) + '</td>';
      audit.appendChild(tr);
    });
    if (!(data.recentAudit || []).length) audit.innerHTML = '<tr><td colspan="4" class="note">No activity yet.</td></tr>';
  } catch (ex) {
    err.textContent = ex.message; err.classList.remove('hidden');
  }
}

async function loadCustomers() {
  const err = $('#customerError'); err.classList.add('hidden');
  try {
    const q = $('#customerSearch').value.trim();
    const data = await api('/admin/api/vpn/customers' + (q ? '?q=' + encodeURIComponent(q) : ''));
    const rows = $('#customerRows');
    rows.innerHTML = '';
    (data.customers || []).forEach((c) => {
      const tr = document.createElement('tr');
      const blocked = !!c.blockedAt;
      tr.innerHTML =
        '<td>' + esc(c.email) + '</td>' +
        '<td class="note">' + esc(fmtWhen(c.createdAt)) + '</td>' +
        '<td>' + esc(String(c.orderCount)) + '</td>' +
        '<td>' + esc(String(c.paidCount)) + '</td>' +
        '<td>' + (blocked ? '<span class="pill bad">blocked</span>' : '<span class="pill ok">active</span>') + (blocked && c.blockedReason ? '<br><span class="note">' + esc(c.blockedReason) + '</span>' : '') + '</td>' +
        '<td><button class="ghost" data-customer="' + esc(c.id) + '" data-blocked="' + (blocked ? '0' : '1') + '">' + (blocked ? 'Unblock' : 'Block') + '</button></td>';
      rows.appendChild(tr);
    });
    if (!(data.customers || []).length) rows.innerHTML = '<tr><td colspan="6" class="note">No customers yet.</td></tr>';

    rows.querySelectorAll('button[data-customer]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.customer;
        const blocking = btn.dataset.blocked === '1';
        let reason = null;
        if (blocking) {
          reason = window.prompt('Reason for blocking this customer (required):');
          if (!reason) return;
        } else if (!window.confirm('Unblock this customer?')) return;
        try {
          await api('/admin/api/vpn/customers/' + encodeURIComponent(id) + '/block', {
            method: 'POST',
            headers: { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
            body: JSON.stringify({ blocked: blocking, reason }),
          });
          await loadCustomers();
        } catch (ex) { alert(ex.message); }
      });
    });
  } catch (ex) {
    err.textContent = ex.message; err.classList.remove('hidden');
  }
}

$('#customerSearchBtn').addEventListener('click', () => loadCustomers());
$('#customerSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadCustomers(); });

async function loadCoupons() {
  const err = $('#couponError'); err.classList.add('hidden');
  try {
    const data = await api('/admin/api/vpn/coupons');
    const rows = $('#couponRows');
    rows.innerHTML = '';
    (data.coupons || []).forEach((c) => {
      const tr = document.createElement('tr');
      const discount = c.discount_type === 'percent'
        ? c.discount_value + '%'
        : money(c.discount_value, 'USD') + ' off';
      const windowText = (c.starts_at ? fmtWhen(c.starts_at).slice(0, 10) : '—') + ' → ' + (c.expires_at ? fmtWhen(c.expires_at).slice(0, 10) : '—');
      tr.innerHTML =
        '<td><strong>' + esc(c.code) + '</strong>' + (c.description ? '<br><span class="note">' + esc(c.description) + '</span>' : '') + '</td>' +
        '<td>' + esc(discount) + '</td>' +
        '<td>' + esc(c.applies_plan_id || 'Any plan') + '</td>' +
        '<td>' + (c.first_purchase_only ? 'Yes' : 'No') + '</td>' +
        '<td class="note">' + esc(windowText) + '</td>' +
        '<td>' + esc(String(c.redemptions)) + (c.max_redemptions ? ' / ' + esc(String(c.max_redemptions)) : '') + '</td>' +
        '<td>' + (c.active ? '<span class="pill ok">active</span>' : '<span class="pill bad">inactive</span>') + '</td>' +
        '<td><button class="ghost" data-coupon="' + esc(c.id) + '" data-active="' + (c.active ? '0' : '1') + '">' + (c.active ? 'Deactivate' : 'Activate') + '</button></td>';
      rows.appendChild(tr);
    });
    if (!(data.coupons || []).length) rows.innerHTML = '<tr><td colspan="8" class="note">No coupons yet.</td></tr>';

    rows.querySelectorAll('button[data-coupon]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api('/admin/api/vpn/coupons/' + encodeURIComponent(btn.dataset.coupon) + '/toggle', {
            method: 'POST',
            headers: { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
            body: JSON.stringify({ active: btn.dataset.active === '1' }),
          });
          await loadCoupons();
        } catch (ex) { alert(ex.message); }
      });
    });
  } catch (ex) {
    err.textContent = ex.message; err.classList.remove('hidden');
  }
}

$('#couponForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    code: f.code.value,
    discountType: f.discountType.value,
    discountValue: Number(f.discountValue.value),
    appliesPlanId: f.appliesPlanId.value || null,
    firstPurchaseOnly: f.firstPurchaseOnly.checked,
    perCustomerLimit: Number(f.perCustomerLimit.value) || 1,
    maxRedemptions: f.maxRedemptions.value ? Number(f.maxRedemptions.value) : null,
    startsAt: f.startsAt.value || null,
    expiresAt: f.expiresAt.value || null,
  };
  try {
    await api('/admin/api/vpn/coupons', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    f.reset();
    await loadCoupons();
  } catch (ex) { alert(ex.message); }
});

async function loadTickets() {
  const err = $('#ticketError'); err.classList.add('hidden');
  try {
    const status = $('#ticketStatus').value;
    const data = await api('/admin/api/vpn/tickets' + (status ? '?status=' + encodeURIComponent(status) : ''));
    const rows = $('#ticketRows');
    rows.innerHTML = '';
    (data.tickets || []).forEach((t) => {
      const tr = document.createElement('tr');
      tr.className = 'rowlink';
      tr.dataset.ticket = t.id;
      tr.innerHTML =
        '<td><strong>' + esc(t.id) + '</strong></td>' +
        '<td>' + esc(t.customer_email) + '</td>' +
        '<td>' + esc(t.subject) + '</td>' +
        '<td>' + statePill(t.status) + '</td>' +
        '<td class="note">' + esc(fmtWhen(t.updated_at)) + '</td>';
      rows.appendChild(tr);
    });
    if (!(data.tickets || []).length) rows.innerHTML = '<tr><td colspan="5" class="note">No tickets.</td></tr>';

    rows.querySelectorAll('tr[data-ticket]').forEach((tr) => {
      tr.addEventListener('click', () => openTicket(tr.dataset.ticket));
    });
  } catch (ex) {
    err.textContent = ex.message; err.classList.remove('hidden');
  }
}

$('#ticketStatus').addEventListener('change', () => loadTickets());

async function openTicket(id) {
  const wrap = $('#detail');
  wrap.classList.remove('hidden');
  try {
    const data = await api('/admin/api/vpn/tickets/' + encodeURIComponent(id));
    const t = data.ticket;
    const panel = document.createElement('div');
    panel.className = 'panel';
    let html = '<div class="row"><h2 style="flex:1">' + esc(t.subject) + '</h2><button class="ghost" data-close="1">Close</button></div>';
    html += '<dl><dt>Ticket</dt><dd>' + esc(t.id) + '</dd><dt>Customer</dt><dd>' + esc(t.customer_email) + '</dd><dt>Status</dt><dd>' + esc(t.status) + ' (priority ' + esc(t.priority) + ')</dd><dt>Created</dt><dd>' + esc(fmtWhen(t.created_at)) + '</dd></dl>';
    html += '<h2>Conversation</h2><div id="ticketMessages"></div>';
    html += '<h2 style="margin-top:14px">Reply</h2><textarea id="ticketReply" rows="4" placeholder="Write a reply to the customer"></textarea><div class="actions"><button id="sendReply">Send reply</button><button class="ghost" id="closeTicket">Mark closed</button></div>';
    panel.innerHTML = html;
    wrap.innerHTML = '';
    wrap.appendChild(panel);
    const msgs = panel.querySelector('#ticketMessages');
    (data.messages || []).forEach((m) => {
      const b = document.createElement('div');
      b.className = 'copybox';
      b.style.marginBottom = '8px';
      b.textContent = '[' + m.author + '] ' + fmtWhen(m.created_at) + '\\n' + m.body;
      msgs.appendChild(b);
    });
    panel.querySelector('[data-close]').addEventListener('click', () => wrap.classList.add('hidden'));
    panel.querySelector('#sendReply').addEventListener('click', async () => {
      const text = panel.querySelector('#ticketReply').value.trim();
      if (!text) return alert('Write a reply first.');
      try {
        await api('/admin/api/vpn/tickets/' + encodeURIComponent(id) + '/reply', {
          method: 'POST',
          headers: { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: text }),
        });
        await openTicket(id);
        await loadTickets();
      } catch (ex) { alert(ex.message); }
    });
    panel.querySelector('#closeTicket').addEventListener('click', async () => {
      try {
        await api('/admin/api/vpn/tickets/' + encodeURIComponent(id) + '/status', {
          method: 'POST',
          headers: { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'closed' }),
        });
        await openTicket(id);
        await loadTickets();
      } catch (ex) { alert(ex.message); }
    });
  } catch (ex) {
    wrap.innerHTML = '<div class="panel"><div class="error">' + esc(ex.message) + '</div><button class="ghost" data-close="1">Close</button></div>';
    wrap.querySelector('[data-close]').addEventListener('click', () => wrap.classList.add('hidden'));
  }
}

async function loadAudit() {
  const err = $('#auditError'); err.classList.add('hidden');
  try {
    const data = await api('/admin/api/vpn/audit');
    const rows = $('#auditRows');
    rows.innerHTML = '';
    (data.entries || []).forEach((a) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td class="note">' + esc(fmtWhen(a.created_at)) + '</td><td>' + esc(a.action) + '</td><td>' + esc(a.target || '') + '</td><td>' + esc(a.detail || '') + '</td><td class="note">' + esc(a.ip || '') + '</td>';
      rows.appendChild(tr);
    });
    if (!(data.entries || []).length) rows.innerHTML = '<tr><td colspan="5" class="note">Audit log is empty.</td></tr>';
  } catch (ex) {
    err.textContent = ex.message; err.classList.remove('hidden');
  }
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#detail').classList.add('hidden'); });
window.addEventListener('DOMContentLoaded', init);
</script>
</body>
</html>`;
}
