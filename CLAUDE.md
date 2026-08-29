# Budget — project context

Personal budget PWA for iPhone. Plain HTML, CSS and JavaScript — no frameworks,
no build step, no backend. All data lives in localStorage on the device, and it
must keep working offline.

## Working with me

- I'm not a coder. Explain changes in plain language — what it does and why it
  matters, not a walkthrough of the code.
- Consult me before making changes. Propose first, build after I agree.
- Flag assumptions and trade-offs rather than quietly picking one.

## Running it

    python3 -m http.server 8123        # then open http://localhost:8123

Service workers need HTTPS or localhost, so `file://` will not work.
Live at <https://stormc0de.github.io/budget-app/>, deployed with GitHub Desktop
(commit, then Push origin). Pages serves `main` from the repo root.

## Testing — learned the hard way

- **Never snapshot and restore localStorage in place.** Restoring storage does
  not refresh the page's in-memory copy, and the next save writes the stale copy
  back over it. This destroyed the test data twice. To reset, re-import
  `test-data.json` through the Backup tab instead.
- **The browser caches `app.js` stubbornly.** Unregistering the service worker
  and clearing caches is often not enough. `127.0.0.1:8123` and `localhost:8123`
  are separate origins with separate caches and storage — switching between them
  is the reliable escape hatch.
- **My phone's data is a third origin** (github.io) and is never affected by
  anything done to the local copies.
- With scripted find-and-replace, use anchors that appear exactly once and
  confirm the file was written — a failure partway through discards the edits
  that already succeeded, which has left declarations missing while their
  usages landed.

## Files

| File | What it does |
|---|---|
| `index.html` | Markup for every screen |
| `styles.css` | iOS 26 Liquid Glass styling, light and dark |
| `app.js` | All logic and storage |
| `sw.js` | Service worker; caches the app for offline use |
| `manifest.json` | Home screen install |
| `test-data.json` | Sample data — restore it from the Backup tab |

Tabs: Week, Plan, Bills, Debts, Backup. Plus screens for the Calendar (header
button, top-left of Week), one bill, one debt, the Bills account, the change log.

## The money model

Funding does not move money — it claims money already sitting in the Bills
account. Paying is what takes it out.

    Total balance = real money in the account
    Committed     = the sum of every envelope (funded, not yet spent)
    Free cushion  = balance − committed

A transfer in raises balance and cushion. Funding raises committed and lowers
cushion. Paying lowers balance and committed together, leaving cushion alone.
**This invariant must hold after every operation** — verify it whenever changing
anything that touches money.

## Rules that must not drift

- **Avalanche**: highest APR first, ties to the lowest balance. I can pin a focus
  debt by hand; if a pinned debt is cleared it falls back to the rule.
- **FUNDED and PAID are separate states.** A card balance drops only on PAID.
- **Both are recorded per cycle, not per checkmark.** Each bill keeps a list of
  the months it has been funded and paid for, so paying September ahead in
  August adds to that list instead of overwriting August. Reading a bare
  checkmark used to hide a bill due the 1st for the last days of the month
  before — the Plan skipped it and the Week screen filed it under "Paid".
- **Never auto-calculate interest from APR for real balances.** I enter the real
  figure from my statement. APR is only ever used for payoff projections.
- **4.33 paychecks a month, never 4.**
- **Two different weeks, deliberately.** The ritual week runs Monday–Sunday so an
  early paycheck (payroll lands Wed–Thu) still ticks the right week. The pay week
  stays Thursday-anchored and drives every funding window.
- **Bills are funded the last Thursday strictly before they are due** — a bill
  due on a Thursday is funded a full week earlier. One payday covers everything
  due the next day through the following Thursday.
- **Non-monthly bills** set aside `amount ÷ cadence` each month and stop once the
  envelope holds the full amount. Money only leaves in a month it is due.
- **Envelope targets** keep a standing balance ready — Haircut sits at $80, and
  once it is full that month's money stays in my cushion instead.
- The avalanche extra leaves the Bills account, and the Plan projection counts it.
- The Plan is anchored on the real account balance I enter. Never infer it from
  past activity; my real balance always wins.

## Every change

- Bump the cache version in `sw.js`, or installed phones keep the old code.
- Keep backup and restore working, including any new fields.
- Re-check the balance / committed / cushion invariant.
