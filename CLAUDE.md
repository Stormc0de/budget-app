# Budget — project context

Personal budget PWA. Plain HTML, CSS and JavaScript — no frameworks, no build
step, no backend. All data lives in localStorage on the device. It must keep
working offline.

## Working with me

- I'm not a coder. Explain changes in plain language — what it does and why it
  matters, not a walkthrough of the code.
- Consult me before making changes. Propose first, build after I agree.

## Look and feel

iOS-native: rounded cards, bottom tab bar, system fonts, light and dark mode,
safe-area padding for the notch and home indicator.

## Money rules

- **Avalanche**: target the highest APR first. Ties go to the lowest balance.
- **FUNDED and PAID are separate states.** Funding claims money already sitting
  in the Bills account; paying is what moves it out. A card balance drops only
  on PAID.
- **Never auto-calculate interest from APR** for actual balances. I enter the
  real figure from my statement. APR is for projections only.
- **Weekly pay, on Thursdays.** Use 4.33 paychecks per month, never 4.
- **Bills are funded the Thursday before their due date** — precisely, the last
  Thursday strictly before it is due, so a bill due *on* a Thursday is funded a
  full week earlier. Funding on Thursday covers everything due the next day
  through the following Thursday.

## Every change

- Bump the cache version in `sw.js`, or installed phones keep running the old code.
- Keep backup and restore working, including any new fields.
