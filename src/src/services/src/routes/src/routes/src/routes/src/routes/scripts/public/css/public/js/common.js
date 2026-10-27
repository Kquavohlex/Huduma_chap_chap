/* Shared helpers for every page: API wrapper, formatting, toasts, page guards. */

const API = {
  async request(path, options = {}) {
    const opts = { credentials: 'same-origin', headers: {}, ...options };
    if (opts.body && typeof opts.body !== 'string') {
      opts.body = JSON.stringify(opts.body);
      opts.headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(path, opts);
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong. Please try again.');
      err.status = res.status; err.code = data.code;
      throw err;
    }
    return data;
  },
  get: (p) => API.request(p),
  post: (p, body) => API.request(p, { method: 'POST', body }),
  patch: (p, body) => API.request(p, { method: 'PATCH', body })
};

function KSh(cents) {
  const value = (cents || 0) / 100;
  return 'KSh ' + value.toLocaleString('en-KE', { minimumFractionDigits: value % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function when(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) + ' · ' +
         d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
}

const STATUS_LABEL = {
  pending: 'Pending', in_review: 'In review', action_needed: 'Action needed',
  completed: 'Completed', rejected: 'Rejected', cancelled: 'Cancelled',
  unpaid: 'Unpaid', paid: 'Paid', succeeded: 'Confirmed', failed: 'Failed'
};
const stamp = (s) => `<span class="stamp ${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
const emptyState = (msg) => `<div class="empty">${esc(msg)}</div>`;
const icons = () => window.lucide && lucide.createIcons();

function toast(message, type = '') {
  let host = document.getElementById('toasts');
  if (!host) { host = document.createElement('div'); host.id = 'toasts'; document.body.appendChild(host); }
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `<i data-lucide="${type === 'success' ? 'check-circle-2' : type === 'error' ? 'alert-triangle' : 'info'}"></i><span>${esc(message)}</span>`;
  host.appendChild(el);
  icons();
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }, 4200);
}

function showFormError(form, message) {
  const box = form.querySelector('.form-error');
  if (box) { box.textContent = message; box.classList.add('show'); } else toast(message, 'error');
}
function clearFormError(form) {
  const box = form.querySelector('.form-error');
  if (box) { box.classList.remove('show'); box.textContent = ''; }
}

async function whoAmI() { try { return await API.get('/api/auth/me'); } catch (_) { return null; } }

/** Client-side convenience only — real enforcement is server-side. */
async function guardPage(role) {
  const me = await whoAmI();
  if (!me || me.user.role !== role) {
    location.href = '/login.html';
    return null;
  }
  return me;
}

/** Live Nairobi clock in the header. */
function startClock(el) {
  el.innerHTML = '<i data-lucide="clock-3"></i> Nairobi · <b></b>';
  const b = el.querySelector('b');
  icons();
  const tick = () => { b.textContent = new Date().toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); };
  tick();
  setInterval(tick, 1000);
}
