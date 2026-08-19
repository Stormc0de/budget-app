# Budget

A personal budget tracker for iPhone. Plain HTML, CSS and JavaScript — no
frameworks, no build step, no server. Everything is stored in the browser
on the device, so no financial data ever leaves the phone.

## Screens

- **Week** — the Thursday ritual: mark that you got paid, mark the weekly
  transfer into the Bills account, then fund and check off bills.
- **Bills** — manage bills and envelopes, grouped into Bills and Cards & loans.
- **Debts** — credit card and loan balances with an adjustment history.
- **Backup** — save all data to a file, and restore from one.

## How the money adds up

Funding a bill does not move money in or out of the Bills account. It only
claims money already sitting there. Paying is what actually takes money out.

    Total balance = real money in the account
    Committed     = the sum of every envelope (funded but not yet spent)
    Free cushion  = balance - committed

So a transfer in raises the balance and the cushion; funding a bill raises
committed and lowers the cushion; paying lowers the balance and committed
together, leaving the cushion untouched.

Envelopes accumulate: fund Haircut $80 a month, skip two months, and $160
is banked. Variable bills are funded at their planned amount and paid at
the real one, so anything left over stays in that envelope.

## Files

| File | What it does |
|---|---|
| `index.html` | Page structure for every screen |
| `styles.css` | All styling — iOS 26 Liquid Glass, light and dark |
| `app.js` | All logic and storage |
| `sw.js` | Service worker; caches the app so it works offline |
| `manifest.json` | Makes it installable on the home screen |
| `test-data.json` | Sample data — restore it from the Backup tab |

## Working on it

Serve the folder over HTTP and open it:

    python3 -m http.server 8123

Service workers only run over HTTPS or on localhost, so `file://` will not work.

**After changing any file, bump the version in `sw.js`** (`budget-v14` ->
`budget-v15`). That is what tells an installed copy to fetch the new code.

## Notes

- Data is tied to the exact web address. A different address means a fresh,
  empty app — restore from a backup file to move data across.
- On iOS, a home-screen app has its own storage, separate from Safari. Add
  it to the home screen first, then enter data there.
- Back up regularly from the Backup tab and keep the file in iCloud Drive.
  It is the only copy of the data outside the phone.
