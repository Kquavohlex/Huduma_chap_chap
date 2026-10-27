/* Admin console — all enforcement is server-side; this is the control surface. */
let me = null;
const $ = (s) => document.querySelector(s);
const STATUSES = ['pending', 'in_review', 'action_needed', 'completed', 'rejected', 'cancelled'];
const LOADERS = {};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  me = await guardPage('admin');
  if (!me) return;
  $('#whoName').textContent = me.user.fullName;
  startClock($('#clock'));
  icons();

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('#logoutBtn').addEventListener('click', async () => { await API.post('/api/auth/logout'); location.href = '/'; });

  $('#reqFilter').addEventListener('change', () => loadRequests($('#reqFilter').value));
  let searchTimer;
  $('#userSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadUsers($('#userSearch').value), 300);
  });

  $('#serviceCreateForm').addEventListener('submit', createService);
  $('#serviceEditForm').addEventListener('submit', saveService);
  $('#svcClose').addEventListener('click', () => $('#serviceDialog').close());
  $('#reqList').addEventListener('click', onSaveRequest);
  $('#userList').addEventListener('click', onToggleUser);
  $('#svcList').addEventListener('click', onEditService);

  loadOverview();
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.sec').forEach((s) => s.classList.toggle('show', s.id === 'sec-' + name));
  window.scrollTo({ top: 0 });
  icons();
  if (LOADERS[name]) LOADERS[name]();
}

function askConfirm(text) {
  return new Promise((resolve) => {
    const dlg = $('#confirmDialog');
    $('#cfText').textContent = text;
    dlg.showModal();
    $('#cfYes').onclick = () => { dlg.close(); resolve(true); };
    $('#cfNo').onclick = () => { dlg.close(); resolve(false); };
    $('#cfClose').onclick = () => { dlg.close(); resolve(false); };
  });
}

/* ---- Overview ---- */
LOADERS.overview = loadOverview;
async function loadOverview() {
  try {
    const d = await API.get('/api/admin/overview');
    $('#adStats').innerHTML = [
      ['Clients', d.users], ['Pending requests', d.pendingRequests], ['In review', d.activeRequests],
      ['Pending payments', d.pendingPayments], ['Top-ups today', KSh(d.todayTopupsCents)],
      ['Referral rewards paid', KSh(d.referralPaidCents)]
    ].map(([l, v]) => `<div class="stat"><b>${esc(String(v))}</b><span>${l}</span></div>`).join('');
  } catch (err) { toast(err.message, 'error'); }
}

/* ---- Requests ---- */
LOADERS.requests = () => loadRequests($('#reqFilter').value);
async function loadRequests(status) {
  try {
    const d = await API.get('/api/admin/requests' + (status ? `?status=${status}` : ''));
    $('#reqList').innerHTML = d.requests.map((r) => `
      <div class="record">
        <div class="record-top">
          <div><span class="record-title">#${r.id} · ${esc(r.serviceName)} — ${esc(r.userName)}</span>
            <div class="record-sub">${esc(r.userEmail)} · ${esc(r.userPhone)} · ${when(r.createdAt)}</div></div>
          <div class="record-side">${stamp(r.status)} ${stamp(r.paymentStatus)} <b class="amt">${KSh(r.priceCents)}</b></div>
        </div>
        <div class="record-details">${esc(r.details)}</div>
        <div class="admin-controls">
          <select data-status-for="${r.id}">${STATUSES.map((s) =>
            `<option value="${s}" ${s === r.status ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select>
          <input type="text" data-notes-for="${r.id}" placeholder="Note to client (leave blank to keep existing)…" value="${esc(r.adminNotes || '')}">
          <button class="btn sm" data-save="${r.id}"><i data-lucide="save"></i>Save update</button>
        </div>
      </div>`).join('') || emptyState('No requests in this view.');
    icons();
  } catch (err) { toast(err.message, 'error'); }
}

async function onSaveRequest(e) {
  const b = e.target.closest('[data-save]');
  if (!b) return;
  const id = b.dataset.save;
  try {
    await API.patch(`/api/admin/requests/${id}`, {
      status: document.querySelector(`[data-status-for="${id}"]`).value,
      adminNotes: document.querySelector(`[data-notes-for="${id}"]`).value.trim() || null
    });
    toast(`Request #${id} updated.`, 'success');
    loadRequests($('#reqFilter').value);
  } catch (err) { toast(err.message, 'error'); }
}

/* ---- Users ---- */
LOADERS.users = () => loadUsers($('#userSearch').value);
async function loadUsers(q) {
  try {
    const d = await API.get('/api/admin/users' + (q ? `?q=${encodeURIComponent(q)}` : ''));
    $('#userList').innerHTML = d.users.map((u) => `
      <div class="record">
        <div class="record-top">
          <div><span class="record-title">${esc(u.fullName)}</span>
            <div class="record-sub">${esc(u.email)} · ${esc(u.phone)} · joined ${when(u.createdAt)}</div></div>
          <div class="record-side">
            <span class="record-sub">Balance <b class="amt">${KSh(u.balanceCents)}</b> · ${u.requestCount} request(s)</span>
            ${u.role === 'admin' ? '<span class="stamp in_review">Admin</span>' : ''}
            ${u.isActive ? '<span class="stamp completed">Active</span>' : '<span class="stamp rejected">Deactivated</span>'}
          </div>
        </div>
        ${u.role !== 'admin' ? `<div class="record-meta">
          <button class="btn sm ${u.isActive ? 'ghost' : ''}" data-toggle-user="${u.id}" data-active="${u.isActive}">
            <i data-lucide="${u.isActive ? 'user-x' : 'user-check'}"></i>${u.isActive ? 'Deactivate' : 'Reactivate'}</button>
        </div>` : ''}
      </div>`).join('') || emptyState('No matching accounts.');
    icons();
  } catch (err) { toast(err.message, 'error'); }
}

async function onToggleUser(e) {
  const b = e.target.closest('[data-toggle-user]');
  if (!b) return;
  const id = Number(b.dataset.toggleUser);
  const isActive = b.dataset.active === 'true';
  if (!(await askConfirm(`Really ${isActive ? 'deactivate' : 'reactivate'} this account? Deactivated users cannot sign in.`))) return;
  try {
    await API.patch(`/api/admin/users/${id}`, { isActive: !isActive });
    toast('Account updated.', 'success');
    loadUsers($('#userSearch').value);
  } catch (err) { toast(err.message, 'error'); }
}

/* ---- Services ---- */
LOADERS.services = loadServices;
async function loadServices() {
  try {
    const d = await API.get('/api/admin/services');
    $('#svcList').innerHTML = d.services.map((s) => `
      <div class="record">
        <div class="record-top">
          <div><span class="record-title">${esc(s.name)}</span>
            <div class="record-sub">${esc(s.slug)}</div></div>
          <div class="record-side"><b class="amt">${KSh(s.priceCents)}</b>
            ${s.isActive ? '<span class="stamp completed">Active</span>' : '<span class="stamp pending">Inactive</span>'}
            <button class="btn sm ghost" data-edit="${s.id}"><i data-lucide="pencil"></i>Edit</button></div>
        </div>
        <div class="record-details">${esc(s.description)}</div>
      </div>`).join('');
    icons();
  } catch (err) { toast(err.message, 'error'); }
}

async function createService(e) {
  e.preventDefault(); clearFormError(e.target);
  try {
    await API.post('/api/admin/services', {
      name: $('#svcName').value, priceKes: Number($('#svcPrice').value), description: $('#svcDesc').value
    });
    e.target.reset();
    toast('Service added.', 'success');
    loadServices();
  } catch (err) { showFormError(e.target, err.message); }
}

function onEditService(e) {
  const b = e.target.closest('[data-edit]');
  if (!b) return;
  // Fetch fresh values from the rendered data via the API.
  API.get('/api/admin/services').then((d) => {
    const s = d.services.find((x) => x.id === Number(b.dataset.edit));
    if (!s) return;
    $('#esvcId').value = s.id;
    $('#esvcName').value = s.name;
    $('#esvcPrice').value = s.priceCents / 100;
    $('#esvcDesc').value = s.description;
    $('#esvcActive').checked = s.isActive;
    clearFormError($('#serviceEditForm'));
    $('#serviceDialog').showModal();
  });
}

async function saveService(e) {
  e.preventDefault(); clearFormError(e.target);
  try {
    await API.patch(`/api/admin/services/${$('#esvcId').value}`, {
      name: $('#esvcName').value, priceKes: Number($('#esvcPrice').value),
      description: $('#esvcDesc').value, isActive: $('#esvcActive').checked
    });
    $('#serviceDialog').close();
    toast('Service saved.', 'success');
    loadServices();
  } catch (err) { showFormError(e.target, err.message); }
}

/* ---- Payments & ledger ---- */
LOADERS.payments = async () => { await Promise.all([loadPayments(), loadLedger()]); };
async function loadPayments() {
  try {
    const d = await API.get('/api/admin/payments');
    $('#payList').innerHTML = d.payments.map((p) => `
      <div class="record">
        <div class="record-top">
          <div><span class="record-title">#${p.id} · ${esc(p.userName)}</span>
            <div class="record-sub">${esc(p.userEmail)} · ${esc(p.phone)} · ${when(p.createdAt)}</div></div>
          <div class="record-side">${stamp(p.status)}<b class="amt">${KSh(p.amountCents)}</b></div>
        </div>
        ${p.mpesaReceipt ? `<div class="record-meta">M-Pesa receipt: <b>${esc(p.mpesaReceipt)}</b>${p.message ? ' · ' + esc(p.message) : ''}</div>` :
          (p.message ? `<div class="record-meta">${esc(p.message)}</div>` : '')}
      </div>`).join('') || emptyState('No payment records yet.');
    icons();
  } catch (err) { toast(err.message, 'error'); }
}

const TX_ICON = { topup: 'arrow-down-left', request_payment: 'arrow-up-right', referral_reward: 'gift' };
async function loadLedger() {
  try {
    const d = await API.get('/api/admin/transactions');
    $('#txList').innerHTML = d.transactions.map((t) => `
      <div class="record"><div class="record-top">
        <div style="display:flex;gap:12px;align-items:center">
          <span class="tx-ico ${t.direction}"><i data-lucide="${TX_ICON[t.kind] || 'circle'}"></i></span>
          <div><span class="record-title">${esc(t.description)}</span>
            <div class="record-sub">${esc(t.userName)} · ${when(t.createdAt)}${t.reference ? ' · Ref ' + esc(t.reference) : ''}</div></div>
        </div>
        <b class="amount ${t.direction}">${t.direction === 'credit' ? '+' : '−'}${KSh(t.amountCents)}</b>
      </div></div>`).join('') || emptyState('No ledger entries yet.');
    icons();
  } catch (err) { toast(err.message, 'error'); }
}

/* ---- Referrals ---- */
LOADERS.referrals = loadReferrals;
async function loadReferrals() {
  try {
    const d = await API.get('/api/admin/referrals');
    $('#refList').innerHTML = d.rewards.map((r) => `
      <div class="record"><div class="record-top">
        <div><span class="record-title">${esc(r.referrerName)} → ${esc(r.refereeName)}</span>
          <div class="record-sub">${esc(r.referrerEmail)} → ${esc(r.refereeEmail)} · ${when(r.rewardedAt)}</div></div>
        <b class="amt amount credit">+${KSh(r.rewardCents)}</b>
      </div></div>`).join('') || emptyState('No referral rewards paid yet.');
    icons();
  } catch (err) { toast(err.message, 'error'); }
}
