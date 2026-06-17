# Hub Financiero de Javi

A single, offline-first personal-finance PWA that unifies two earlier apps —
**PagoClaro** (debt, credit cards, due dates, payment planning) and
**Javi's Finance** (income, expenses, budgets, subscriptions, purchase
decisions, reports) — into one coherent product with PagoClaro's "Cozy Paper"
visual identity.

Built with **only** HTML, CSS, and vanilla JavaScript. Todo data lives in
`localStorage`. No backend, no accounts, no trackers, no external dependencies.

## Features

- **Panel** — combined personal-finance + debt/credit overview, alerts,
  progress bars, payment-safety status, quick add expense.
- **Transacciones** — income/expense/payment records with cash, debit, or credit
  card payment methods; search, filter, sort; CSV import/export.
- **Tarjetas de credito & Debts** — card balances, auto-calculated available credit,
  a per-card movement **ledger**, and a multi-scenario **balance projection
  chart** (SVG) using estimated CAT and average monthly spend. The average
  monthly spend per card is **auto-calculated** from the trailing 30.4-day
  purchase history (toggle off to enter it manually).
- **Planificador de pagos** — allocates available money across cards/debts by urgency.
- **Simulador de escenarios** — test conservative / balanced / aggressive /
  savings-first / custom strategies.
- **Suscripciones**, **Presupuestos**, **Decision de compra**, **Reportes**.
- **Configuracion** — currency, income, cadence (monthly / biweekly), thresholds,
  theme (light / dark / system), categories.
- **Backup** — full JSON export/import, CSV exports, and migration importers for
  the original PagoClaro and Javi's Finance backups.

## Tarjeta de credito engine

- A credit-card purchase increases `currentBalance` and decreases
  `availableCredit`, and writes a `purchase` movement to the card ledger.
- A payment decreases `currentBalance` and releases `availableCredit`, writing a
  `payment` movement.
- `availableCredit = creditLimit − currentBalance` is always recalculated;
  balance never goes below zero and available credit never exceeds the limit.
- Projection: `monthlyRate = (1 + CAT/100)^(1/12) − 1`, then
  `nextBalance = balance + avgSpend + interest − payment` per month.
- `avgSpend` defaults to the sum of the card's `purchase` movements over the
  last **30.4 days** (one average month). With auto-averaging on, this live
  figure drives the projections; turning it off uses the manual entry instead.

## Run locally

It's a static site — serve the folder with any static server, e.g.:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000> and "Add to Inicio Screen" to install as a PWA.

## Files

```
index.html          app shell + all sections
styles.css          Cozy Paper theme (light / dark / system)
app.js              unified data model, engine, and rendering
manifest.json       PWA manifest
service-worker.js   offline static-asset caching
icon-*.png/.svg     app icons
```

