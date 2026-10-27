/* Client dashboard — every money and status decision comes from the server. */
let me = null, services = [], requests = [];
const $ = (s) => document.querySelector(s);

document.addEventListener('DOMContentLoaded', init);

async function init() {
  me = await guardPage('client');
  if (!me) return;

  const first = me.user.fullName.split(' ')[0];
  $('#whoName').textContent = first;
  $('#helloName').textContent = first;
  $('#pfEmail').value = me.user.email;
  $('#pfName').value = me.user.fullName;
  $('#pfPhone').value = me.user.phone;
  startClock($('#clock'));
  icons();

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.goto)));
  $('#logoutBtn').addEventListener('click', async () => { await API.post('/api/auth/logout'); location.href = '/'; });

  $('#svcList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-request]');
    if (b) openRequest(Number(b.dataset.request));
  });
  $('#reqList').addEventListener('click', onReqAction);
  $('#requestForm').addEventListener('submit', submitRequest);
  $('#reqClose').addEventListener('click', () => $('#requestDialog').close());
  $('#topupForm').addEventListener('submit', submitTopup);
  $('#copyCode').addEventListener('click', copyInvite);
  $('#profileForm').addEventListener('submit', saveProfile);
  $('#passwordForm').addEventListener('submit', savePassword);

  await Promise.all([refreshWallet(), loadServices(), loadRequests(), loadTx(), loadReferrals()]);
  const hash = location.hash.slice(1);
  switchTab(['overview','services','requests','wallet','referrals','profile'].includes(hash) ? hash : 'overview');
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.sec').forEach((s) => s.classList.toggle('show', s.id === 'sec-' + name));
  history.replaceState(null, '', '#' + name);
  window.scrollTo({ top: 0 });
  icons();
}

/* ---- Services & new request ---- */
async function loadServices() {
  const data = await API.get('/api/services');
  services = data.services;
  $('#svcList').innerHTML = services.length ? services.map((s, i) => `
    <div class="svc-row">
      <span class="idx">${String(i + 1).padStart(2, '0')}</span>
      <div><h3>${esc(s.name)}</h3><p>${esc(s.description)}</p></div>
      <div class="price"><small>Service fee</small>${KSh(s.priceCents)}</div>
      <button class="btn sm" data-request="${s.id}">Request<i data-lucide="arrow-right"></i></button>
    </div>`).join('') : emptyState('No services are open right now.');
  icons();
}

function openRequest(id) {
  const s = services.find((x) => x.id === id);
  if (!s) return;
  $('#reqServiceName').textContent = s.name;
  $('#reqServicePrice').textContent = KSh(s.priceCents);
  $('#reqDetails').value = '';
  clearFormError($('#requestForm'));
  const dlg = $('#requestDialog');
  dlg.dataset.serviceId = id;
  dlg.showModal();
}

async function submitRequest(e) {
  e.preventDefault(); clearFormError(e.target);
  const dlg = $('#requestDialog');
  try {
    await API.post('/api/requests', { serviceId: Number(dlg.dataset.serviceId), details: $('#reqDetails').value });
    dlg.close();
    toast('Request submitted — track it under “My requests”.', 'success');
    await loadRequests();
    switchTab('requests');
  } catch (err) { showFormError(e.target, err.message); }
}

/* ---- Requests ---- */
function reqRow(r, withActions) {
  const canPay = r.paymentStatus === 'unpaid' && !['cancelled', 'rejected', 'completed'].includes(r.status);
  const canCancel = r.status === 'pending';
  return `<div class="record">
    <div class="record-top">
      <div><span class="record-title">#${r.id} · ${esc(r.serviceName)}</span>
        <div class="record-sub">Submitted ${when(r.createdAt)}</div></div>
      <div class="record-side">${stamp(r.status)} ${stamp(r.paymentStatus)} <b class="amt">${KSh(r.priceCents)}</b></div>
    </div>
    <div class="record-details">${esc(r.details)}</div>
    ${r.adminNotes ? `<div class="record-details"><strong>Team note:</strong> ${esc(r.adminNotes)}</div>` : ''}
    ${withActions && (canPay || canCancel) ? `<div class="record-meta">
      ${canPay ? `<button class="btn sm" data-pay="${r.id}"><i data-lucide="wallet"></i>Pay ${KSh(r.priceCents)} from wallet</button>` : ''}
      ${canCancel ? `<button class="btn sm ghost" data-cancel="${r.id}">Cancel request</button>` : ''}
    </div>` : ''}
  </div>`;
}

async function loadRequests() {
  const data = await API.get('/api/requests');
  requests = data.requests;
  $('#reqList').innerHTML = requests.map((r) => reqRow(r, true)).join('') || emptyState('No requests yet — pick a service to get started.');
  renderOverview();
  icons();
}

function renderOverview() {
  const c = { pending: 0, in_review: 0, completed: 0 };
  requests.forEach((r) => { if (c[r.status] !== undefined) c[r.status]++; });
  $('#ovStats').innerHTML = [
    ['Available balance', KSh(me.balanceCents || 0)],
    ['Pending', c.pending], ['In review', c.in_review], ['Completed', c.completed]
  ].map(([l, v]) => `<div class="stat"><b>${esc(String(v))}</b><span>${l}</span></div>`).join('');
  $('#ovRecent').innerHTML = requests.slice(0, 3).map((r) => reqRow(r, false)).join('') || emptyState('No requests yet — pick a service to get started.');
  icons();
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

async function onReqAction(e) {
  const pay = e.target.closest('[data-pay]');
  const cancel = e.target.closest('[data-cancel]');

  if (pay) {
    const id = Number(pay.dataset.pay);
    const r = requests.find((x) => x.id === id);
    if (!(await askConfirm(`Pay ${KSh(r.priceCents)} for request #${id} from your wallet?`))) return;
    pay.disabled = true;
    try {
      const d = await API.post(`/api/requests/${id}/pay`);
      me.balanceCents = d.balanceCents;
      $('#balance').textContent = KSh(d.balanceCents);
      toast(`Payment recorded — new balance ${KSh(d.balanceCents)}`, 'success');
      await Promise.all([loadRequests(), loadTx(), renderOverview()]);
    } catch (err) { pay.disabled = false; toast(err.message, 'error'); }
  }

  if (cancel) {
    const id = Number(cancel.dataset.cancel);
    if (!(await askConfirm(`Cancel request #${id}? This cannot be undone.`))) return;
    try { await API.post(`/api/requests/${id}/cancel`); toast('Request cancelled.'); loadRequests(); }
    catch (err) { toast(err.message, 'error'); }
  }
}

/* ---- Wallet ---- */
async function refreshWallet() {
  const d = await API.get('/api/wallet');
  me.balanceCents = d.balanceCents;
  $('#balance').textContent = KSh(d.balanceCents);
  renderOverview();
}

const TX_ICON = { topup: 'arrow-down-left', request_payment: 'arrow-up-right', referral_reward: 'gift' };

async function loadTx() {
  const d = await API.get('/api/wallet/transactions');
  $('#txList').innerHTML = d.transactions.map((t) => `<div class="record">
    <div class="record-top">
      <div style="display:flex;gap:12px;align-items:center">
        <span class="tx-ico ${t.direction}"><i data-lucide="${TX_ICON[t.kind] || 'circle'}"></i></span>
        <div><span class="record-title">${esc(t.description)}</span>
          <div class="record-sub">${when(t.createdAt)}${t.reference ? ' · Ref ' + esc(t.reference) : ''}</div></div>
      </div>
      <b class="amount ${t.direction}">${t.direction === 'credit' ? '+' : '−'}${KSh(t.amountCents)}</b>
    </div></div>`).join('') || emptyState('No transactions yet.');
  icons();
}

async function submitTopup(e) {
  e.preventDefault(); clearFormError(e.target);
  try {
    const d = await API.post('/api/payments/stk/initiate', { amount: Number($('#topAmount').value), phone: $('#topPhone').value });
    $('#topupStatus').innerHTML = `<div class="panel"><div class="record">
      <div><span class="pulse"></span><span class="record-title">${esc(d.message)}</span></div>
      <div class="record-sub">Reference ${esc(d.checkoutRequestId)} — this page updates automatically. Nothing is credited until M-Pesa confirms on our servers.</div>
    </div></div>`;
    pollPayment(d.checkoutRequestId);
  } catch (err) { showFormError(e.target, err.message); }
}

function pollPayment(checkoutId) {
  let tries = 0;
  const timer = setInterval(async () => {
    tries++;
    try {
      const d = await API.get(`/api/payments/stk/${encodeURIComponent(checkoutId)}/status`);
      if (d.status === 'succeeded') {
        clearInterval(timer);
        $('#topupStatus').innerHTML = `<div class="notice" style="border-color:var(--green);background:rgba(29,92,65,.06)">
          <i data-lucide="check-circle-2" style="color:var(--green)"></i><div>
          <h4 style="color:var(--green)">Top-up confirmed</h4>
          <p>M-Pesa receipt ${esc(d.mpesaReceipt || '—')}. Your balance above is updated.</p></div></div>`;
        icons();
        toast('Top-up confirmed — wallet credited.', 'success');
        refreshWallet(); loadTx();
      } else if (d.status === 'failed') {
        clearInterval(timer);
        $('#topupStatus').innerHTML = `<div class="notice"><i data-lucide="alert-triangle"></i><div>
          <h4>Top-up not completed</h4><p>${esc(d.message || 'The M-Pesa request was not completed. Nothing was charged — you can try again.')}</p></div></div>`;
        icons();
      } else if (tries > 40) {
        clearInterval(timer);
        $('#topupStatus').innerHTML = `<div class="notice"><i data-lucide="clock-3"></i><div>
          <h4>Still waiting</h4><p>The request is still pending with M-Pesa. If you completed the payment, your wallet will be credited automatically once their confirmation reaches our servers — check your transaction history later.</p></div></div>`;
        icons();
      }
    } catch (_) { /* transient network error — keep polling */ }
  }, 3500);
}

/* ---- Referrals ---- */
async function loadReferrals() {
  const d = await API.get('/api/referrals');
  $('#refCode').textContent = d.referralCode;
  $('#refReward').textContent = KSh(d.rewardCents);
  $('#refEarned').textContent = KSh(d.totalEarnedCents);
  $('#refList').innerHTML = d.invited.map((i) => `<div class="record"><div class="record-top">
    <div><span class="record-title">${esc(i.name)}</span><div class="record-sub">Joined ${when(i.joinedAt)}</div></div>
    ${i.rewarded ? '<span class="stamp completed">Reward paid</span>' : '<span class="stamp unpaid">Awaiting first payment</span>'}
  </div></div>`).join('') || emptyState('No referrals yet — share your invite link to start earning.');
}

async function copyInvite() {
  const link = `${location.origin}/login.html?ref=${$('#refCode').textContent}`;
  try { await navigator.clipboard.writeText(link); toast('Invite link copied.', 'success'); }
  catch (_) { toast('Copy failed — your link: ' + link); }
}

/* ---- Profile ---- */
async function saveProfile(e) {
  e.preventDefault(); clearFormError(e.target);
  try {
    await API.patch('/api/auth/profile', { fullName: $('#pfName').value, phone: $('#pfPhone').value });
    toast('Profile updated.', 'success');
  } catch (err) { showFormError(e.target, err.message); }
}

async function savePassword(e) {
  e.preventDefault(); clearFormError(e.target);
  try {
    await API.patch('/api/auth/password', { currentPassword: $('#pwCurrent').value, newPassword: $('#pwNew').value });
    e.target.reset();
    toast('Password changed.', 'success');
  } catch (err) { showFormError(e.target, err.message); }
}
