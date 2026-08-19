/* ===========================================================
   Budget — all app logic.
   Data lives in localStorage, so it stays on this phone only.

   THE ONE IDEA THAT MAKES THE MATH WORK
   -------------------------------------
   Funding a bill does not move money in or out of the Bills account.
   It only claims money that is already sitting there. Paying is what
   actually takes money out. So:

     Total balance  = real money in the account
     Committed      = the sum of every envelope (funded but not spent)
     Free cushion   = balance - committed  (money not spoken for)

   Transfer in -> balance up,   cushion up
   Fund a bill -> committed up, cushion down
   Pay a bill  -> balance down AND committed down, cushion unchanged
   =========================================================== */

/* ---------- 1. Storage ------------------------------------ */

const CARDS_KEY       = 'budget.cards.v1';
const BILLS_KEY       = 'budget.bills.v1';
const ACCOUNT_KEY     = 'budget.account.v1';
const SETTINGS_KEY    = 'budget.settings.v1';
const LAST_EXPORT_KEY = 'budget.lastExport.v1';

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || [];
  } catch (e) {
    return [];
  }
}

// Same idea, but for the two things that are objects rather than lists.
function loadObject(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.assign({}, fallback, value);
    }
  } catch (e) { /* fall through */ }
  return Object.assign({}, fallback);
}

function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

const DEFAULT_SETTINGS = {
  weeklyTransfer: 484,      // the Thursday transfer amount
  lastPaycheckWeek: null,   // which week you last ticked "Got paid"
  lastTransferWeek: null,   // which week you last ticked the transfer
  lastTransferAmount: 0     // what that transfer was, so undo is exact
};

let cards    = load(CARDS_KEY);
let bills    = load(BILLS_KEY);
let account  = loadObject(ACCOUNT_KEY, { balance: 0, history: [] });
let settings = loadObject(SETTINGS_KEY, DEFAULT_SETTINGS);

/* ---------- 2. Small utilities ---------------------------- */

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Money maths in JS can produce 100.30000000000001, so every stored
// amount goes through this.
const round2 = n => Math.round(n * 100) / 100;

// Local date as "2026-08-17". Built by hand rather than with
// toISOString(), which converts to UTC and can land on the wrong day.
function ymd(date) {
  return date.getFullYear() + '-' +
         String(date.getMonth() + 1).padStart(2, '0') + '-' +
         String(date.getDate()).padStart(2, '0');
}

// "2026-08". When the month changes this string changes, which is how
// funded/paid checkmarks clear themselves without any timer.
function currentMonth(date = new Date()) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
}

// Your week runs Thursday to Wednesday, so the ritual has a whole week
// to be done in. This returns the date of the current week's Thursday,
// which is the key the checkmarks are stamped with.
const RITUAL_DAY = 4;                        // 0=Sunday … 4=Thursday

function currentWeek(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const back = (d.getDay() - RITUAL_DAY + 7) % 7;   // days since Thursday
  d.setDate(d.getDate() - back);
  return ymd(d);
}

function daysInMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

// A bill's stored due day turned into a real day for the month shown.
// 'last' -> 28/29/30/31, and a 31 in April becomes 30.
function resolveDueDay(bill, date = new Date()) {
  const lastDay = daysInMonth(date);
  if (bill.day === 'last') return lastDay;
  return Math.min(bill.day, lastDay);
}

// The next calendar date this bill is due, or null when it has no
// fixed date (those bills never go overdue).
function nextDueDate(bill, from = new Date()) {
  if (bill.day === 'any') return null;
  const today = new Date(from);
  today.setHours(0, 0, 0, 0);

  const thisMonth = new Date(today.getFullYear(), today.getMonth(), resolveDueDay(bill, today));
  if (thisMonth >= today) return thisMonth;

  const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  return new Date(nextMonth.getFullYear(), nextMonth.getMonth(), resolveDueDay(bill, nextMonth));
}

const DAY_MS = 86400000;

function daysUntilDue(bill) {
  const due = nextDueDate(bill);
  if (!due) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((due - today) / DAY_MS);
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmt = n => money.format(n);

const shortDate = iso => new Date(iso).toLocaleDateString(undefined,
  { month: 'short', day: 'numeric', year: 'numeric' });

function toNumber(text) {
  const n = parseFloat(String(text).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function ordinal(n) {
  if (n % 100 >= 11 && n % 100 <= 13) return n + 'th';
  return n + (['th', 'st', 'nd', 'rd'][n % 10] || 'th');
}

function esc(text) {
  return String(text).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const $ = id => document.getElementById(id);

/* ---------- 3. Bill state helpers ------------------------- */

/* Every bill belongs to one of these. Credit card and loan payments
   behave exactly like ordinary bills — same funding, same checking
   off — they are just listed under their own heading. */
const CATEGORIES = [
  { key: 'bill', label: 'Bills' },
  { key: 'debt', label: 'Cards & loans' }
];

// Anything without a category (bills saved before this existed) is a bill.
const billCategory = bill => (bill.category === 'debt' ? 'debt' : 'bill');

// Soonest due first; bills with no fixed date go last.
function sortByDue(list) {
  return [...list].sort((a, b) => {
    const da = daysUntilDue(a), db = daysUntilDue(b);
    if (da === null && db === null) return 0;
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  });
}

/* Builds a list split into its categories, given a function that draws
   one row. The headings only appear when there is more than one group
   to tell apart, so a single-category list stays uncluttered. */
function groupedHtml(rowHtml) {
  const groups = CATEGORIES
    .map(cat => ({ cat, items: sortByDue(bills.filter(b => billCategory(b) === cat.key)) }))
    .filter(group => group.items.length);

  const headings = groups.length > 1;
  return groups.map(group =>
    (headings ? `<h3 class="group-title">${group.cat.label}</h3>` : '') +
    group.items.map(rowHtml).join('')
  ).join('');
}

// Both checkmarks are stamped with a month, so they clear on the 1st.
const isFunded = bill => bill.fundedMonth === currentMonth();
const isPaid   = bill => bill.paidMonth   === currentMonth();

// Past its due date this month and still not paid. Bills with no fixed
// date can never be overdue — that's the whole point of that setting.
function isOverdue(bill) {
  if (bill.day === 'any' || isPaid(bill)) return false;
  return new Date().getDate() > resolveDueDay(bill);
}

function dueLabel(bill) {
  if (bill.day === 'any') return 'No fixed date';
  const actual = resolveDueDay(bill);
  if (bill.day === 'last') return `Last day (${ordinal(actual)})`;
  if (bill.day > actual)   return `${ordinal(bill.day)} (${ordinal(actual)} this month)`;
  return `Due the ${ordinal(actual)}`;
}

// Everything funded but not yet spent, across all bills.
function committedTotal() {
  return round2(bills.reduce((sum, b) => sum + Math.max(0, b.balance), 0));
}

function freeCushion() {
  return round2(account.balance - committedTotal());
}

/* ---------- 4. Moving money ------------------------------- */

// One line in the Bills account history.
function accountEntry(delta, reason) {
  account.balance = round2(account.balance + delta);
  account.history.push({
    id: newId(),
    at: new Date().toISOString(),
    delta: round2(delta),
    balanceAfter: account.balance,
    reason
  });
  save(ACCOUNT_KEY, account);
}

// One line in a single bill's envelope history.
function billEntry(bill, delta, note) {
  if (!bill.history) bill.history = [];
  bill.history.push({
    id: newId(),
    at: new Date().toISOString(),
    delta: round2(delta),
    balanceAfter: bill.balance,
    reason: note
  });
}

function fundBill(id) {
  const bill = bills.find(b => b.id === id);
  if (!bill) return;

  if (bill.amount <= 0) {
    alert('Give this bill a planned amount first, then you can fund it.');
    return;
  }

  bill.balance     = round2(bill.balance + bill.amount);
  bill.fundedMonth = currentMonth();
  bill.fundedAmount = bill.amount;          // remembered so undo is exact
  billEntry(bill, bill.amount, 'Funded');

  save(BILLS_KEY, bills);
  renderAll();
}

function unfundBill(id) {
  const bill = bills.find(b => b.id === id);
  if (!bill) return;

  const amount = bill.fundedAmount || bill.amount;
  bill.balance = round2(Math.max(0, bill.balance - amount));
  bill.fundedMonth  = null;
  bill.fundedAmount = 0;
  billEntry(bill, -amount, 'Funding undone');

  save(BILLS_KEY, bills);
  renderAll();
}

/* Paying takes the money out of the account for real. It comes out of
   this bill's envelope first; anything the envelope can't cover comes
   out of the free cushion, which is what makes the cushion drop when
   you pay something you never funded. */
function payBill(id, actual, note) {
  const bill = bills.find(b => b.id === id);
  if (!bill) return;

  const fromEnvelope = Math.min(Math.max(0, bill.balance), actual);

  bill.balance = round2(bill.balance - fromEnvelope);
  bill.paidMonth       = currentMonth();
  bill.paidAmount      = actual;
  bill.paidFromEnvelope = fromEnvelope;

  billEntry(bill, -fromEnvelope, note || `Paid ${fmt(actual)}`);
  accountEntry(-actual, `Paid ${bill.name}`);

  save(BILLS_KEY, bills);
  renderAll();
}

function unpayBill(id) {
  const bill = bills.find(b => b.id === id);
  if (!bill) return;

  const amount = bill.paidAmount || 0;
  const back   = bill.paidFromEnvelope || 0;

  bill.balance = round2(bill.balance + back);
  billEntry(bill, back, 'Payment undone');
  accountEntry(amount, `Payment undone: ${bill.name}`);

  bill.paidMonth        = null;
  bill.paidAmount       = 0;
  bill.paidFromEnvelope = 0;

  save(BILLS_KEY, bills);
  renderAll();
}

/* ---------- 5. The weekly ritual -------------------------- */

const gotPaidThisWeek    = () => settings.lastPaycheckWeek === currentWeek();
const transferredThisWeek = () => settings.lastTransferWeek === currentWeek();

function togglePaycheck() {
  settings.lastPaycheckWeek = gotPaidThisWeek() ? null : currentWeek();
  save(SETTINGS_KEY, settings);
  renderWeek();
}

function toggleTransfer() {
  if (transferredThisWeek()) {
    // undo: take back exactly what was put in
    const amount = settings.lastTransferAmount || settings.weeklyTransfer;
    accountEntry(-amount, 'Weekly transfer undone');
    settings.lastTransferWeek = null;
    settings.lastTransferAmount = 0;
  } else {
    const amount = settings.weeklyTransfer;
    accountEntry(amount, 'Weekly transfer in');
    settings.lastTransferWeek = currentWeek();
    settings.lastTransferAmount = amount;
  }
  save(SETTINGS_KEY, settings);
  renderAll();
}

/* The banner at the top of the Week screen. Worst news wins. */
function weekStatus() {
  const cushion = freeCushion();

  // bills with a real due date landing in the next 7 days, still unpaid
  const soon = bills.filter(b => {
    if (isPaid(b)) return false;
    const days = daysUntilDue(b);
    return days !== null && days <= 7;
  });

  const shortfall = round2(soon
    .filter(b => !isFunded(b))
    .reduce((sum, b) => sum + b.amount, 0));

  if (cushion < 0) {
    return {
      level: 'bad',
      title: `Over-committed by ${fmt(Math.abs(cushion))}`,
      detail: 'You have promised more to envelopes than the account holds. ' +
              'Move money in, or unfund something.'
    };
  }

  if (shortfall > cushion) {
    return {
      level: 'warn',
      title: `Short ${fmt(round2(shortfall - cushion))} for this week`,
      detail: `${fmt(shortfall)} of bills fall due in the next 7 days and ` +
              `your cushion is ${fmt(cushion)}.`
    };
  }

  const overdue = bills.filter(isOverdue);
  if (overdue.length) {
    return {
      level: 'warn',
      title: `${overdue.length} bill${overdue.length > 1 ? 's' : ''} overdue`,
      detail: overdue.map(b => b.name).join(', ') + ' — the due date has passed.'
    };
  }

  if (!transferredThisWeek()) {
    return {
      level: 'todo',
      title: 'Ritual not done yet',
      detail: `Cushion is ${fmt(cushion)}. Tick off your paycheck and transfer below.`
    };
  }

  return {
    level: 'good',
    title: "You're good for the week",
    detail: `${fmt(cushion)} free after everything you have committed.`
  };
}

/* ---------- 6. Rendering: the Week screen ----------------- */

function renderWeek() {
  const weekStart = new Date(currentWeek() + 'T12:00:00');
  $('week-sub').textContent = 'Week of ' + weekStart.toLocaleDateString(undefined,
    { weekday: 'short', month: 'short', day: 'numeric' });

  // banner
  const status = weekStatus();
  const banner = $('week-banner');
  banner.className = 'banner ' + status.level;
  $('banner-title').textContent = status.title;
  $('banner-detail').textContent = status.detail;

  // the three account numbers
  const cushion = freeCushion();
  $('acct-balance').textContent   = fmt(account.balance);
  $('acct-committed').textContent = fmt(committedTotal());
  $('acct-cushion').textContent   = fmt(cushion);
  $('acct-cushion').className     = 'stat-value' + (cushion < 0 ? ' negative' : '');

  // ritual rows
  const paidTick = document.querySelector('[data-ritual="paycheck"]');
  const xferTick = document.querySelector('[data-ritual="transfer"]');
  paidTick.classList.toggle('on', gotPaidThisWeek());
  xferTick.classList.toggle('on', transferredThisWeek());

  $('paycheck-sub').textContent = gotPaidThisWeek() ? 'Marked for this week' : 'Not marked yet';
  $('transfer-sub').textContent = transferredThisWeek()
    ? 'Moved in this week — tap the amount to change it'
    : 'Tap the circle once the money has moved';
  $('transfer-amount').textContent = fmt(settings.weeklyTransfer);

  // fund & pay list, grouped by category, soonest due first
  $('week-bills').innerHTML = groupedHtml(b => {
    const funded = isFunded(b), paid = isPaid(b);
    const banked = b.balance > 0 ? ` · ${fmt(b.balance)} banked` : '';
    const overdue = isOverdue(b);

    return `
      <div class="row bill-row ${paid ? 'paid' : ''}">
        <div class="row-main">
          <div class="row-title">${esc(b.name)}</div>
          <div class="row-sub ${overdue ? 'overdue' : ''}">
            ${overdue ? 'Overdue · ' : ''}${dueLabel(b)} · ${fmt(b.amount)}${b.variable ? ' planned' : ''}${banked}
          </div>
        </div>
        <div class="chips">
          <button class="chip ${funded ? 'on-fund' : ''}" data-fund="${b.id}">
            ${funded ? 'Funded' : 'Fund'}
          </button>
          <button class="chip ${paid ? 'on-paid' : ''}" data-pay="${b.id}">
            ${paid ? 'Paid' : 'Pay'}
          </button>
        </div>
      </div>`;
  });

  $('week-empty').hidden = bills.length > 0;
}

/* ---------- 7. Rendering: Bills list and one bill --------- */

function renderBills() {
  $('bills-list').innerHTML = groupedHtml(b => `
      <button class="row" data-open-bill="${b.id}">
        <div class="row-main">
          <div class="row-title">${esc(b.name)}</div>
          <div class="row-sub">
            ${dueLabel(b)}${b.envelope ? ' · envelope' : ''}${b.variable ? ' · varies' : ''}
          </div>
        </div>
        <div class="row-right">
          <div class="row-amount">${fmt(b.amount)}</div>
          ${b.balance > 0 ? `<div class="banked">${fmt(b.balance)} banked</div>` : ''}
        </div>
        <div class="chevron">›</div>
      </button>`);

  $('bills-empty').hidden = bills.length > 0;

  const monthlyTotal = round2(bills.reduce((sum, b) => sum + b.amount, 0));
  const banked = round2(bills.reduce((sum, b) => sum + Math.max(0, b.balance), 0));
  $('bills-summary').textContent = bills.length
    ? `${fmt(monthlyTotal)} planned each month · ${fmt(banked)} banked`
    : '';
}

let openBillId = null;

function openBill(id) {
  openBillId = id;
  renderBillDetail();
  showScreen('bill');
}

function renderBillDetail() {
  const bill = bills.find(b => b.id === openBillId);
  if (!bill) return showScreen('bills');

  $('bill-title').textContent = bill.name;
  $('bill-sub').textContent =
    `${dueLabel(bill)} · ${fmt(bill.amount)}${bill.variable ? ' planned' : ''}`;
  $('bill-banked').textContent = fmt(bill.balance);

  const entries = [...(bill.history || [])].reverse();
  $('bill-history').innerHTML = entries.map(h => `
    <div class="row">
      <div class="row-main">
        <div class="row-title">${esc(h.reason)}</div>
        <div class="row-sub">${shortDate(h.at)} · envelope ${fmt(h.balanceAfter)}</div>
      </div>
      <div class="hist-amount ${h.delta >= 0 ? 'down' : 'up'}">
        ${h.delta >= 0 ? '+' : '−'}${fmt(Math.abs(h.delta))}
      </div>
    </div>`).join('');

  $('bill-history-empty').hidden = entries.length > 0;
}

/* ---------- 8. Rendering: Bills account ------------------- */

function renderAccount() {
  const cushion = freeCushion();
  $('account-balance-big').textContent   = fmt(account.balance);
  $('account-committed-big').textContent = fmt(committedTotal());
  $('account-cushion-big').textContent   = fmt(cushion);
  $('account-cushion-big').className     = 'stat-value' + (cushion < 0 ? ' negative' : '');
  $('account-sub').textContent = cushion < 0
    ? 'Committed money exceeds the balance'
    : `${fmt(cushion)} not spoken for`;

  const entries = [...account.history].reverse();
  $('account-history').innerHTML = entries.map(h => `
    <div class="row">
      <div class="row-main">
        <div class="row-title">${esc(h.reason)}</div>
        <div class="row-sub">${shortDate(h.at)} · balance ${fmt(h.balanceAfter)}</div>
      </div>
      <div class="hist-amount ${h.delta >= 0 ? 'down' : 'up'}">
        ${h.delta >= 0 ? '+' : '−'}${fmt(Math.abs(h.delta))}
      </div>
    </div>`).join('');

  $('account-history-empty').hidden = entries.length > 0;
}

/* ---------- 9. Rendering: Debts --------------------------- */
/* The code says "cards" throughout because that's what the saved data
   and backup files call them. Only the on-screen wording is "Debts". */

function renderCards() {
  $('cards-list').innerHTML = cards.map(c => `
    <button class="row" data-open-card="${c.id}">
      <div class="row-main">
        <div class="row-title">${esc(c.name)}</div>
        <div class="row-sub">${c.apr.toFixed(2)}% APR · Min ${fmt(c.min)}</div>
      </div>
      <div class="row-amount">${fmt(c.balance)}</div>
      <div class="chevron">›</div>
    </button>`).join('');

  $('cards-empty').hidden = cards.length > 0;

  const totalBalance = cards.reduce((sum, c) => sum + c.balance, 0);
  const totalMin     = cards.reduce((sum, c) => sum + c.min, 0);
  $('cards-summary').textContent = cards.length
    ? `${fmt(totalBalance)} total · ${fmt(totalMin)} minimum`
    : '';
}

let openCardId = null;

function openCard(id) {
  openCardId = id;
  renderCardDetail();
  showScreen('card');
}

function renderCardDetail() {
  const c = cards.find(x => x.id === openCardId);
  if (!c) return showScreen('cards');

  $('card-title').textContent = c.name;
  $('card-sub').textContent = `${c.apr.toFixed(2)}% APR · Min ${fmt(c.min)}`;
  $('card-balance-big').textContent = fmt(c.balance);

  const entries = [...(c.history || [])].reverse();
  $('history-list').innerHTML = entries.map(h => `
    <div class="row">
      <div class="row-main">
        <div class="row-title">${esc(h.reason)}</div>
        <div class="row-sub">${shortDate(h.at)} · balance ${fmt(h.balanceAfter)}</div>
      </div>
      <div class="hist-amount ${h.delta >= 0 ? 'up' : 'down'}">
        ${h.delta >= 0 ? '+' : '−'}${fmt(Math.abs(h.delta))}
      </div>
    </div>`).join('');

  $('history-empty').hidden = entries.length > 0;
}

function renderAll() {
  renderWeek();
  renderBills();
  renderCards();
  renderAccount();
  if (openBillId) renderBillDetail();
  if (openCardId) renderCardDetail();
  renderBackupInfo();
}

/* ---------- 10. Moving between screens -------------------- */

function showScreen(name) {
  // detail screens keep their parent tab lit
  const parent = { card: 'cards', bill: 'bills', account: 'week' };
  const litTab = parent[name] || name;

  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === litTab);
  });
  document.querySelectorAll('.screen').forEach(s => {
    s.hidden = s.id !== 'screen-' + name;
  });

  window.scrollTo(0, 0);
  updateScrollEdge();
  if (name === 'week')    renderWeek();
  if (name === 'bills')   renderBills();
  if (name === 'account') renderAccount();
  if (name === 'backup')  renderBackupInfo();
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => showScreen(tab.dataset.tab));
});

/* ---------- 11. The add / edit sheet ---------------------- */

let editing = { type: 'bill', id: null };

const SHEET_GROUPS = ['card', 'bill', 'pay', 'adjust', 'account', 'transfer'];

function openSheet(type, id) {
  editing = { type, id };
  const isNew = !id;

  const titles = {
    card:     (isNew ? 'New Debt' : 'Edit Debt'),
    bill:     (isNew ? 'New Bill' : 'Edit Bill'),
    pay:      'Record Payment',
    adjust:   'Adjust Balance',
    account:  'Correct Balance',
    transfer: 'Weekly Transfer'
  };
  $('sheet-title').textContent = titles[type];

  // show just this type's fields and hint, hide all the others
  SHEET_GROUPS.forEach(group => {
    $('fields-' + group).hidden = group !== type;
    const hint = $(group + '-hint');
    if (hint) hint.hidden = group !== type;
  });

  // Delete only makes sense for an existing bill or debt
  $('sheet-delete').hidden = isNew || (type !== 'card' && type !== 'bill');
  $('form-error').hidden = true;

  if (type === 'card') {
    const c = cards.find(x => x.id === id);
    $('card-name').value    = c ? c.name : '';
    $('card-balance').value = c ? c.balance : '';
    $('card-apr').value     = c ? c.apr : '';
    $('card-min').value     = c ? c.min : '';
    $('card-balance-row').hidden = !isNew;

  } else if (type === 'bill') {
    const b = bills.find(x => x.id === id);
    $('bill-name').value     = b ? b.name : '';
    $('bill-amount').value   = b ? b.amount : '';
    $('bill-day').value      = b ? String(b.day) : '1';
    $('bill-variable').checked = b ? !!b.variable : false;
    $('bill-envelope').checked = b ? !!b.envelope : false;
    setBillCategory(b ? billCategory(b) : 'bill');

  } else if (type === 'pay') {
    const b = bills.find(x => x.id === id);
    $('pay-amount').value = b ? b.amount : '';
    $('pay-note').value = '';
    $('pay-hint').textContent = b
      ? `Planned ${fmt(b.amount)}. Enter what it actually came to — anything ` +
        `left over stays banked in this envelope.`
      : '';

  } else if (type === 'adjust') {
    $('adjust-amount').value = '';
    $('adjust-reason').value = '';
    setAdjustMode('charge');

  } else if (type === 'account') {
    $('account-amount').value = '';
    $('account-note').value = '';
    setAccountMode('in');

  } else if (type === 'transfer') {
    $('transfer-input').value = settings.weeklyTransfer;
  }

  $('backdrop').hidden = false;
  $('sheet').hidden = false;
}

function closeSheet() {
  $('sheet').hidden = true;
  $('backdrop').hidden = true;
  if (document.activeElement) document.activeElement.blur();
}

function showError(message) {
  const p = $('form-error');
  p.textContent = message;
  p.hidden = false;
}

// Explains the two switches in plain words as you flip them.
function updateBillHint() {
  const parts = [];
  if (currentCategory === 'debt') {
    parts.push('Card / loan: listed under its own heading, but funded and ' +
               'checked off exactly like any other bill.');
  }
  if ($('bill-envelope').checked) {
    parts.push('Envelope: fund it every month whether or not you spend it. ' +
               'Unspent money keeps adding up.');
  }
  if ($('bill-variable').checked) {
    parts.push('Amount varies: you fund the planned amount, then enter the ' +
               'real figure when the bill arrives.');
  }
  if ($('bill-day').value === 'any') {
    parts.push('No fixed date: this bill will never be shown as overdue.');
  }
  $('bill-hint').textContent = parts.join(' ');
  $('bill-hint').hidden = parts.length === 0;
}

/* Which category the bill sheet is currently set to */
let currentCategory = 'bill';

function setBillCategory(key) {
  currentCategory = key;
  document.querySelectorAll('#bill-category .seg').forEach(b => {
    b.classList.toggle('active', b.dataset.cat === key);
  });
  updateBillHint();
}

/* Debt adjustment modes */
let adjustMode = 'charge';

const ADJUST_MODES = {
  charge:  { label: 'Amount',      placeholder: 'Interest charge',
             hint: 'Adds to the balance — a finance charge, a new purchase, a fee.' },
  payment: { label: 'Amount',      placeholder: 'Payment',
             hint: 'Subtracts from the balance — a payment you made.' },
  set:     { label: 'New balance', placeholder: 'Statement balance',
             hint: 'Replaces the balance with this number. Use it to match your statement exactly — the difference is recorded for you.' }
};

function setAdjustMode(mode) {
  adjustMode = mode;
  const config = ADJUST_MODES[mode];
  document.querySelectorAll('#adjust-mode .seg').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  $('adjust-amount-label').textContent = config.label;
  $('adjust-reason').placeholder = config.placeholder;
  $('adjust-hint').textContent = config.hint;
}

/* Bills-account correction modes */
let accountMode = 'in';

const ACCOUNT_MODES = {
  in:  { label: 'Amount',      placeholder: 'Refund',
         hint: 'Money arriving that was not your weekly transfer.' },
  out: { label: 'Amount',      placeholder: 'Bank fee',
         hint: 'Money that left the account without being a bill payment.' },
  set: { label: 'New balance', placeholder: 'Matched to bank',
         hint: 'Replaces the balance with what your bank actually shows. The difference is recorded for you.' }
};

function setAccountMode(mode) {
  accountMode = mode;
  const config = ACCOUNT_MODES[mode];
  document.querySelectorAll('#account-mode .seg').forEach(b => {
    b.classList.toggle('active', b.dataset.amode === mode);
  });
  $('account-amount-label').textContent = config.label;
  $('account-note').placeholder = config.placeholder;
  $('account-hint').textContent = config.hint;
}

/* ---------- 12. Saving the sheet -------------------------- */

function saveSheet() {
  const type = editing.type;

  if (type === 'card')     return saveCard();
  if (type === 'bill')     return saveBill();
  if (type === 'pay')      return savePayment();
  if (type === 'adjust')   return saveAdjustment();
  if (type === 'account')  return saveAccountCorrection();
  if (type === 'transfer') return saveTransferAmount();
}

function saveCard() {
  const name = $('card-name').value.trim();
  if (!name) return showError('Please enter a name.');

  const data = {
    name,
    balance: toNumber($('card-balance').value),
    apr:     toNumber($('card-apr').value),
    min:     toNumber($('card-min').value)
  };

  const existing = cards.find(c => c.id === editing.id);
  if (existing) {
    delete data.balance;               // balance changes go through Adjust
    Object.assign(existing, data);
  } else {
    cards.push({ id: newId(), ...data, history: [] });
  }

  save(CARDS_KEY, cards);
  closeSheet();
  renderAll();
}

function saveBill() {
  const name = $('bill-name').value.trim();
  if (!name) return showError('Please enter a bill name.');

  const picked = $('bill-day').value;
  const day = (picked === 'last' || picked === 'any')
    ? picked
    : Math.min(31, Math.max(1, Math.round(toNumber(picked)) || 1));

  const data = {
    name,
    amount:   toNumber($('bill-amount').value),
    day,
    category: currentCategory,
    variable: $('bill-variable').checked,
    envelope: $('bill-envelope').checked
  };

  const existing = bills.find(b => b.id === editing.id);
  if (existing) {
    Object.assign(existing, data);
  } else {
    bills.push({
      id: newId(),
      ...data,
      balance: 0,
      fundedMonth: null, fundedAmount: 0,
      paidMonth: null,   paidAmount: 0, paidFromEnvelope: 0,
      history: []
    });
  }

  save(BILLS_KEY, bills);
  closeSheet();
  renderAll();
}

function savePayment() {
  const typed = $('pay-amount').value.trim();
  if (!typed) return showError('Please enter the amount.');

  const actual = toNumber(typed);
  if (actual <= 0) return showError('Please enter an amount greater than zero.');

  const note = $('pay-note').value.trim();
  payBill(editing.id, actual, note || `Paid ${fmt(actual)}`);
  closeSheet();
}

function saveAdjustment() {
  const card = cards.find(c => c.id === editing.id);
  if (!card) return closeSheet();

  const typed = $('adjust-amount').value.trim();
  if (!typed) return showError('Please enter an amount.');

  const value = toNumber(typed);
  if (adjustMode !== 'set' && value <= 0) {
    return showError('Please enter an amount greater than zero.');
  }

  let delta;
  if (adjustMode === 'charge')       delta = value;
  else if (adjustMode === 'payment') delta = -value;
  else                               delta = value - card.balance;

  if (adjustMode === 'set' && delta === 0) {
    return showError('That is already the balance — nothing to record.');
  }

  const defaults = { charge: 'Charge', payment: 'Payment', set: 'Statement correction' };
  const reason = $('adjust-reason').value.trim() || defaults[adjustMode];

  card.balance = round2(card.balance + delta);
  if (!card.history) card.history = [];
  card.history.push({
    id: newId(),
    at: new Date().toISOString(),
    delta: round2(delta),
    balanceAfter: card.balance,
    reason
  });

  save(CARDS_KEY, cards);
  closeSheet();
  renderAll();
}

function saveAccountCorrection() {
  const typed = $('account-amount').value.trim();
  if (!typed) return showError('Please enter an amount.');

  const value = toNumber(typed);
  if (accountMode !== 'set' && value <= 0) {
    return showError('Please enter an amount greater than zero.');
  }

  let delta;
  if (accountMode === 'in')       delta = value;
  else if (accountMode === 'out') delta = -value;
  else                            delta = value - account.balance;

  if (accountMode === 'set' && delta === 0) {
    return showError('That is already the balance — nothing to record.');
  }

  const defaults = { in: 'Money in', out: 'Money out', set: 'Corrected to match bank' };
  accountEntry(delta, $('account-note').value.trim() || defaults[accountMode]);

  closeSheet();
  renderAll();
}

function saveTransferAmount() {
  const amount = toNumber($('transfer-input').value);
  if (amount <= 0) return showError('Please enter an amount greater than zero.');

  settings.weeklyTransfer = round2(amount);
  save(SETTINGS_KEY, settings);
  closeSheet();
  renderWeek();
}

function deleteCurrent() {
  const isCard = editing.type === 'card';
  const bill = isCard ? null : bills.find(b => b.id === editing.id);

  let message = isCard
    ? 'Delete this debt? Its adjustment history is deleted too.'
    : 'Delete this bill? Its envelope history is deleted too.';

  // Deleting a bill that still holds money quietly frees that money up,
  // so say so rather than letting the cushion jump unexplained.
  if (bill && bill.balance > 0) {
    message += `\n\n${fmt(bill.balance)} is banked in it. That money stays in ` +
               'the account and moves back into your free cushion.';
  }

  if (!confirm(message)) return;

  if (isCard) {
    cards = cards.filter(c => c.id !== editing.id);
    save(CARDS_KEY, cards);
  } else {
    bills = bills.filter(b => b.id !== editing.id);
    save(BILLS_KEY, bills);
  }

  closeSheet();

  if (isCard && openCardId === editing.id) { openCardId = null; showScreen('cards'); }
  if (!isCard && openBillId === editing.id) { openBillId = null; showScreen('bills'); }
  renderAll();
}

/* ---------- 13. Backup: export and import ----------------- */

function backupContents() {
  return {
    app: 'budget-app',
    version: 2,
    exportedAt: new Date().toISOString(),
    cards, bills, account, settings
  };
}

function renderBackupInfo() {
  const when = localStorage.getItem(LAST_EXPORT_KEY);
  $('backup-summary').textContent = when
    ? 'Last backup ' + new Date(when).toLocaleDateString(undefined,
        { month: 'short', day: 'numeric', year: 'numeric' })
    : `${bills.length} bills · ${cards.length} debts · never backed up`;
}

async function exportBackup() {
  const text = JSON.stringify(backupContents(), null, 2);
  const filename = 'budget-backup-' + ymd(new Date()) + '.json';
  const file = new File([text], filename, { type: 'application/json' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Budget backup' });
      localStorage.setItem(LAST_EXPORT_KEY, new Date().toISOString());
      renderBackupInfo();
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }

  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  localStorage.setItem(LAST_EXPORT_KEY, new Date().toISOString());
  renderBackupInfo();
}

/* A backup file is plain text and can be edited or truncated, so every
   field is rebuilt here. Anything odd becomes a sensible value rather
   than breaking the app. */

function cleanHistory(list) {
  if (!Array.isArray(list)) return [];
  return list.map(h => {
    const at = h && h.at;
    return {
      id:     h && h.id ? String(h.id) : newId(),
      at:     typeof at === 'string' && !isNaN(Date.parse(at)) ? at : new Date().toISOString(),
      delta:  toNumber(h && h.delta),
      balanceAfter: toNumber(h && h.balanceAfter),
      reason: h && h.reason ? String(h.reason) : 'Adjustment'
    };
  });
}

const monthStamp = value =>
  typeof value === 'string' && /^\d{4}-\d{2}$/.test(value) ? value : null;

const weekStamp = value =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

function cleanCards(list) {
  if (!Array.isArray(list)) return null;
  return list.map(c => ({
    id:      c && c.id ? String(c.id) : newId(),
    name:    c && c.name ? String(c.name) : 'Untitled',
    balance: toNumber(c && c.balance),
    apr:     toNumber(c && c.apr),
    min:     toNumber(c && c.min),
    history: cleanHistory(c && c.history)
  }));
}

/* Also used on every load, which is what quietly upgrades bills saved
   by the older version of the app: they simply have no funded/envelope
   fields, so they get the defaults. */
function cleanBills(list) {
  if (!Array.isArray(list)) return null;
  return list.map(b => {
    const raw = b && b.day;
    const numeric = Math.round(toNumber(raw)) || 1;
    return {
      id:       b && b.id ? String(b.id) : newId(),
      name:     b && b.name ? String(b.name) : 'Untitled',
      amount:   toNumber(b && b.amount),
      day:      (raw === 'last' || raw === 'any') ? raw : Math.min(31, Math.max(1, numeric)),
      category: (b && b.category === 'debt') ? 'debt' : 'bill',
      variable: !!(b && b.variable),
      envelope: !!(b && b.envelope),
      balance:  toNumber(b && b.balance),
      fundedMonth:  monthStamp(b && b.fundedMonth),
      fundedAmount: toNumber(b && b.fundedAmount),
      paidMonth:    monthStamp(b && b.paidMonth),
      paidAmount:   toNumber(b && b.paidAmount),
      paidFromEnvelope: toNumber(b && b.paidFromEnvelope),
      history:  cleanHistory(b && b.history)
    };
  });
}

function cleanAccount(obj) {
  if (!obj || typeof obj !== 'object') return { balance: 0, history: [] };
  return { balance: toNumber(obj.balance), history: cleanHistory(obj.history) };
}

function cleanSettings(obj) {
  if (!obj || typeof obj !== 'object') return Object.assign({}, DEFAULT_SETTINGS);
  const weekly = toNumber(obj.weeklyTransfer);
  return {
    weeklyTransfer: weekly > 0 ? weekly : DEFAULT_SETTINGS.weeklyTransfer,
    lastPaycheckWeek: weekStamp(obj.lastPaycheckWeek),
    lastTransferWeek: weekStamp(obj.lastTransferWeek),
    lastTransferAmount: toNumber(obj.lastTransferAmount)
  };
}

async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    alert("That file isn't a Budget backup — it couldn't be read.");
    return;
  }

  const newCards = cleanCards(data && data.cards);
  const newBills = cleanBills(data && data.bills);

  if (!newCards && !newBills) {
    alert("That file isn't a Budget backup — no bills or debts were found in it.");
    return;
  }

  const newAccount = cleanAccount(data && data.account);

  const ok = confirm(
    `Restore ${(newBills || []).length} bills, ${(newCards || []).length} debts ` +
    `and an account balance of ${fmt(newAccount.balance)}?\n\n` +
    'This replaces everything currently in the app.'
  );
  if (!ok) return;

  cards    = newCards || [];
  bills    = newBills || [];
  account  = newAccount;
  settings = cleanSettings(data && data.settings);

  save(CARDS_KEY, cards);
  save(BILLS_KEY, bills);
  save(ACCOUNT_KEY, account);
  save(SETTINGS_KEY, settings);

  renderAll();
  alert('Restored.');
}

/* ---------- 14. Wiring up the buttons --------------------- */

$('add-card').addEventListener('click', () => openSheet('card', null));
$('add-bill').addEventListener('click', () => openSheet('bill', null));

$('card-back').addEventListener('click', () => showScreen('cards'));
$('bill-back').addEventListener('click', () => showScreen('bills'));
$('account-back').addEventListener('click', () => showScreen('week'));

$('adjust-btn').addEventListener('click', () => openSheet('adjust', openCardId));
$('edit-card-btn').addEventListener('click', () => openSheet('card', openCardId));
$('bill-edit-btn').addEventListener('click', () => openSheet('bill', openBillId));

$('account-open').addEventListener('click', () => { renderAccount(); showScreen('account'); });
$('account-adjust-btn').addEventListener('click', () => openSheet('account', null));
$('edit-transfer').addEventListener('click', () => openSheet('transfer', null));

$('sheet-cancel').addEventListener('click', closeSheet);
$('backdrop').addEventListener('click', closeSheet);
$('sheet-save').addEventListener('click', saveSheet);
$('sheet-delete').addEventListener('click', deleteCurrent);
$('sheet-form').addEventListener('submit', e => { e.preventDefault(); saveSheet(); });

document.querySelectorAll('#adjust-mode .seg').forEach(b => {
  b.addEventListener('click', () => setAdjustMode(b.dataset.mode));
});
document.querySelectorAll('#account-mode .seg').forEach(b => {
  b.addEventListener('click', () => setAccountMode(b.dataset.amode));
});
document.querySelectorAll('#bill-category .seg').forEach(b => {
  b.addEventListener('click', () => setBillCategory(b.dataset.cat));
});

// keep the bill hint in step with the switches
$('bill-variable').addEventListener('change', updateBillHint);
$('bill-envelope').addEventListener('change', updateBillHint);
$('bill-day').addEventListener('change', updateBillHint);

$('export-btn').addEventListener('click', exportBackup);
$('import-btn').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importBackup(file);
});

// One listener for taps on rows that get created later.
document.addEventListener('click', e => {
  const card = e.target.closest('[data-open-card]');
  if (card) return openCard(card.dataset.openCard);

  const bill = e.target.closest('[data-open-bill]');
  if (bill) return openBill(bill.dataset.openBill);

  const fund = e.target.closest('[data-fund]');
  if (fund) {
    const b = bills.find(x => x.id === fund.dataset.fund);
    if (!b) return;
    return isFunded(b) ? unfundBill(b.id) : fundBill(b.id);
  }

  const pay = e.target.closest('[data-pay]');
  if (pay) {
    const b = bills.find(x => x.id === pay.dataset.pay);
    if (!b) return;
    if (isPaid(b)) return unpayBill(b.id);
    // variable bills ask for the real figure; fixed ones just pay the plan
    if (b.variable) return openSheet('pay', b.id);
    if (b.amount <= 0) return alert('Give this bill a planned amount first.');
    return payBill(b.id, b.amount, `Paid ${fmt(b.amount)}`);
  }

  const ritual = e.target.closest('[data-ritual]');
  if (ritual) {
    return ritual.dataset.ritual === 'paycheck' ? togglePaycheck() : toggleTransfer();
  }
});

// Coming back to the app after the month or week rolled over
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) renderAll();
});

/* iOS 26 "scroll edge effect": the header is invisible until content
   slides underneath it, at which point it turns to frosted glass.
   The CSS does the look; this just says when. */
function updateScrollEdge() {
  document.body.classList.toggle('scrolled', window.scrollY > 4);
}
window.addEventListener('scroll', updateScrollEdge, { passive: true });
updateScrollEdge();

/* ---------- 15. Start ------------------------------------- */

// Fill the due-day dropdown: 1st … 31st, last day, then no fixed date.
const daySelect = $('bill-day');
for (let d = 1; d <= 31; d++) {
  daySelect.appendChild(new Option(ordinal(d), String(d)));
}
daySelect.appendChild(new Option('Last day of month', 'last'));
daySelect.appendChild(new Option('No fixed date', 'any'));

// Run saved data through the cleaners so bills from the older version
// pick up the new fields.
bills = cleanBills(bills) || [];
cards = cleanCards(cards) || [];
save(BILLS_KEY, bills);

renderAll();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
