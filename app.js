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
const CHANGELOG_KEY   = 'budget.changelog.v1';
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
  lastTransferAmount: 0,    // what that transfer was, so undo is exact

  // Avalanche: the extra you put on your highest-interest debt each week
  avalancheExtra: 0,
  lastAvalancheWeek: null,
  lastAvalanchePayment: null,   // { cardId, amount } so undo is exact

  // Week sections you have folded shut on the Week screen. Anything
  // past next week starts folded, to keep the glance view short.
  collapsedWeeks: ['week2', 'week3', 'later', 'done'],

  // Plan screen flags any week the projection dips below this
  minReserve: 0,

  // A debt you picked as the focus yourself. null = follow the avalanche rule.
  focusCardId: null
};

let cards    = load(CARDS_KEY);
let bills    = load(BILLS_KEY);
let account  = loadObject(ACCOUNT_KEY, { balance: 0, history: [] });
let settings  = loadObject(SETTINGS_KEY, DEFAULT_SETTINGS);
let changelog = load(CHANGELOG_KEY);

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

/* The Bills tab is a master list, so it reads in fixed calendar order:
   1st, 3rd, 12th … then last-day bills, then undated ones. Unlike the
   Week screen this does not rotate as the month goes on. */
function sortByDayOfMonth(list) {
  const rank = b => b.day === 'any' ? 999 : (b.day === 'last' ? 32 : b.day);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

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
function groupedHtml(rowHtml, sorter = sortByDue) {
  const groups = CATEGORIES
    .map(cat => ({ cat, items: sorter(bills.filter(b => billCategory(b) === cat.key)) }))
    .filter(group => group.items.length);

  const headings = groups.length > 1;
  return groups.map(group =>
    (headings ? `<h3 class="group-title">${group.cat.label}</h3>` : '') +
    group.items.map(rowHtml).join('')
  ).join('');
}

/* ---------- 3b. Sorting the Week screen into weeks -------- */

/* Your weeks run Thursday to Wednesday, same as the ritual, so a bill
   lands in the week you would actually fund it. Order matters here —
   it is the order the sections appear in. */
const BUCKET_ORDER = ['overdue', 'week0', 'week1', 'week2', 'week3',
                      'later', 'undated', 'done'];

function weekBucket(bill, weekStart) {
  if (isPaid(bill))        return 'done';      // dealt with; out of the way
  if (bill.day === 'any')  return 'undated';   // envelopes, no due date
  if (isOverdue(bill))     return 'overdue';   // needs attention first

  const due = nextDueDate(bill);
  if (!due) return 'undated';

  /* You fund a bill on the last Thursday strictly BEFORE it is due, so a
     bill due on a Thursday is funded a full week earlier. Counting the
     weeks with ceil()-1 instead of floor() shifts exactly those
     Thursday-due bills back one week; everything else is unaffected. */
  const index = Math.ceil((due - weekStart) / (7 * DAY_MS)) - 1;
  if (index <= 0) return 'week0';
  if (index === 1) return 'week1';
  if (index === 2) return 'week2';
  if (index === 3) return 'week3';
  return 'later';
}

function bucketLabel(key, weekStart) {
  const day = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const startOf = index => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + index * 7);
    return d;
  };
  const range = index => {
    const a = startOf(index);
    const b = new Date(a);
    b.setDate(b.getDate() + 6);
    return day(a) + ' – ' + day(b);
  };

  /* A section is named for the Thursday you fund it on, and shows the
     due dates that Thursday covers — the day after, through a week later. */
  const covers = index => {
    const from = startOf(index); from.setDate(from.getDate() + 1);
    const to   = startOf(index); to.setDate(to.getDate() + 7);
    return day(from) + ' – ' + day(to);
  };

  if (key === 'overdue') return 'Overdue';
  /* "through" rather than a range: this section also catches anything due
     today or already funded-late, which a start date would exclude. */
  if (key === 'week0') {
    const to = startOf(0); to.setDate(to.getDate() + 7);
    return 'Fund now · due through ' + day(to);
  }
  if (key === 'week1')   return 'Fund ' + day(startOf(1)) + ' · due ' + covers(1);
  if (key === 'week2')   return 'Fund ' + day(startOf(2)) + ' · due ' + covers(2);
  if (key === 'week3')   return 'Fund ' + day(startOf(3)) + ' · due ' + covers(3);
  if (key === 'later')   return 'Later';
  if (key === 'undated') return 'No fixed date';
  return 'Paid this month';
}

const isCollapsed = key => (settings.collapsedWeeks || []).includes(key);

function toggleWeekSection(key) {
  const list = settings.collapsedWeeks || [];
  settings.collapsedWeeks = list.includes(key)
    ? list.filter(k => k !== key)
    : list.concat(key);
  save(SETTINGS_KEY, settings);
  renderWeek();
}

/* Same idea as groupedHtml, but split into weeks and foldable. Each
   heading keeps showing its count and total while folded, so nothing
   disappears without a trace. */
function weekGroupedHtml(rowHtml) {
  const weekStart = new Date(currentWeek() + 'T00:00:00');

  const buckets = {};
  bills.forEach(bill => {
    const key = weekBucket(bill, weekStart);
    (buckets[key] = buckets[key] || []).push(bill);
  });

  return BUCKET_ORDER.map(key => {
    const items = buckets[key];
    if (!items || !items.length) return '';

    const sorted = sortByDue(items);
    const collapsed = isCollapsed(key);
    const unpaid = sorted.filter(b => !isPaid(b));
    const total = round2(unpaid.reduce((sum, b) => sum + b.amount, 0));

    const summary = key === 'done'
      ? sorted.length + ' paid'
      : (unpaid.length ? fmt(total) : 'all paid');

    return `
      <button class="week-head ${collapsed ? 'closed' : ''} ${key === 'overdue' ? 'urgent' : ''}"
              data-week="${key}">
        <span class="week-chev">›</span>
        <span class="week-name">${bucketLabel(key, weekStart)}</span>
        <span class="week-count">${sorted.length}</span>
        <span class="week-sum">${summary}</span>
      </button>` +
      (collapsed ? '' : sorted.map(rowHtml).join(''));
  }).join('');
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

/* How much a bill actually needs this month. Without a target that is
   simply the planned amount; with one it is whatever tops the envelope
   back up, and nothing once it is full. */
function topUpAmount(bill) {
  if (!(bill.target > 0)) return bill.amount;
  const room = Math.max(0, round2(bill.target - Math.max(0, bill.balance)));
  return round2(Math.min(bill.amount, room));
}

function fundBill(id) {
  const bill = bills.find(b => b.id === id);
  if (!bill) return;

  if (bill.amount <= 0) {
    alert('Give this bill a planned amount first, then you can fund it.');
    return;
  }

  /* With a target, only top the envelope back up to it. If it is already
     full, this month's money is not needed and simply stays in your
     cushion — which is the whole point of a standing balance. */
  const amount = topUpAmount(bill);

  bill.balance     = round2(bill.balance + amount);
  bill.fundedMonth = currentMonth();
  bill.fundedAmount = amount;               // remembered so undo is exact
  if (amount > 0) billEntry(bill, amount, 'Funded');

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

  // If this bill is a card or loan payment, the debt drops by the same
  // amount — no second trip to the Debts tab.
  const linked = bill.linkedCardId && cards.find(c => c.id === bill.linkedCardId);
  if (linked) {
    linked.balance = round2(linked.balance - actual);
    if (!linked.history) linked.history = [];
    linked.history.push({
      id: newId(), at: new Date().toISOString(),
      delta: -actual, balanceAfter: linked.balance,
      reason: 'Payment from ' + bill.name
    });
    save(CARDS_KEY, cards);
  }

  save(BILLS_KEY, bills);
  renderAll();
}

function unpayBill(id) {
  const bill = bills.find(b => b.id === id);
  if (!bill) return;

  const amount = bill.paidAmount || 0;
  const back   = bill.paidFromEnvelope || 0;

  // put the debt back exactly as it was
  const linked = bill.linkedCardId && cards.find(c => c.id === bill.linkedCardId);
  if (linked && amount) {
    linked.balance = round2(linked.balance + amount);
    if (!linked.history) linked.history = [];
    linked.history.push({
      id: newId(), at: new Date().toISOString(),
      delta: amount, balanceAfter: linked.balance,
      reason: 'Payment undone: ' + bill.name
    });
    save(CARDS_KEY, cards);
  }

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

/* ---------- 4b. Projecting the next nine paychecks --------

   Everything here is arithmetic on top of ONE real number: the Bills
   account balance you maintain yourself. Nothing is inferred from past
   activity, so correcting your balance re-bases the whole projection. */

const PROJECTION_WEEKS = 9;

// Thursday is payday, so the first Thursday of a month is the paycheck
// that carries that month's undated envelopes.
function firstThursdayOfMonth(year, month) {
  const d = new Date(year, month, 1);
  d.setDate(1 + ((RITUAL_DAY - d.getDay() + 7) % 7));
  return d;
}

/* When does this bill next fall due inside (from, to]? Bills repeat every
   month, so only the one or two months the window touches can contain it. */
function dueDatesInWindow(bill, from, to) {
  if (bill.day === 'any') return [];

  const months = [new Date(from.getFullYear(), from.getMonth(), 1)];
  if (to.getMonth() !== from.getMonth() || to.getFullYear() !== from.getFullYear()) {
    months.push(new Date(to.getFullYear(), to.getMonth(), 1));
  }

  return months
    .map(m => new Date(m.getFullYear(), m.getMonth(), resolveDueDay(bill, m)))
    .filter(d => d > from && d <= to);
}

/* Which bills a given payday funds: everything due between the day after
   it and the following Thursday, plus the month's envelopes if this is
   the first Thursday of the month. */
function billsFundedOn(payday, isCurrentCycle) {
  const windowEnd = new Date(payday);
  windowEnd.setDate(windowEnd.getDate() + 7);

  const first = firstThursdayOfMonth(payday.getFullYear(), payday.getMonth());
  const carriesEnvelopes = payday.getTime() === first.getTime();

  return bills.filter(bill => {
    // Money for an already-paid bill has physically left the account, so
    // in the cycle you are standing in it must not be counted again.
    if (isCurrentCycle && isPaid(bill)) return false;

    if (bill.day === 'any') return carriesEnvelopes;

    /* In the cycle you are standing in, also sweep up anything still
       unpaid that was due earlier or is due today. Its funding Thursday
       has passed, but the money has not actually left yet — leaving it
       out would make every week after this one read too rich. */
    if (isCurrentCycle) {
      const dueThisMonth = new Date(payday.getFullYear(), payday.getMonth(),
                                    resolveDueDay(bill, payday));
      if (dueThisMonth <= windowEnd) return true;
    }

    return dueDatesInWindow(bill, payday, windowEnd).length > 0;
  });
}

function projectPaychecks(count = PROJECTION_WEEKS) {
  const firstPayday = new Date(currentWeek() + 'T00:00:00');

  let balance = account.balance;

  /* Each envelope is carried forward week by week, because a topped-up
     envelope needs nothing next month — and that is the difference
     between a cushion that keeps shrinking and one that settles. */
  const envelope = {};
  bills.forEach(b => { envelope[b.id] = Math.max(0, b.balance); });

  const sumEnvelopes = () =>
    round2(Object.keys(envelope).reduce((s, k) => s + Math.max(0, envelope[k]), 0));

  const weeks = [];

  for (let i = 0; i < count; i++) {
    const payday = new Date(firstPayday);
    payday.setDate(payday.getDate() + i * 7);
    const current = i === 0;

    const transfer = (current && transferredThisWeek()) ? 0 : settings.weeklyTransfer;
    const extra = (current && avalancheDoneThisWeek())
      ? 0
      : (avalancheTarget() ? settings.avalancheExtra : 0);

    const openingBalance = balance;
    const openingCushion = round2(balance - sumEnvelopes());

    balance = round2(balance + transfer - extra);

    let datedTotal = 0;      // money that actually leaves the account
    let undatedTotal = 0;    // money that only moves into an envelope
    const listed = [];

    billsFundedOn(payday, current).forEach(bill => {
      // in the cycle you are standing in, anything already funded needs nothing
      const alreadyFunded = current && isFunded(bill);

      const room = bill.target > 0
        ? Math.max(0, round2(bill.target - envelope[bill.id]))
        : bill.amount;
      const fundAmount = alreadyFunded ? 0 : round2(Math.min(bill.amount, room));

      envelope[bill.id] = round2(envelope[bill.id] + fundAmount);
      listed.push(bill);

      if (bill.day !== 'any') {
        // a dated bill is funded and paid inside the same cycle
        const fromEnvelope = Math.min(envelope[bill.id], bill.amount);
        envelope[bill.id] = round2(envelope[bill.id] - fromEnvelope);
        balance = round2(balance - bill.amount);
        datedTotal = round2(datedTotal + bill.amount);
      } else {
        undatedTotal = round2(undatedTotal + fundAmount);
      }
    });

    const committed = sumEnvelopes();
    const cushion = round2(balance - committed);

    weeks.push({
      payday, opening: openingBalance, openingCushion,
      transfer, extra, bills: listed,
      datedTotal, undatedTotal,
      billTotal: round2(datedTotal + undatedTotal),
      closing: balance, committed, cushion,
      short: cushion < settings.minReserve,
      shortBy: cushion < settings.minReserve ? round2(settings.minReserve - cushion) : 0
    });
  }

  return {
    weeks,
    totalIn:    round2(weeks.reduce((s, w) => s + w.transfer, 0)),
    totalBills: round2(weeks.reduce((s, w) => s + w.billTotal, 0)),
    totalExtra: round2(weeks.reduce((s, w) => s + w.extra, 0)),
    ending:        weeks.length ? weeks[weeks.length - 1].closing : account.balance,
    endingCushion: weeks.length ? weeks[weeks.length - 1].cushion : freeCushion(),
    firstShort: weeks.find(w => w.short) || null
  };
}

/* ---------- 4c. The change log ---------------------------- */

function logChange(label, from, to, reason) {
  changelog.push({
    id: newId(),
    at: new Date().toISOString(),
    label, from, to,
    reason: reason || ''
  });
  save(CHANGELOG_KEY, changelog);
}

/* ---------- 5a2. Debt free date (the avalanche cascade) ----

   The point of the avalanche is that nothing shrinks as debts clear: a
   cleared debt's minimum keeps getting paid, it just goes to the next
   target. So the monthly budget stays at (all minimums + your extra)
   for the whole run, and the last debt gets hit with everything.

   Projection only — real balances always come from your statements. */

function debtFreeProjection() {
  const live = cards
    .filter(c => c.balance > 0)
    .map(c => ({ id: c.id, apr: c.apr, min: c.min, balance: c.balance }));

  if (!live.length) return { cleared: true };

  const monthlyExtra = round2(settings.avalancheExtra * PAYCHECKS_PER_MONTH);
  const allMinimums  = round2(live.reduce((sum, c) => sum + c.min, 0));
  const monthlyBudget = round2(allMinimums + monthlyExtra);

  let months = 0;
  let interest = 0;

  while (months < 600) {
    const active = live.filter(c => c.balance > 0);
    if (!active.length) break;

    // interest for the month
    active.forEach(c => {
      const charge = round2(c.balance * (c.apr / 100) / 12);
      c.balance = round2(c.balance + charge);
      interest = round2(interest + charge);
    });

    let budget = monthlyBudget;

    // every debt gets its minimum first
    active.forEach(c => {
      const pay = Math.min(c.min, c.balance, budget);
      c.balance = round2(c.balance - pay);
      budget = round2(budget - pay);
    });

    // whatever is left lands on the target, then the next one, and so on
    let guard = 0;
    while (budget > 0.005 && guard++ < 60) {
      const remaining = live.filter(c => c.balance > 0);
      if (!remaining.length) break;

      const pinned = remaining.find(c => c.id === settings.focusCardId);
      const target = pinned || remaining.reduce((best, c) => {
        if (c.apr > best.apr) return c;
        if (c.apr === best.apr && c.balance < best.balance) return c;
        return best;
      }, remaining[0]);

      const pay = Math.min(target.balance, budget);
      target.balance = round2(target.balance - pay);
      budget = round2(budget - pay);
    }

    months++;
    if (!live.some(c => c.balance > 0)) break;
  }

  if (months >= 600) return { never: true, monthlyBudget };

  const date = new Date();
  date.setMonth(date.getMonth() + months);
  return { months, interest, date, monthlyBudget, cleared: false };
}

/* ---------- 5b. Avalanche extra payment ------------------- */

/* The avalanche method: pay every minimum, then throw all spare money
   at the single highest-interest debt. So the target is simply the debt
   with the highest rate that still has a balance. It changes by itself
   as debts get cleared. */
function avalancheTarget() {
  const withBalance = cards.filter(c => c.balance > 0);
  if (!withBalance.length) return null;

  // A debt you chose yourself wins, for as long as it still has a balance.
  const chosen = withBalance.find(c => c.id === settings.focusCardId);
  if (chosen) return chosen;

  return withBalance.reduce((best, c) => {
    if (c.apr > best.apr) return c;
    // same rate: clear the smaller balance first
    if (c.apr === best.apr && c.balance < best.balance) return c;
    return best;
  }, withBalance[0]);
}

const avalancheDoneThisWeek = () => settings.lastAvalancheWeek === currentWeek();

// Is the current focus one you picked, rather than the avalanche pick?
function focusIsManual() {
  const target = avalancheTarget();
  return !!(target && settings.focusCardId === target.id);
}

// What the avalanche rule would choose if you had not picked anything.
function avalancheRulePick() {
  const withBalance = cards.filter(c => c.balance > 0);
  if (!withBalance.length) return null;
  return withBalance.reduce((best, c) => {
    if (c.apr > best.apr) return c;
    if (c.apr === best.apr && c.balance < best.balance) return c;
    return best;
  }, withBalance[0]);
}

function setFocus(cardId) {
  settings.focusCardId = cardId;
  save(SETTINGS_KEY, settings);
  renderAll();
}

/* ---------- 5c. Payoff estimate ---------------------------
   Projection only. This never writes to a balance — real figures always
   come from your statement. Interest is charged monthly on the running
   balance, and the payment is your minimum plus, for the focus debt,
   your weekly extra converted at 4.33 paychecks a month. */

const PAYCHECKS_PER_MONTH = 4.33;

function payoffEstimate(card, monthlyExtra) {
  if (card.balance <= 0) return { cleared: true };

  const payment = round2(card.min + monthlyExtra);
  if (payment <= 0) return { noPayment: true };

  const monthlyRate = (card.apr / 100) / 12;
  let balance = card.balance;
  let interest = 0;
  let months = 0;

  while (balance > 0 && months < 600) {          // 50 years is "never"
    const charge = round2(balance * monthlyRate);
    // A payment that cannot even cover the interest never clears the debt
    if (payment <= charge) return { never: true, interestPerMonth: charge, payment };
    balance = round2(balance + charge - payment);
    interest = round2(interest + charge);
    months++;
  }

  if (months >= 600) return { never: true, payment };

  const done = new Date();
  done.setMonth(done.getMonth() + months);
  return { months, interest, payment, date: done, cleared: false };
}

/* Ticking this moves real money: the debt balance goes down AND the
   same amount leaves the Bills account. Because the extra was never
   funded into an envelope, it comes straight out of the free cushion —
   which is exactly what spending unclaimed money should do. */
function toggleAvalanche() {
  if (avalancheDoneThisWeek()) {
    const record = settings.lastAvalanchePayment;
    if (record) {
      const card = cards.find(c => c.id === record.cardId);
      if (card) {
        card.balance = round2(card.balance + record.amount);
        if (!card.history) card.history = [];
        card.history.push({
          id: newId(), at: new Date().toISOString(),
          delta: record.amount, balanceAfter: card.balance,
          reason: 'Avalanche payment undone'
        });
        save(CARDS_KEY, cards);
      }
      // and the money comes back into the account
      accountEntry(record.amount, 'Avalanche payment undone');
    }
    settings.lastAvalancheWeek = null;
    settings.lastAvalanchePayment = null;
    save(SETTINGS_KEY, settings);
    return renderAll();
  }

  const target = avalancheTarget();
  if (!target) {
    alert('Add a debt with a balance on the Debts tab first.');
    return;
  }

  const amount = settings.avalancheExtra;
  if (amount <= 0) {
    // no amount set yet — ask for one instead of silently doing nothing
    return openSheet('avalanche', null);
  }

  target.balance = round2(target.balance - amount);
  if (!target.history) target.history = [];
  target.history.push({
    id: newId(), at: new Date().toISOString(),
    delta: -amount, balanceAfter: target.balance,
    reason: 'Avalanche extra payment'
  });
  save(CARDS_KEY, cards);

  // the money actually leaves the account
  accountEntry(-amount, 'Avalanche extra to ' + target.name);

  settings.lastAvalancheWeek = currentWeek();
  settings.lastAvalanchePayment = { cardId: target.id, amount };
  save(SETTINGS_KEY, settings);
  renderAll();
}

/* The banner at the top of the Week screen. Worst news wins. */
function weekStatus() {
  const cushion = freeCushion();

  /* Exactly the bills sitting under "Fund now", so the warning can never
     disagree with the list underneath it. */
  const weekStart = new Date(currentWeek() + 'T00:00:00');
  const soon = bills.filter(b => weekBucket(b, weekStart) === 'week0');

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

  // avalanche row — hidden entirely when there is no debt to target
  const target = avalancheTarget();
  const done = avalancheDoneThisWeek();
  $('row-avalanche').hidden = !target;

  if (target) {
    document.querySelector('[data-ritual="avalanche"]').classList.toggle('on', done);
    $('avalanche-title').textContent = 'Extra to ' + target.name;
    $('avalanche-amount').textContent = fmt(settings.avalancheExtra);
    $('avalanche-sub').textContent = settings.avalancheExtra <= 0
      ? 'Tap to set your weekly extra'
      : (done
          ? 'Paid this week · balance now ' + fmt(target.balance)
          : `Highest rate at ${target.apr.toFixed(2)}% · tap the circle when paid`);
  }

  // fund & pay list, split into weeks by due date
  $('week-bills').innerHTML = weekGroupedHtml(b => {
    const funded = isFunded(b), paid = isPaid(b);
    const banked = b.balance > 0
      ? ` · ${fmt(b.balance)}${b.target > 0 ? ' of ' + fmt(b.target) : ''} banked`
      : '';
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
            ${funded ? '✓&nbsp;Funded' : 'Fund'}
          </button>
          <button class="chip ${paid ? 'on-paid' : ''}" data-pay="${b.id}">
            ${paid ? '✓&nbsp;Paid' : 'Pay'}
          </button>
        </div>
      </div>`;
  });

  $('week-empty').hidden = bills.length > 0;
}

/* ---------- 7. Rendering: Bills list and one bill --------- */

function renderBills() {
  $('bills-list').innerHTML = groupedHtml(b => {
    const paid = isPaid(b), funded = isFunded(b);
    // where this month stands, shown right on the master list
    const state = paid   ? '<span class="tag-paid">✓ Paid</span>'
                : funded ? '<span class="tag-funded">✓ Funded</span>'
                : '';
    return `
      <button class="row ${paid ? 'paid' : ''}" data-open-bill="${b.id}">
        <div class="row-main">
          <div class="row-title">${esc(b.name)}</div>
          <div class="row-sub">
            ${dueLabel(b)}${b.envelope ? ' · envelope' : ''}${b.variable ? ' · varies' : ''}
            ${state}
          </div>
        </div>
        <div class="row-right">
          <div class="row-amount">${fmt(b.amount)}</div>
          ${b.balance > 0
            ? `<div class="banked">${fmt(b.balance)}${b.target > 0 ? ' / ' + fmt(b.target) : ''} banked</div>`
            : ''}
        </div>
        <div class="chevron">›</div>
      </button>`;
  }, sortByDayOfMonth);

  $('bills-empty').hidden = bills.length > 0;

  const monthlyTotal = round2(bills.reduce((sum, b) => sum + b.amount, 0));
  const banked = round2(bills.reduce((sum, b) => sum + Math.max(0, b.balance), 0));
  const unpaidCount = bills.filter(b => !isPaid(b)).length;
  $('bills-summary').textContent = bills.length
    ? `${fmt(monthlyTotal)} a month · ${unpaidCount} of ${bills.length} unpaid · ${fmt(banked)} banked`
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
  const linkedCard = bill.linkedCardId && cards.find(c => c.id === bill.linkedCardId);
  $('bill-sub').textContent =
    `${dueLabel(bill)} · ${fmt(bill.amount)}${bill.variable ? ' planned' : ''}` +
    (linkedCard ? ` · pays down ${linkedCard.name}` : '');
  $('bill-banked').textContent = fmt(bill.balance) +
    (bill.target > 0 ? ' of ' + fmt(bill.target) : '');

  const entries = [...(bill.history || [])].reverse();
  $('bill-history').innerHTML = entries.map(h => `
    <button class="row" data-entry="bill|${bill.id}|${h.id}">
      <div class="row-main">
        <div class="row-title">${esc(h.reason)}</div>
        <div class="row-sub">${shortDate(h.at)} · envelope ${fmt(h.balanceAfter)}</div>
      </div>
      <div class="hist-amount ${h.delta >= 0 ? 'down' : 'up'}">
        ${h.delta >= 0 ? '+' : '−'}${fmt(Math.abs(h.delta))}
      </div>
      <div class="chevron">›</div>
    </button>`).join('');

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
    <button class="row" data-entry="account|account|${h.id}">
      <div class="row-main">
        <div class="row-title">${esc(h.reason)}</div>
        <div class="row-sub">${shortDate(h.at)} · balance ${fmt(h.balanceAfter)}</div>
      </div>
      <div class="hist-amount ${h.delta >= 0 ? 'down' : 'up'}">
        ${h.delta >= 0 ? '+' : '−'}${fmt(Math.abs(h.delta))}
      </div>
      <div class="chevron">›</div>
    </button>`).join('');

  $('account-history-empty').hidden = entries.length > 0;
}

/* ---------- 8b. Rendering: the Plan screen ---------------- */

/* A plain inline SVG line of the free cushion across the nine paychecks.
   No library — just a path, a zero line and your reserve line. The point
   is to see the dip before you read a single figure. */
function renderSparkline(p) {
  const box = $('plan-spark');
  if (!p.weeks.length) { box.innerHTML = ''; return; }

  // start at today's cushion, then one point per payday
  const values = [p.weeks[0].openingCushion].concat(p.weeks.map(w => w.cushion));

  const W = 320, H = 92, padX = 8, padTop = 12, padBot = 12;
  const reserve = settings.minReserve;

  // always keep zero and the reserve line inside the picture
  const lo = Math.min.apply(null, values.concat([0, reserve]));
  const hi = Math.max.apply(null, values.concat([0, reserve]));
  const range = (hi - lo) || 1;

  const X = i => padX + i * (W - padX * 2) / (values.length - 1);
  const Y = v => padTop + (hi - v) * (H - padTop - padBot) / range;

  const line = values
    .map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1))
    .join(' ');
  /* Close the shaded area onto the ZERO line rather than the bottom of
     the box, so a cushion below zero hangs under the line the way you
     would expect, instead of looking like a solid positive block. */
  const baseline = Y(0).toFixed(1);
  const area = line +
    ' L' + X(values.length - 1).toFixed(1) + ' ' + baseline +
    ' L' + X(0).toFixed(1) + ' ' + baseline + ' Z';

  let lowIndex = 0;
  values.forEach((v, i) => { if (v < values[lowIndex]) lowIndex = i; });

  const trouble = !!p.firstShort;
  const day = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  box.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="spark-svg" role="img"
         aria-label="Free cushion across the next nine paychecks">
      <path class="spark-area ${trouble ? 'bad' : ''}" d="${area}"/>
      ${reserve !== 0 ? `<line class="spark-reserve" x1="${padX}" x2="${W - padX}"
            y1="${Y(reserve).toFixed(1)}" y2="${Y(reserve).toFixed(1)}"/>` : ''}
      <line class="spark-zero" x1="${padX}" x2="${W - padX}"
            y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}"/>
      <path class="spark-line ${trouble ? 'bad' : ''}" d="${line}"
            vector-effect="non-scaling-stroke"/>
      <circle class="spark-dot ${values[lowIndex] < reserve ? 'bad' : ''}"
              cx="${X(lowIndex).toFixed(1)}" cy="${Y(values[lowIndex]).toFixed(1)}" r="3.5"/>
    </svg>
    <div class="spark-caption">
      <span>now</span>
      <span class="spark-low">low ${fmt(values[lowIndex])}</span>
      <span>${day(p.weeks[p.weeks.length - 1].payday)}</span>
    </div>`;
}

function renderPlan() {
  const p = projectPaychecks();
  const dayLabel = d => d.toLocaleDateString(undefined,
    { weekday: 'short', month: 'short', day: 'numeric' });

  $('plan-sub').textContent = 'Next ' + PROJECTION_WEEKS + ' paychecks';
  $('plan-start').textContent = fmt(account.balance);
  $('plan-in').textContent    = fmt(p.totalIn);
  $('plan-out').textContent   = fmt(round2(p.totalBills + p.totalExtra));
  $('plan-end').textContent   = fmt(p.endingCushion);
  $('plan-end').className     = 'stat-value' +
    (p.endingCushion < settings.minReserve ? ' negative' : '');
  $('plan-reserve').textContent = fmt(settings.minReserve);

  // headline verdict
  const banner = $('plan-banner');
  if (p.firstShort) {
    banner.className = 'banner bad';
    $('plan-banner-title').textContent =
      'Short ' + fmt(p.firstShort.shortBy) + ' on ' + dayLabel(p.firstShort.payday);
    $('plan-banner-detail').textContent =
      'That cycle needs ' + fmt(p.firstShort.billTotal) + '. The account holds ' +
      fmt(p.firstShort.closing) + ' but ' + fmt(p.firstShort.committed) +
      ' of it is already promised to envelopes, leaving ' + fmt(p.firstShort.cushion) +
      ' free.';
  } else {
    banner.className = 'banner good';
    $('plan-banner-title').textContent = 'All nine paychecks cover their bills';
    $('plan-banner-detail').textContent =
      'Lowest free cushion is ' + fmt(Math.min(...p.weeks.map(w => w.cushion))) +
      '. After nine paychecks the account holds ' + fmt(p.ending) + ', with ' +
      fmt(p.endingCushion) + ' of it free.';
  }

  renderSparkline(p);

  $('plan-weeks').innerHTML = p.weeks.map((w, i) => {
    const names = w.bills.length
      ? w.bills.map(b => esc(b.name) + ' ' + fmt(b.amount)).join(' · ')
      : 'Nothing due this cycle';

    return `
      <div class="plan-week ${w.short ? 'short' : ''}">
        <div class="plan-top">
          <span class="plan-date">${dayLabel(w.payday)}${i === 0 ? ' · now' : ''}</span>
          <span class="plan-close">${fmt(w.closing)}</span>
        </div>
        <div class="plan-flow">
          <span class="in">+${fmt(w.transfer)} in</span>
          <span class="out">−${fmt(w.datedTotal)} paid out</span>
          ${w.undatedTotal > 0 ? `<span class="held">${fmt(w.undatedTotal)} to envelopes</span>` : ''}
          ${w.extra > 0 ? `<span class="out">−${fmt(w.extra)} extra</span>` : ''}
        </div>
        <div class="plan-cushion">
          ${fmt(w.committed)} committed · <strong>${fmt(w.cushion)} free</strong>
        </div>
        <div class="plan-bills">${names}</div>
        ${w.short ? `<div class="plan-warn">Free cushion short ${fmt(w.shortBy)} against your ${fmt(settings.minReserve)} reserve</div>` : ''}
      </div>`;
  }).join('');

  $('plan-empty').hidden = bills.length > 0;
}

function renderLog() {
  const entries = [...changelog].reverse();
  $('log-sub').textContent = entries.length
    ? entries.length + (entries.length === 1 ? ' change' : ' changes')
    : '';

  $('log-list').innerHTML = entries.map(e => `
    <div class="row">
      <div class="row-main">
        <div class="row-title">${esc(e.label)}</div>
        <div class="row-sub">
          ${fmt(e.from)} → ${fmt(e.to)} · ${shortDate(e.at)}
          ${e.reason ? `<div class="log-reason">${esc(e.reason)}</div>` : ''}
        </div>
      </div>
    </div>`).join('');

  $('log-empty').hidden = entries.length > 0;
}

/* ---------- 9. Rendering: Debts --------------------------- */
/* The code says "cards" throughout because that's what the saved data
   and backup files call them. Only the on-screen wording is "Debts". */

function renderCards() {
  renderFreedom();
  const target = avalancheTarget();

  $('cards-list').innerHTML = cards.map(c => `
    <button class="row ${target && target.id === c.id ? 'focus' : ''}" data-open-card="${c.id}">
      <div class="row-main">
        <div class="row-title">
          ${esc(c.name)}
          ${target && target.id === c.id ? '<span class="tag-focus">◎ Focus</span>' : ''}
        </div>
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

  renderFocusControls(c);
  renderPayoff(c);

  const entries = [...(c.history || [])].reverse();
  $('history-list').innerHTML = entries.map(h => `
    <button class="row" data-entry="card|${c.id}|${h.id}">
      <div class="row-main">
        <div class="row-title">${esc(h.reason)}</div>
        <div class="row-sub">${shortDate(h.at)} · balance ${fmt(h.balanceAfter)}</div>
      </div>
      <div class="hist-amount ${h.delta >= 0 ? 'up' : 'down'}">
        ${h.delta >= 0 ? '+' : '−'}${fmt(Math.abs(h.delta))}
      </div>
      <div class="chevron">›</div>
    </button>`).join('');

  $('history-empty').hidden = entries.length > 0;
}

/* The focus button, plus a nudge if your pick is not the cheapest choice. */
function renderFreedom() {
  const box = $('freedom-box');
  const note = $('freedom-note');
  const owed = round2(cards.reduce((sum, c) => sum + Math.max(0, c.balance), 0));
  const result = debtFreeProjection();

  if (result.cleared) {
    box.hidden = true;
    note.hidden = cards.length === 0;
    note.textContent = 'Every debt is cleared. Nothing left to project.';
    return;
  }

  if (result.never) {
    box.hidden = true;
    note.hidden = false;
    note.textContent =
      `At ${fmt(result.monthlyBudget)} a month these never clear — the interest ` +
      'outruns the payments. Raising the minimums or the weekly extra fixes it.';
    return;
  }

  box.hidden = false;
  note.hidden = false;

  const years = Math.floor(result.months / 12);
  const rest = result.months % 12;
  $('freedom-months').textContent = years
    ? years + 'y ' + rest + 'm'
    : result.months + (result.months === 1 ? ' month' : ' months');
  $('freedom-date').textContent = 'around ' +
    result.date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('freedom-owed').textContent = fmt(owed);
  $('freedom-interest').textContent = fmt(result.interest);

  const target = avalancheTarget();
  note.textContent =
    `${fmt(result.monthlyBudget)} a month: every minimum plus ` +
    `${fmt(settings.avalancheExtra)} a week. As each debt clears its payment rolls ` +
    `onto the next` + (target ? `, starting with ${target.name}` : '') + '.';
}

function renderFocusControls(card) {
  const target = avalancheTarget();
  const isTarget = !!(target && target.id === card.id);
  const pinned = settings.focusCardId === card.id;

  $('focus-btn').textContent = pinned ? 'Stop Focusing This' : 'Make This the Focus';

  const rulePick = avalancheRulePick();
  const note = $('focus-note');

  if (pinned && rulePick && rulePick.id !== card.id) {
    note.textContent = `You picked this one. The avalanche rule would target ` +
      `${rulePick.name} at ${rulePick.apr.toFixed(2)}%, which costs less in interest overall.`;
    note.hidden = false;
  } else if (isTarget && !pinned) {
    note.textContent = 'Chosen automatically: highest rate with a balance.';
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

function renderPayoff(card) {
  const box = $('payoff-box');
  const note = $('payoff-note');
  const target = avalancheTarget();
  const isTarget = !!(target && target.id === card.id);

  // the weekly extra only goes to the focus debt
  const monthlyExtra = isTarget
    ? round2(settings.avalancheExtra * PAYCHECKS_PER_MONTH)
    : 0;

  const result = payoffEstimate(card, monthlyExtra);

  if (result.cleared) {
    box.hidden = true;
    note.textContent = 'Cleared. Nothing left to pay off.';
    note.hidden = false;
    return;
  }

  if (result.noPayment) {
    box.hidden = true;
    note.textContent = 'Add a minimum payment to this debt and an estimate appears here.';
    note.hidden = false;
    return;
  }

  if (result.never) {
    box.hidden = true;
    note.textContent = result.interestPerMonth
      ? `At ${fmt(result.payment)} a month this never clears — interest alone is about ` +
        `${fmt(result.interestPerMonth)} a month. Raise the payment above that.`
      : `At ${fmt(result.payment)} a month this takes over 50 years.`;
    note.hidden = false;
    return;
  }

  box.hidden = false;
  const years = Math.floor(result.months / 12);
  const rest = result.months % 12;
  $('payoff-months').textContent = years
    ? years + 'y ' + rest + 'm'
    : result.months + (result.months === 1 ? ' month' : ' months');
  $('payoff-date').textContent = 'around ' +
    result.date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('payoff-payment').textContent = fmt(result.payment);
  $('payoff-interest').textContent = fmt(result.interest);

  // what the weekly extra is actually buying
  if (isTarget && monthlyExtra > 0) {
    const without = payoffEstimate(card, 0);
    const lines = [
      `${fmt(card.min)} minimum plus ${fmt(settings.avalancheExtra)} a week ` +
      `(about ${fmt(monthlyExtra)} a month at 4.33 paychecks).`
    ];
    if (without.months && !without.never) {
      const saved = without.months - result.months;
      lines.push(`Without the extra: ${without.months} months and ` +
                 `${fmt(without.interest)} interest — so the extra saves ` +
                 `${saved} month${saved === 1 ? '' : 's'} and ` +
                 `${fmt(round2(without.interest - result.interest))}.`);
    } else if (without.never) {
      lines.push('Without the extra the minimum alone never clears it.');
    }
    note.textContent = lines.join(' ');
  } else {
    note.textContent = `Based on the ${fmt(card.min)} minimum at ${card.apr.toFixed(2)}%. ` +
      'Make this the focus and your weekly extra is included too.';
  }
  note.hidden = false;
}

function renderAll() {
  renderWeek();
  renderPlan();
  renderLog();
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
  const parent = { card: 'cards', bill: 'bills', account: 'week', log: 'plan' };
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
  if (name === 'plan')    renderPlan();
  if (name === 'log')     renderLog();
  if (name === 'bills')   renderBills();
  if (name === 'account') renderAccount();
  if (name === 'backup')  renderBackupInfo();
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => showScreen(tab.dataset.tab));
});

/* ---------- 11. The add / edit sheet ---------------------- */

let editing = { type: 'bill', id: null };

const SHEET_GROUPS = ['card', 'bill', 'pay', 'adjust', 'account', 'transfer',
                      'avalanche', 'entry', 'reserve'];

function openSheet(type, id) {
  editing = { type, id };
  const isNew = !id;

  const titles = {
    card:     (isNew ? 'New Debt' : 'Edit Debt'),
    bill:     (isNew ? 'New Bill' : 'Edit Bill'),
    pay:      'Record Payment',
    adjust:   'Adjust Balance',
    account:  'Correct Balance',
    transfer: 'Weekly Transfer',
    avalanche: 'Avalanche Extra',
    entry: 'Edit Entry',
    reserve: 'Minimum Reserve'
  };
  $('sheet-title').textContent = titles[type];

  // show just this type's fields and hint, hide all the others
  SHEET_GROUPS.forEach(group => {
    $('fields-' + group).hidden = group !== type;
    const hint = $(group + '-hint');
    if (hint) hint.hidden = group !== type;
  });

  // Delete applies to an existing bill, debt, or history entry
  $('sheet-delete').hidden = isNew ||
    (type !== 'card' && type !== 'bill' && type !== 'entry');
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
    $('bill-target').value = (b && b.target) ? b.target : '';
    // rebuild the debt list each time, in case debts changed
    const linkSelect = $('bill-linked');
    linkSelect.innerHTML = '';
    linkSelect.appendChild(new Option('Not linked', ''));
    cards.forEach(c => linkSelect.appendChild(new Option(c.name, c.id)));
    linkSelect.value = (b && b.linkedCardId) || '';

    $('bill-reason').value = '';
    $('bill-reason-row').hidden = isNew;   // nothing to explain on a new bill
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

  } else if (type === 'entry') {
    const found = findEntry(id);
    if (!found) return;
    $('entry-amount').value = found.entry.delta;
    $('entry-note').value = found.entry.reason;
    const what = found.kind === 'account' ? 'the Bills account balance'
               : found.kind === 'bill'    ? "this envelope's balance"
               : "this debt's balance";
    $('entry-hint').textContent =
      `Changing the amount adjusts ${what} by the difference. A minus sign ` +
      'means money going out. Every figure below this entry is recalculated.';

  } else if (type === 'reserve') {
    $('reserve-input').value = settings.minReserve || '';

  } else if (type === 'avalanche') {
    $('avalanche-input').value = settings.avalancheExtra || '';
    const target = avalancheTarget();
    $('avalanche-hint').textContent = target
      ? `Goes to ${target.name}, your highest rate at ${target.apr.toFixed(2)}%. ` +
        'The target moves on by itself once that debt is cleared. Ticking it off ' +
        'lowers that debt and takes the same amount out of the Bills account.'
      : 'Add a debt with a balance first.';
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
  // the target only makes sense for an envelope
  $('bill-target-row').hidden = !$('bill-envelope').checked;
  if ($('bill-envelope').checked && toNumber($('bill-target').value) > 0) {
    parts.push('Topped up to ' + fmt(toNumber($('bill-target').value)) +
               ' and no further — once it is full, the money stays in your cushion.');
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
  // only card/loan payments can point at a debt
  $('bill-linked-row').hidden = key !== 'debt';
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
  if (type === 'avalanche') return saveAvalancheAmount();
  if (type === 'entry') return saveEntryEdit();
  if (type === 'reserve') return saveReserve();
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
    target: $('bill-envelope').checked ? Math.max(0, toNumber($('bill-target').value)) : 0,
    linkedCardId: currentCategory === 'debt' ? ($('bill-linked').value || null) : null,
    variable: $('bill-variable').checked,
    envelope: $('bill-envelope').checked
  };

  const existing = bills.find(b => b.id === editing.id);
  if (existing) {
    // note the change before overwriting it, so the log keeps both figures
    if (round2(existing.amount) !== round2(data.amount)) {
      logChange(existing.name + ' planned amount',
                round2(existing.amount), round2(data.amount),
                $('bill-reason').value.trim());
    }
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

function saveReserve() {
  const amount = toNumber($('reserve-input').value);
  if (amount < 0) return showError('Please enter zero or more.');

  settings.minReserve = round2(amount);
  save(SETTINGS_KEY, settings);
  closeSheet();
  renderPlan();
}

function saveAvalancheAmount() {
  const amount = toNumber($('avalanche-input').value);
  if (amount <= 0) return showError('Please enter an amount greater than zero.');

  settings.avalancheExtra = round2(amount);
  save(SETTINGS_KEY, settings);
  closeSheet();
  renderWeek();
}

function deleteCurrent() {
  if (editing.type === 'entry') return deleteEntry();

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

/* ---------- 12b. Editing a history entry ------------------
   Every history list — the Bills account, an envelope, a debt — can be
   corrected. A row is referenced as "kind|ownerId|entryId". */

function findEntry(ref) {
  const [kind, ownerId, entryId] = String(ref).split('|');

  let owner;
  if (kind === 'account')   owner = account;
  else if (kind === 'bill') owner = bills.find(b => b.id === ownerId);
  else                      owner = cards.find(c => c.id === ownerId);

  if (!owner || !Array.isArray(owner.history)) return null;
  const entry = owner.history.find(h => h.id === entryId);
  if (!entry) return null;

  return { kind, owner, entry };
}

/* Once an amount changes, every "balance after" printed below it is
   wrong. Rather than guess an opening figure, walk backwards from the
   balance we know is right and refill them. */
function recomputeRunning(history, finalBalance) {
  let running = finalBalance;
  for (let i = history.length - 1; i >= 0; i--) {
    history[i].balanceAfter = round2(running);
    running = round2(running - history[i].delta);
  }
}

function persistOwner(kind) {
  if (kind === 'account') save(ACCOUNT_KEY, account);
  else if (kind === 'bill') save(BILLS_KEY, bills);
  else save(CARDS_KEY, cards);
}

function applyEntryChange(found, difference) {
  found.owner.balance = round2(found.owner.balance + difference);
  recomputeRunning(found.owner.history, found.owner.balance);
  persistOwner(found.kind);
}

function saveEntryEdit() {
  const found = findEntry(editing.id);
  if (!found) return closeSheet();

  const typed = $('entry-amount').value.trim();
  if (!typed) return showError('Please enter an amount.');

  const newDelta = round2(toNumber(typed));
  const difference = round2(newDelta - found.entry.delta);

  found.entry.delta = newDelta;
  found.entry.reason = $('entry-note').value.trim() || found.entry.reason;

  applyEntryChange(found, difference);
  closeSheet();
  renderAll();
}

function deleteEntry() {
  const found = findEntry(editing.id);
  if (!found) return closeSheet();

  const what = found.kind === 'account' ? 'the account balance'
             : found.kind === 'bill'    ? 'this envelope'
             : 'this debt';
  if (!confirm(`Delete this entry? ${fmt(Math.abs(found.entry.delta))} will be ` +
               `taken back out of ${what}.`)) return;

  const index = found.owner.history.indexOf(found.entry);
  found.owner.history.splice(index, 1);

  applyEntryChange(found, -found.entry.delta);
  closeSheet();
  renderAll();
}

/* ---------- 13. Backup: export and import ----------------- */

function backupContents() {
  return {
    app: 'budget-app',
    version: 2,
    exportedAt: new Date().toISOString(),
    cards, bills, account, settings, changelog
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
      linkedCardId: (b && b.linkedCardId) ? String(b.linkedCardId) : null,
      target:   Math.max(0, toNumber(b && b.target)),
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

function cleanChangeLog(list) {
  if (!Array.isArray(list)) return [];
  return list.map(e => {
    const at = e && e.at;
    return {
      id:     e && e.id ? String(e.id) : newId(),
      at:     typeof at === 'string' && !isNaN(Date.parse(at)) ? at : new Date().toISOString(),
      label:  e && e.label ? String(e.label) : 'Change',
      from:   toNumber(e && e.from),
      to:     toNumber(e && e.to),
      reason: e && e.reason ? String(e.reason) : ''
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
    lastTransferAmount: toNumber(obj.lastTransferAmount),
    avalancheExtra: toNumber(obj.avalancheExtra),
    lastAvalancheWeek: weekStamp(obj.lastAvalancheWeek),
    lastAvalanchePayment: (obj.lastAvalanchePayment &&
                           typeof obj.lastAvalanchePayment === 'object')
      ? { cardId: String(obj.lastAvalanchePayment.cardId || ''),
          amount: toNumber(obj.lastAvalanchePayment.amount) }
      : null,
    collapsedWeeks: Array.isArray(obj.collapsedWeeks)
      ? obj.collapsedWeeks.filter(k => BUCKET_ORDER.includes(k))
      : DEFAULT_SETTINGS.collapsedWeeks.slice(),
    minReserve: Math.max(0, toNumber(obj.minReserve)),
    focusCardId: obj.focusCardId ? String(obj.focusCardId) : null
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

  cards     = newCards || [];
  bills     = newBills || [];
  account   = newAccount;
  settings  = cleanSettings(data && data.settings);
  changelog = cleanChangeLog(data && data.changelog);

  save(CARDS_KEY, cards);
  save(BILLS_KEY, bills);
  save(ACCOUNT_KEY, account);
  save(SETTINGS_KEY, settings);
  save(CHANGELOG_KEY, changelog);

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
$('focus-btn').addEventListener('click', () => {
  setFocus(settings.focusCardId === openCardId ? null : openCardId);
});
$('bill-edit-btn').addEventListener('click', () => openSheet('bill', openBillId));

$('account-open').addEventListener('click', () => { renderAccount(); showScreen('account'); });
$('account-adjust-btn').addEventListener('click', () => openSheet('account', null));
$('edit-transfer').addEventListener('click', () => openSheet('transfer', null));
$('edit-avalanche').addEventListener('click', () => openSheet('avalanche', null));
$('edit-reserve').addEventListener('click', () => openSheet('reserve', null));
$('open-log').addEventListener('click', () => showScreen('log'));
$('log-back').addEventListener('click', () => showScreen('plan'));
$('plan-anchor').addEventListener('click', () => { renderAccount(); showScreen('account'); });

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
$('bill-target').addEventListener('input', updateBillHint);
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

  const entryRow = e.target.closest('[data-entry]');
  if (entryRow) return openSheet('entry', entryRow.dataset.entry);

  const week = e.target.closest('[data-week]');
  if (week) return toggleWeekSection(week.dataset.week);

  const ritual = e.target.closest('[data-ritual]');
  if (ritual) {
    const which = ritual.dataset.ritual;
    if (which === 'paycheck')  return togglePaycheck();
    if (which === 'avalanche') return toggleAvalanche();
    return toggleTransfer();
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
