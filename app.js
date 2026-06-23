/* ===========================================================================
   Javi's Finance Hub — app.js
   One offline-first PWA merging PagoClaro (debt / cards / planner) and
   Javi's Finance (transactions / subs / budgets / reports / decisions).

   Vanilla JS. All data lives in localStorage. No backend, no dependencies.

   Sections:
     1. Constants & defaults
     2. State & storage (load / save / migrate)
     3. Generic helpers
     4. Money / date / cadence helpers
     5. General finance calculations
     6. Debt / card calculations
     7. Credit-card engine (movements, purchase, payment)
     8. Transactions engine (commit / reverse side effects)
     9. Planner
    10. Card spend averaging
    11. Purchase decision
    12. Rendering — each section
    13. Modals & forms
    14. Backup / import / export / migration
    15. Navigation, events, init
   =========================================================================== */

"use strict";

/* ---------------------------------------------------------------------------
   1. CONSTANTS & DEFAULTS
   --------------------------------------------------------------------------- */
const STORAGE_KEY = "financeHub.v1";
const APP_VERSION = "1.0.0";
const THEME_PREFERENCES = ["system", "light", "dark"];
const THEME_COLORS = { light: "#efe3cc", dark: "#1a100b" };

const DEFAULT_EXPENSE_CATEGORIES = [
  "Comida", "Gasolina", "Gym", "Suscripciones", "Auto", "Salud",
  "Entretenimiento", "Familia", "Trabajo", "Aprendizaje", "Pagos de deuda", "Otro"
];
const DEFAULT_INCOME_CATEGORIES = ["Salario", "Ingreso extra", "Reembolso", "Otro"];

const PAYMENT_METHODS = ["cash", "debit", "credit_card"];
const TXN_TYPES = ["income", "expense", "savings", "debt_payment", "credit_card_payment", "subscription", "adjustment"];
const PRIORITIES = ["low", "medium", "high", "critical"];

function defaultData() {
  const now = new Date().toISOString();
  return {
    version: APP_VERSION,
    settings: {
      currency: "MXN",
      currencySymbol: "$",
      payFrequency: "biweekly",        // "biweekly" | "monthly"
      monthlyIncome: 28250,
      biweeklyIncome: 14125,
      theme: "system",
      savingsGoalPercent: 10,
      spendingLimitPercent: 80,
      monthlyBudget: 14800,
      dangerDays: 3,
      warningDays: 7,
      defaultProjectionMonths: 12,
      conservativeMode: true,
      expenseCategories: [...DEFAULT_EXPENSE_CATEGORIES],
      incomeCategories: [...DEFAULT_INCOME_CATEGORIES]
    },
    transactions: [],
    cards: [],
    debts: [],
    subscriptions: [],
    budgets: [
      budgetSeed("Gasto mensual", "", 14800, "general", 80),
      budgetSeed("Meta de ahorro", "__savings__", 2825, "savings", 100)
    ],
    purchaseDecisions: [],
    monthlyReports: [],
    cardMovements: [],
    migrations: { importedPagoClaro: false, importedJavisFinance: false },
    metadata: { createdAt: now, updatedAt: now }
  };
}

function budgetSeed(name, category, limit, type, threshold) {
  return {
    id: createId("budget"), name, category, limit, period: "monthly",
    type, alertThreshold: threshold, active: true, notes: "",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
}

/* ---------------------------------------------------------------------------
   2. STATE & STORAGE
   --------------------------------------------------------------------------- */
let appData = loadData();
let viewMonth = monthKey(new Date());        // "YYYY-MM" focus for dashboard / reports
let dashboardAvailableMoney = getDefaultAvailableMoney();
let pendingConfirm = null;
const els = {};

applyThemePreference();

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultData();
    return normalizeData(JSON.parse(raw));
  } catch (err) {
    console.error("No se pudo cargar; iniciando de nuevo.", err);
    return defaultData();
  }
}

function saveData() {
  appData.metadata = appData.metadata || {};
  appData.metadata.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appData));
  showStorageStatus("Guardado localmente");
}

function resetData() {
  appData = defaultData();
  localStorage.removeItem(STORAGE_KEY);
  saveData();
}

// Ensure any loaded/imported object has every expected key with safe defaults.
function normalizeData(data) {
  const base = defaultData();
  const out = Object.assign({}, base, data);
  out.version = APP_VERSION;
  out.settings = Object.assign({}, base.settings, data.settings || {});
  out.settings.theme = THEME_PREFERENCES.includes(out.settings.theme) ? out.settings.theme : "system";
  out.settings.payFrequency = ["monthly", "biweekly"].includes(out.settings.payFrequency) ? out.settings.payFrequency : "biweekly";
  if (!Array.isArray(out.settings.expenseCategories) || !out.settings.expenseCategories.length) out.settings.expenseCategories = [...DEFAULT_EXPENSE_CATEGORIES];
  if (!Array.isArray(out.settings.incomeCategories) || !out.settings.incomeCategories.length) out.settings.incomeCategories = [...DEFAULT_INCOME_CATEGORIES];

  ["transactions", "cards", "debts", "subscriptions", "budgets", "purchaseDecisions", "monthlyReports", "cardMovements"].forEach((k) => {
    if (!Array.isArray(out[k])) out[k] = [];
  });
  out.cards = out.cards.map(normalizeCard);
  out.debts = out.debts.map(normalizeDebt);
  out.migrations = Object.assign({ importedPagoClaro: false, importedJavisFinance: false }, data.migrations || {});
  out.metadata = Object.assign({ createdAt: new Date().toISOString() }, data.metadata || {});
  return out;
}

function normalizeCard(c) {
  const now = new Date().toISOString();
  const card = {
    id: String(c.id || createId("card")),
    bank: String(c.bank || "").trim(),
    name: String(c.name || "").trim(),
    type: "credit_card",
    creditLimit: Math.max(0, cleanNumber(c.creditLimit)),
    currentBalance: Math.max(0, cleanNumber(c.currentBalance)),
    availableCredit: 0,
    minimumPayment: Math.max(0, cleanNumber(c.minimumPayment)),
    noInterestPayment: Math.max(0, cleanNumber(c.noInterestPayment)),
    statementDay: clampInteger(c.statementDay ?? 1, 1, 31),
    dueDay: clampInteger(c.dueDay ?? 20, 1, 31),
    priority: PRIORITIES.includes(c.priority) ? c.priority : "medium",
    catAnnual: Math.max(0, cleanNumber(c.catAnnual)),
    averageMonthlySpend: Math.max(0, cleanNumber(c.averageMonthlySpend)),
    autoAverageSpend: c.autoAverageSpend !== false,
    expectedMonthlyPayment: Math.max(0, cleanNumber(c.expectedMonthlyPayment)),
    notes: String(c.notes || ""),
    isActive: c.isActive !== false,
    createdAt: c.createdAt || now,
    updatedAt: c.updatedAt || now
  };
  recalculateAvailableCredit(card);
  return card;
}

function normalizeDebt(d) {
  const now = new Date().toISOString();
  return {
    id: String(d.id || createId("debt")),
    name: String(d.name || "").trim(),
    institution: String(d.institution || "").trim(),
    type: ["personal_loan", "car_loan", "store_credit", "other"].includes(d.type) ? d.type : "other",
    totalDebt: Math.max(0, cleanNumber(d.totalDebt)),
    minimumPayment: Math.max(0, cleanNumber(d.minimumPayment)),
    noInterestPayment: Math.max(0, cleanNumber(d.noInterestPayment)),
    dueDate: typeof d.dueDate === "string" && d.dueDate ? d.dueDate : "",
    priority: PRIORITIES.includes(d.priority) ? d.priority : "medium",
    frequency: ["monthly", "biweekly"].includes(d.frequency) ? d.frequency : "monthly",
    notes: String(d.notes || ""),
    isActive: d.isActive !== false,
    createdAt: d.createdAt || now,
    updatedAt: d.updatedAt || now
  };
}

/* ---------------------------------------------------------------------------
   3. GENERIC HELPERS
   --------------------------------------------------------------------------- */
function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
function el(id) { return document.getElementById(id); }

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function toast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2300);
}

function showStorageStatus(message, isError = false) {
  if (!els.storageStatus) return;
  els.storageStatus.textContent = message;
  els.storageStatus.style.color = isError ? "var(--danger)" : "";
  clearTimeout(showStorageStatus._t);
  showStorageStatus._t = setTimeout(() => {
    els.storageStatus.textContent = "Guardado localmente";
    els.storageStatus.style.color = "";
  }, 2600);
}

/* ---------------------------------------------------------------------------
   4. MONEY / DATE / CADENCE HELPERS
   --------------------------------------------------------------------------- */
function cleanNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const normalized = String(value ?? "").replace(/,/g, "").replace(/[^\d.-]/g, "");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}
function parseMoneyInput(value) { return Math.max(0, cleanNumber(value)); }
function clampInteger(value, min, max) {
  const parsed = Math.trunc(cleanNumber(value));
  return Math.min(max, Math.max(min, parsed));
}
function clampPct(n) { return Math.max(0, Math.min(100, Number(n || 0))); }

function fmtMoney(n) {
  const sym = appData.settings.currencySymbol || "$";
  return sym + Number(n || 0).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n) { return (Math.round(Number(n || 0) * 10) / 10) + "%"; }

function todayISO() { return new Date().toISOString().slice(0, 10); }
function monthKey(d) { return d.toISOString().slice(0, 7); }
function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("es-MX", { month: "long", year: "numeric" });
}
function inMonth(isoDate, key) { return typeof isoDate === "string" && isoDate.slice(0, 7) === key; }
function formatDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat("es-MX", { month: "short", day: "numeric", year: "numeric" }).format(d);
}
function startOfLocalDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
function createClampedDate(year, monthIndex, day) {
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  return new Date(year, monthIndex, Math.min(day, lastDay));
}
function daysElapsedInMonth(key) {
  const today = new Date();
  if (key === monthKey(today)) return today.getDate();
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

// Cadence (monthly vs biweekly / quincenal) — mirrors PagoClaro behavior.
function isBiweekly() { return appData.settings.payFrequency === "biweekly"; }
function periodsPerMonth() { return isBiweekly() ? 2 : 1; }
function periodNoun() { return isBiweekly() ? "quincena" : "mes"; }
function periodAdjective() { return isBiweekly() ? "Esta quincena" : "Este mes"; }
function toPeriod(monthlyAmount) { return cleanNumber(monthlyAmount) / periodsPerMonth(); }

function getMonthlyIncome() {
  const s = appData.settings;
  if (s.payFrequency === "biweekly") {
    const bi = cleanNumber(s.biweeklyIncome);
    return bi > 0 ? bi * 2 : cleanNumber(s.monthlyIncome);
  }
  return cleanNumber(s.monthlyIncome);
}
function getDefaultAvailableMoney() {
  if (isBiweekly()) {
    const bi = cleanNumber(appData.settings.biweeklyIncome);
    return bi > 0 ? bi : cleanNumber(appData.settings.monthlyIncome) / 2;
  }
  return cleanNumber(appData.settings.monthlyIncome);
}

/* ---------------------------------------------------------------------------
   5. GENERAL FINANCE CALCULATIONS
   --------------------------------------------------------------------------- */
const CONSUMPTION_TYPES = ["expense", "subscription"];
const DEBT_TYPES = ["credit_card_payment", "debt_payment"];

function calculateMonthlySummary(key) {
  const txns = appData.transactions.filter((t) => inMonth(t.date, key));
  const incomes = txns.filter((t) => t.type === "income");
  const consumption = txns.filter((t) => CONSUMPTION_TYPES.includes(t.type));
  const savingsTxns = txns.filter((t) => t.type === "savings");
  const debtPayments = txns.filter((t) => DEBT_TYPES.includes(t.type));

  const txnIncome = incomes.reduce((s, t) => s + cleanNumber(t.amount), 0);
  const income = Math.max(txnIncome, getMonthlyIncome());

  const totalSpent = consumption.reduce((s, t) => s + cleanNumber(t.amount), 0);
  const savingsContributed = savingsTxns.reduce((s, t) => s + cleanNumber(t.amount), 0);
  const debtPaid = debtPayments.reduce((s, t) => s + cleanNumber(t.amount), 0);

  // Cash that actually left the wallet this month (credit purchases don't, payments do).
  const cashOut = txns
    .filter((t) => t.affectsCashFlow && t.type !== "income")
    .reduce((s, t) => s + cleanNumber(t.amount), 0);

  const remaining = income - cashOut;
  const projectedSavings = remaining;
  const savings = savingsContributed;
  const savingsRate = income > 0 ? (savings / income) * 100 : 0;
  const days = daysElapsedInMonth(key);
  const dailyAvg = days > 0 ? totalSpent / days : 0;

  const byCategory = {};
  consumption.forEach((t) => { byCategory[t.category] = (byCategory[t.category] || 0) + cleanNumber(t.amount); });

  const byNecessity = { essential: 0, useful: 0, unnecessary: 0 };
  consumption.forEach((t) => {
    const n = ["essential", "useful", "unnecessary"].includes(t.necessity) ? t.necessity : "useful";
    byNecessity[n] += cleanNumber(t.amount);
  });

  return {
    key, txns, incomes, consumption, savingsTxns, debtPayments,
    income, txnIncome, totalSpent, debtPaid, cashOut,
    remaining, projectedSavings, savings, savingsContributed, savingsRate, dailyAvg,
    byCategory, byNecessity,
    essential: byNecessity.essential,
    optional: byNecessity.useful + byNecessity.unnecessary,
    unnecessary: byNecessity.unnecessary
  };
}

function calculateNoSpendStreak() {
  const spendDays = new Set(
    appData.transactions
      .filter((t) => CONSUMPTION_TYPES.includes(t.type) && cleanNumber(t.amount) > 0)
      .map((t) => t.date)
  );
  let streak = 0;
  const d = new Date();
  for (let i = 0; i < 366; i++) {
    const iso = d.toISOString().slice(0, 10);
    if (spendDays.has(iso)) break;
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function subMonthlyCost(s) {
  const c = cleanNumber(s.amount);
  switch (s.billingFrequency) {
    case "yearly": return c / 12;
    case "biweekly": return c * 2;
    case "weekly": return c * 52 / 12;
    default: return c;
  }
}
function calculateSubscriptionImpact() {
  const active = appData.subscriptions.filter((s) => s.active);
  const monthly = active.reduce((sum, s) => sum + subMonthlyCost(s), 0);
  const income = getMonthlyIncome();
  const optional = active.filter((s) => s.isOptional).reduce((sum, s) => sum + subMonthlyCost(s), 0);
  const essential = active.filter((s) => s.isEssential).reduce((sum, s) => sum + subMonthlyCost(s), 0);
  let mostExpensive = null;
  active.forEach((s) => { if (!mostExpensive || subMonthlyCost(s) > subMonthlyCost(mostExpensive)) mostExpensive = s; });
  return {
    monthly, yearly: monthly * 12, essential, optional,
    pctOfIncome: income > 0 ? (monthly / income) * 100 : 0,
    mostExpensive, suggestions: active.filter((s) => s.isOptional)
  };
}

/* ---------------------------------------------------------------------------
   6. DEBT / CARD CALCULATIONS
   --------------------------------------------------------------------------- */
function activeCards() { return appData.cards.filter((c) => c.isActive); }
function activeDebts() { return appData.debts.filter((d) => d.isActive); }

function calculateTotalCreditCardBalance() { return activeCards().reduce((s, c) => s + cleanNumber(c.currentBalance), 0); }
function calculateTotalNonCardDebt() { return activeDebts().reduce((s, d) => s + cleanNumber(d.totalDebt), 0); }
function calculateTotalDebt() { return calculateTotalCreditCardBalance() + calculateTotalNonCardDebt(); }
function calculateTotalAvailableCredit() { return activeCards().reduce((s, c) => s + Math.max(0, cleanNumber(c.availableCredit)), 0); }
function calculateTotalCreditLimit() { return activeCards().reduce((s, c) => s + cleanNumber(c.creditLimit), 0); }

function calculateCreditUtilization(card) {
  const limit = cleanNumber(card.creditLimit);
  if (limit <= 0) return null;
  return (cleanNumber(card.currentBalance) / limit) * 100;
}
function calculateGlobalCreditUtilization() {
  const limit = calculateTotalCreditLimit();
  if (limit <= 0) return null;
  return (calculateTotalCreditCardBalance() / limit) * 100;
}
function utilizationLevel(util) {
  if (util === null || !Number.isFinite(util)) return "neutral";
  if (util > 90) return "critical";
  if (util > 70) return "danger";
  if (util >= 40) return "warning";
  return "safe";
}

function calculateMinimumPayments() {
  return activeCards().reduce((s, c) => s + cleanNumber(c.minimumPayment), 0) +
    activeDebts().reduce((s, d) => s + cleanNumber(d.minimumPayment), 0);
}
function calculateNoInterestPayments() {
  return activeCards().reduce((s, c) => s + noInterestTarget(c), 0) +
    activeDebts().reduce((s, d) => s + Math.max(cleanNumber(d.minimumPayment), cleanNumber(d.noInterestPayment)), 0);
}
function noInterestTarget(item) { return Math.max(cleanNumber(item.minimumPayment), cleanNumber(item.noInterestPayment)); }

function getCardNextDueDate(card, today = new Date()) {
  const safeDay = clampInteger(card.dueDay, 1, 31);
  const base = startOfLocalDay(today);
  let candidate = createClampedDate(base.getFullYear(), base.getMonth(), safeDay);
  if (candidate < base) candidate = createClampedDate(base.getFullYear(), base.getMonth() + 1, safeDay);
  return candidate;
}
function getDaysUntil(dateObj, today = new Date()) {
  const due = startOfLocalDay(dateObj);
  const base = startOfLocalDay(today);
  return Math.round((Date.UTC(due.getFullYear(), due.getMonth(), due.getDate()) -
    Date.UTC(base.getFullYear(), base.getMonth(), base.getDate())) / 86400000);
}

// Unified obligation list (cards + debts) used by dashboard and planner.
function buildObligations() {
  const out = [];
  activeCards().forEach((c) => {
    const dueDate = getCardNextDueDate(c);
    out.push({
      kind: "card", ref: c, id: c.id,
      title: c.bank || c.name || "Tarjeta",
      subtitle: c.name || "Tarjeta de credito",
      dueDate, daysUntilDue: getDaysUntil(dueDate),
      minimum: cleanNumber(c.minimumPayment),
      noInterest: noInterestTarget(c),
      priority: c.priority,
      utilization: calculateCreditUtilization(c)
    });
  });
  activeDebts().forEach((d) => {
    const dueDate = d.dueDate ? new Date(d.dueDate + "T00:00:00") : null;
    out.push({
      kind: "debt", ref: d, id: d.id,
      title: d.name || "Deuda",
      subtitle: d.institution || "Deuda sin tarjeta",
      dueDate, daysUntilDue: dueDate ? getDaysUntil(dueDate) : Infinity,
      minimum: cleanNumber(d.minimumPayment),
      noInterest: noInterestTarget(d),
      priority: d.priority,
      utilization: null
    });
  });
  return out;
}

function obligationStatus(ob) {
  const warningDays = cleanNumber(appData.settings.warningDays);
  const dangerDays = cleanNumber(appData.settings.dangerDays);
  if (ob.priority === "critical") return { label: "Critico", level: "critical" };
  const days = ob.daysUntilDue;
  if (!Number.isFinite(days)) return { label: "Sin fecha", level: "neutral" };
  if (days < 0) return { label: "Vencido", level: "danger" };
  if (days <= dangerDays) return { label: "Urgente", level: "danger" };
  if (days <= warningDays) return { label: "Advertencia", level: "warning" };
  return { label: "Seguro", level: "safe" };
}

function sortObligationsByUrgency(list) {
  const weight = { critical: 0, high: 1, medium: 2, low: 3 };
  return [...list].sort((a, b) => {
    // Critical priority always first.
    const ac = a.priority === "critical" ? -1 : 0;
    const bc = b.priority === "critical" ? -1 : 0;
    if (ac !== bc) return ac - bc;
    if (a.daysUntilDue !== b.daysUntilDue) return a.daysUntilDue - b.daysUntilDue;
    return (weight[a.priority] ?? 2) - (weight[b.priority] ?? 2);
  });
}

/* ---------------------------------------------------------------------------
   7. CREDIT-CARD ENGINE
   --------------------------------------------------------------------------- */
function recalculateAvailableCredit(card) {
  card.availableCredit = Math.max(0, cleanNumber(card.creditLimit) - cleanNumber(card.currentBalance));
  return card.availableCredit;
}

// Rebuild a card's balance from scratch using all its movements (integrity tool).
function recalculateCardBalance(card) {
  const movements = appData.cardMovements
    .filter((m) => m.cardId === card.id)
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  let balance = 0;
  movements.forEach((m) => {
    if (["purchase", "interest", "fee"].includes(m.type)) balance += cleanNumber(m.amount);
    else if (m.type === "payment") balance = Math.max(0, balance - cleanNumber(m.amount));
    else if (m.type === "adjustment") balance = Math.max(0, balance + cleanNumber(m.amount));
  });
  card.currentBalance = Math.max(0, balance);
  recalculateAvailableCredit(card);
}

function createCardMovement(card, type, amount, { date, description, transactionId }) {
  const balanceBefore = cleanNumber(card.currentBalance);
  const availBefore = cleanNumber(card.availableCredit);
  let balanceAfter = balanceBefore;

  if (["purchase", "interest", "fee"].includes(type)) balanceAfter = balanceBefore + cleanNumber(amount);
  else if (type === "payment") balanceAfter = Math.max(0, balanceBefore - cleanNumber(amount));
  else if (type === "adjustment") balanceAfter = Math.max(0, balanceBefore + cleanNumber(amount)); // signed amount

  card.currentBalance = Math.max(0, balanceAfter);
  recalculateAvailableCredit(card);
  card.updatedAt = new Date().toISOString();

  const movement = {
    id: createId("mov"),
    cardId: card.id,
    transactionId: transactionId || null,
    type, amount: cleanNumber(amount),
    date: date || todayISO(),
    description: description || "",
    balanceBefore, balanceAfter: card.currentBalance,
    availableCreditBefore: availBefore, availableCreditAfter: card.availableCredit,
    createdAt: new Date().toISOString()
  };
  appData.cardMovements.push(movement);
  return movement;
}

function applyCreditCardPurchase(cardId, amount, opts = {}) {
  const card = appData.cards.find((c) => c.id === cardId);
  if (!card) return null;
  return createCardMovement(card, "purchase", amount, opts);
}
function applyCreditCardPayment(cardId, amount, opts = {}) {
  const card = appData.cards.find((c) => c.id === cardId);
  if (!card) return null;
  return createCardMovement(card, "payment", amount, opts);
}

// Reverse every movement tied to a transaction (used on edit / delete).
function reverseTransactionMovements(transactionId) {
  const related = appData.cardMovements.filter((m) => m.transactionId === transactionId);
  related.forEach((m) => {
    const card = appData.cards.find((c) => c.id === m.cardId);
    if (card) {
      const delta = cleanNumber(m.balanceAfter) - cleanNumber(m.balanceBefore); // signed change this movement made
      card.currentBalance = Math.max(0, cleanNumber(card.currentBalance) - delta);
      recalculateAvailableCredit(card);
    }
  });
  appData.cardMovements = appData.cardMovements.filter((m) => m.transactionId !== transactionId);
}

function reverseTransactionSideEffects(txnOrId) {
  const txn = typeof txnOrId === "string" ? appData.transactions.find((t) => t.id === txnOrId) : txnOrId;
  if (!txn) return;
  reverseTransactionMovements(txn.id);
  if (txn.type === "debt_payment" && txn.debtId) {
    const debt = appData.debts.find((d) => d.id === txn.debtId);
    if (debt) {
      debt.totalDebt = Math.max(0, cleanNumber(debt.totalDebt) + cleanNumber(txn.amount));
      debt.updatedAt = new Date().toISOString();
    }
  }
}

/* ---------------------------------------------------------------------------
   8. TRANSACTIONS ENGINE
   --------------------------------------------------------------------------- */
// Decide cash-flow / card-balance flags from a transaction's type + method.
function deriveTxnFlags(type, method, cardId) {
  let affectsCashFlow = true;
  let affectsCardBalance = false;
  if (type === "income") { affectsCashFlow = true; affectsCardBalance = false; }
  else if (CONSUMPTION_TYPES.includes(type)) {
    affectsCardBalance = method === "credit_card" && !!cardId;
    affectsCashFlow = method !== "credit_card";   // credit purchase doesn't move cash now
  } else if (type === "savings") {
    affectsCashFlow = true;
    affectsCardBalance = false;
  } else if (type === "credit_card_payment") { affectsCashFlow = true; affectsCardBalance = !!cardId; }
  else if (type === "debt_payment") { affectsCashFlow = true; affectsCardBalance = false; }
  else if (type === "adjustment") { affectsCardBalance = !!cardId; affectsCashFlow = !cardId; }
  return { affectsCashFlow, affectsCardBalance };
}

function buildTransaction(input, existing) {
  const now = new Date().toISOString();
  const type = TXN_TYPES.includes(input.type) ? input.type : "expense";
  const method = PAYMENT_METHODS.includes(input.paymentMethod) ? input.paymentMethod : "debit";
  const cardId = input.cardId || null;
  const flags = deriveTxnFlags(type, method, cardId);
  return {
    id: existing ? existing.id : createId("tx"),
    type,
    amount: Math.max(0, cleanNumber(input.amount)),
    category: input.category || "Otro",
    date: input.date || todayISO(),
    description: (input.description || "").trim(),
    essential: input.necessity === "essential",
    necessity: ["essential", "useful", "unnecessary"].includes(input.necessity) ? input.necessity : "useful",
    notes: (input.notes || "").trim(),
    paymentMethod: method,
    cardId: flags.affectsCardBalance ? cardId : (type === "income" ? null : cardId),
    debtId: input.debtId || null,
    affectsCashFlow: flags.affectsCashFlow,
    affectsCardBalance: flags.affectsCardBalance,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now
  };
}

// Apply a transaction's side effects to the relevant card.
function applyTransactionSideEffects(txn) {
  if (txn.affectsCardBalance && txn.cardId) {
    const opts = { date: txn.date, description: txn.description || txn.category, transactionId: txn.id };
    if (CONSUMPTION_TYPES.includes(txn.type)) applyCreditCardPurchase(txn.cardId, txn.amount, opts);
    else if (txn.type === "credit_card_payment") applyCreditCardPayment(txn.cardId, txn.amount, opts);
    else if (txn.type === "adjustment") createCardMovement(appData.cards.find((c) => c.id === txn.cardId), "adjustment", txn.amount, opts);
  }
  if (txn.type === "debt_payment" && txn.debtId) {
    const debt = appData.debts.find((d) => d.id === txn.debtId);
    if (debt) {
      debt.totalDebt = Math.max(0, cleanNumber(debt.totalDebt) - cleanNumber(txn.amount));
      debt.updatedAt = new Date().toISOString();
    }
  }
}

function commitTransaction(input, existing) {
  // Reverse old side effects first so editing is clean.
  if (existing) {
    reverseTransactionSideEffects(existing);
    appData.transactions = appData.transactions.filter((t) => t.id !== existing.id);
  }
  const txn = buildTransaction(input, existing);
  appData.transactions.push(txn);
  applyTransactionSideEffects(txn);
  saveData();
  return txn;
}

function deleteTransaction(id) {
  reverseTransactionSideEffects(id);
  appData.transactions = appData.transactions.filter((t) => t.id !== id);
  saveData();
}

/* ---------------------------------------------------------------------------
   9. PLANNER & SIMULATOR
   --------------------------------------------------------------------------- */
// Allocate available money across obligations: minimums first (urgency order),
// then no-interest targets. Returns per-obligation rows + summary.
function allocatePayments(obligations, availableForDebt) {
  const sorted = sortObligationsByUrgency(obligations);
  let remaining = Math.max(0, cleanNumber(availableForDebt));
  const rows = sorted.map((ob) => ({
    ob,
    minimumRequired: toPeriod(ob.minimum),
    noInterestRequired: toPeriod(ob.noInterest),
    recommended: 0,
    unpaidMinimum: toPeriod(ob.minimum),
    unpaidNoInterest: toPeriod(ob.noInterest)
  }));

  // Pass 1 — cover minimums by urgency.
  rows.forEach((r) => {
    const pay = Math.min(remaining, r.minimumRequired);
    r.recommended += pay; remaining -= pay;
    r.unpaidMinimum = Math.max(0, r.minimumRequired - r.recommended);
    r.unpaidNoInterest = Math.max(0, r.noInterestRequired - r.recommended);
  });
  // Pass 2 — top up to no-interest targets.
  rows.forEach((r) => {
    if (remaining <= 0) return;
    const gap = Math.max(0, r.noInterestRequired - r.recommended);
    const pay = Math.min(remaining, gap);
    r.recommended += pay; remaining -= pay;
    r.unpaidMinimum = Math.max(0, r.minimumRequired - r.recommended);
    r.unpaidNoInterest = Math.max(0, r.noInterestRequired - r.recommended);
  });

  return {
    rows, remaining,
    availableForDebt: Math.max(0, cleanNumber(availableForDebt)),
    totalAllocated: rows.reduce((s, r) => s + r.recommended, 0),
    unpaidMinimum: rows.reduce((s, r) => s + r.unpaidMinimum, 0),
    unpaidNoInterest: rows.reduce((s, r) => s + r.unpaidNoInterest, 0)
  };
}

function rowStatus(r) {
  if (r.unpaidMinimum > 0 && r.recommended <= 0) return { label: "No cubierto", level: "danger" };
  if (r.unpaidMinimum > 0) return { label: "En riesgo", level: "warning" };
  if (r.unpaidNoInterest > 0) return { label: "Parcialmente cubierto", level: "warning" };
  return { label: "Cubierto", level: "safe" };
}

function generatePaymentPlan({ available, extra, essential, savings, strategy }) {
  const surplus = Math.max(0, cleanNumber(available) + cleanNumber(extra) - cleanNumber(essential) - cleanNumber(savings));
  // Strategy caps how much of the surplus goes to debt this period.
  let availableForDebt = surplus;
  if (strategy === "conservative") availableForDebt = Math.min(surplus, toPeriod(calculateMinimumPayments()));
  else if (strategy === "balanced") availableForDebt = Math.min(surplus, toPeriod(calculateNoInterestPayments()));
  // "aggressive" applies the whole surplus to debt.
  const obligations = buildObligations();
  const allocation = allocatePayments(obligations, availableForDebt);
  return { availableForDebt, allocation, obligations, strategy };
}

/* ---------------------------------------------------------------------------
   10. CARD SPEND AVERAGING
   --------------------------------------------------------------------------- */
// One average calendar month, used as the trailing window for spend averaging.
const AVG_MONTH_DAYS = 30.4;

// Auto monthly average: total credit-card purchases on this card during the
// trailing 30.4-day window (one average month) ⇒ the card's monthly run-rate.
function computeAutoAverageMonthlySpend(card, windowDays = AVG_MONTH_DAYS) {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  return appData.cardMovements.reduce((sum, m) => {
    if (m.cardId !== card.id || m.type !== "purchase") return sum;
    const t = Date.parse(m.date || m.createdAt || "");
    if (Number.isNaN(t) || t < cutoff) return sum;
    return sum + cleanNumber(m.amount);
  }, 0);
}

// Spend figure the projection engine should use: the live auto value when
// auto-averaging is on (falling back to the manual entry while there's no
// history yet), otherwise the user's manual override.
function effectiveMonthlySpend(card) {
  if (card.autoAverageSpend === false) return cleanNumber(card.averageMonthlySpend);
  const auto = computeAutoAverageMonthlySpend(card);
  return auto > 0 ? auto : cleanNumber(card.averageMonthlySpend);
}

/* ---------------------------------------------------------------------------
   11. PURCHASE DECISION
   --------------------------------------------------------------------------- */
function discretionaryRemaining(summary) {
  const overall = appData.budgets.find((b) => b.active && b.type === "general");
  const amount = overall ? cleanNumber(overall.limit) : cleanNumber(appData.settings.monthlyBudget);
  return amount - summary.totalSpent;
}

function evaluatePurchaseDecision(input) {
  const summary = calculateMonthlySummary(viewMonth);
  const remaining = discretionaryRemaining(summary);
  const cost = cleanNumber(input.cost);
  const conservative = appData.settings.conservativeMode;

  const util = calculateGlobalCreditUtilization();
  const minSurvival = toPeriod(calculateMinimumPayments());
  const debtPressureHigh = dashboardAvailableMoney < minSurvival;
  const highUtil = util !== null && util > 70;
  const savingsMet = summary.savingsRate >= cleanNumber(appData.settings.savingsGoalPercent);
  const optional = input.need === "optional";

  // Order matters — first match wins.
  if (optional && input.freeAlt) {
    return { verdict: "No comprar", cls: "danger", reason: "Hay una alternativa gratis y esto es opcional." };
  }
  if (optional && (debtPressureHigh || highUtil)) {
    return { verdict: "No comprar", cls: "danger",
      reason: highUtil ? "La utilizacion de credito es alta y esta compra es opcional." : "Los proximos pagos de deuda estan en riesgo y esta compra es opcional." };
  }
  if (optional && input.canWait) {
    return { verdict: "Esperar 7 dias", cls: "warning", reason: "Puede esperar: dale 7 dias y vuelve a evaluarlo." };
  }
  if (cost > remaining) {
    return { verdict: "No comprar", cls: "danger", reason: `El costo supera tu presupuesto restante (quedan ${fmtMoney(remaining)}).` };
  }
  if (conservative && optional && !savingsMet) {
    return { verdict: "Esperar 7 dias", cls: "warning", reason: "La meta de ahorro aun no esta cubierta y esto es opcional. Espera 7 dias." };
  }
  if (input.need === "essential" || input.supports) {
    return { verdict: "Comprar", cls: "safe", reason: input.supports ? "Apoya salud, trabajo o familia y cabe en tu presupuesto." : "Marcado como esencial y dentro del presupuesto." };
  }
  return { verdict: "Comprar", cls: "safe", reason: "Cabe dentro de tu presupuesto restante." };
}

/* ===========================================================================
   12. RENDERING
   =========================================================================== */
const SECTION_TITLES = {
  dashboard: "Hoy", transactions: "Movimientos", cards: "Tarjetas de credito y deudas",
  planner: "Plan de pagos", subscriptions: "Suscripciones",
  decision: "Decision de compra", budgets: "Presupuestos", reports: "Reportes", settings: "Configuracion", more: "Mas"
};
const MONTH_SECTIONS = ["transactions", "budgets", "reports"];

function renderAll() {
  el("current-month-label").textContent = monthLabel(viewMonth);
  renderDashboard();
  renderTransactions();
  renderCardsAndDebts();
  renderSubscriptions();
  renderDecisions();
  renderBudgets();
  renderReports();
}

/* ---------- Dashboard: "Today / Payday Decision" ---------- */
function renderDashboard() {
  const periodMin = toPeriod(calculateMinimumPayments());
  const periodNoInt = toPeriod(calculateNoInterestPayments());
  const util = calculateGlobalCreditUtilization();
  const obligations = sortObligationsByUrgency(buildObligations());
  const nearest = obligations[0];
  const available = dashboardAvailableMoney;
  const hasDebt = obligations.length > 0;
  const word = periodNoun();

  // --- Decide the single most important status for the period. ---
  let level, heroLabel, heroValue, heroNote, action, actionLevel;
  if (!hasDebt) {
    level = "safe";
    heroLabel = "Seguro para gastar";
    heroValue = Math.max(0, available);
    heroNote = "Sin tarjetas ni deudas registradas.";
    action = "Agrega tus tarjetas y deudas para recibir recomendaciones de pago.";
    actionLevel = "neutral";
  } else if (available < periodMin) {
    level = "danger";
    heroLabel = "Falta para cubrir minimos";
    heroValue = periodMin - available;
    heroNote = `Necesitas ${fmtMoney(periodMin)} en pagos minimos esta ${word}.`;
    action = nearest
      ? `Paga ${nearest.title} primero. Evita gastar con tarjeta de credito.`
      : "Cubre tus pagos minimos antes de gastar.";
    actionLevel = "danger";
  } else if (available < periodNoInt) {
    level = "warning";
    heroLabel = "Seguro para gastar";
    heroValue = Math.max(0, available - periodNoInt);
    heroNote = `Minimos cubiertos. Reserva para evitar intereses: ${fmtMoney(periodNoInt)}.`;
    action = `Minimos cubiertos, pero la meta sin intereses esta corta por ${fmtMoney(periodNoInt - available)}.`;
    actionLevel = "warning";
  } else {
    level = "safe";
    heroLabel = "Seguro para gastar";
    heroValue = available - periodNoInt;
    heroNote = `Despues de cubrir minimos y meta sin intereses esta ${word}.`;
    action = `Vas seguro esta ${word}. Manten tus gastos por debajo de ${fmtMoney(heroValue)}.`;
    actionLevel = "safe";
  }
  if (util !== null && util > 70 && actionLevel !== "danger") {
    action += ` Uso de credito alto (${fmtPct(util)}); evita nuevas compras con tarjeta.`;
  }

  // --- 1. Safe to spend hero. ---
  const hero = el("today-hero");
  hero.className = `today-hero ${level}`;
  el("today-hero-label").textContent = heroLabel;
  el("today-hero-value").textContent = fmtMoney(heroValue);
  el("today-hero-note").textContent = heroNote;

  // --- 2. Recommended action. ---
  const actionPanel = el("today-action");
  actionPanel.className = `status-panel ${actionLevel}`;
  actionPanel.innerHTML = `<strong>Que hacer ahora</strong><p>${escapeHtml(action)}</p>`;

  // --- 3. Next payment due. ---
  const nextEl = el("today-next");
  if (nearest) {
    const st = obligationStatus(nearest);
    const days = nearest.daysUntilDue;
    const daysTxt = !Number.isFinite(days) ? "Sin fecha"
      : days < 0 ? `Vencido hace ${Math.abs(days)} d`
      : days === 0 ? "Vence hoy"
      : `En ${days} dia${days === 1 ? "" : "s"}`;
    nextEl.innerHTML = `
      <div class="today-card__head">
        <span class="today-card__kicker">Proximo pago</span>
        <span class="chip ${st.level}">${st.label}</span>
      </div>
      <div class="today-next__row">
        <div>
          <div class="today-next__name">${escapeHtml(nearest.title)}</div>
          <p class="today-card__sub">${nearest.dueDate ? formatDate(nearest.dueDate) : "Sin fecha"} · ${daysTxt}</p>
        </div>
        <div class="today-next__amount">${fmtMoney(nearest.minimum)}</div>
      </div>`;
  } else {
    nextEl.innerHTML = `<span class="today-card__kicker">Proximo pago</span><p class="today-card__sub">No hay pagos proximos.</p>`;
  }

  // --- 4. This payday summary. ---
  const diff = available - periodNoInt;
  const rows = [
    ["Dinero disponible", fmtMoney(available), ""],
    ["Pagos minimos", fmtMoney(periodMin), available >= periodMin ? "safe" : "danger"],
    ["Meta sin intereses", fmtMoney(periodNoInt), available >= periodNoInt ? "safe" : "warning"],
    [diff >= 0 ? "Excedente" : "Faltante", fmtMoney(Math.abs(diff)), diff >= 0 ? "safe" : "danger"],
    ["Uso de credito", util === null ? "—" : fmtPct(util), utilizationLevel(util)]
  ];
  el("today-summary").innerHTML = `
    <span class="today-card__kicker">Resumen · ${periodAdjective()}</span>
    <div class="today-summary__grid">
      ${rows.map(([l, v, lvl]) => `
        <div class="today-summary__item ${lvl || ""}">
          <span class="today-summary__label">${escapeHtml(l)}</span>
          <span class="today-summary__value">${escapeHtml(v)}</span>
        </div>`).join("")}
    </div>`;
}

/* ---------- Cards & Debts ---------- */
function renderCardsAndDebts() {
  const showInactive = el("show-inactive").checked;
  const cards = appData.cards.filter((c) => showInactive || c.isActive);
  const debts = appData.debts.filter((d) => showInactive || d.isActive);

  const util = calculateGlobalCreditUtilization();
  el("cards-summary").innerHTML = [
    ["Total Debt", fmtMoney(calculateTotalDebt())],
    ["Card Balance", fmtMoney(calculateTotalCreditCardBalance())],
    ["Available Credit", fmtMoney(calculateTotalAvailableCredit())],
    ["Credit Utilization", util === null ? "—" : fmtPct(util)],
    ["Total Minimums", fmtMoney(calculateMinimumPayments())],
    ["No-Interest Total", fmtMoney(calculateNoInterestPayments())]
  ].map(([t, v]) => `<article class="summary-card"><strong>${escapeHtml(t)}</strong><p>${escapeHtml(v)}</p></article>`).join("");

  el("card-list").innerHTML = cards.length
    ? cards.map(cardCardHtml).join("")
    : `<div class="empty-state">No credit cards yet. Add one to track balances, ledgers, and projections.</div>`;

  el("debt-list").innerHTML = debts.length
    ? debts.map(debtCardHtml).join("")
    : `<div class="empty-state">No non-card debts yet.</div>`;
}

function cardCardHtml(c) {
  const util = calculateCreditUtilization(c);
  const uLevel = utilizationLevel(util);
  const dueDate = getCardNextDueDate(c);
  const ob = { kind: "card", ref: c, priority: c.priority, daysUntilDue: getDaysUntil(dueDate), dueDate };
  const st = c.isActive ? obligationStatus(ob) : { label: "Inactive", level: "neutral" };
  const meterCls = uLevel === "critical" || uLevel === "danger" ? "danger" : uLevel === "warning" ? "warn" : "";
  const movements = appData.cardMovements.filter((m) => m.cardId === c.id).slice(-6).reverse();

  const ledger = movements.length ? `
    <div class="card-extra">
      <div class="panel-head"><h4 style="margin:0">Recent ledger</h4></div>
      <div class="table-wrap" style="border:0">
        <table class="ledger-table" style="min-width:0">
          <thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Balance</th><th>Avail.</th></tr></thead>
          <tbody>${movements.map((m) => `<tr>
            <td>${escapeHtml(m.date)}</td>
            <td>${escapeHtml(m.type)}</td>
            <td>${fmtMoney(m.amount)}</td>
            <td>${fmtMoney(m.balanceAfter)}</td>
            <td>${fmtMoney(m.availableCreditAfter)}</td></tr>`).join("")}</tbody>
        </table>
      </div>
    </div>` : "";

  return `
    <article class="debt-card">
      <div class="debt-card-head">
        <div>
          <div class="debt-title">${escapeHtml(c.bank || "Card")}</div>
          <p class="debt-subtitle">${escapeHtml(c.name || "Credit card")}</p>
        </div>
        <span class="chip ${st.level}">${st.label}</span>
      </div>
      <div class="detail-grid">
        <div class="detail-item"><div class="detail-label">Balance</div><div class="detail-value">${fmtMoney(c.currentBalance)}</div></div>
        <div class="detail-item"><div class="detail-label">Available credit</div><div class="detail-value">${fmtMoney(c.availableCredit)}</div></div>
        <div class="detail-item"><div class="detail-label">Credit limit</div><div class="detail-value">${fmtMoney(c.creditLimit)}</div></div>
        <div class="detail-item"><div class="detail-label">Minimum</div><div class="detail-value">${fmtMoney(c.minimumPayment)}</div></div>
        <div class="detail-item"><div class="detail-label">No-interest</div><div class="detail-value">${fmtMoney(c.noInterestPayment)}</div></div>
        <div class="detail-item"><div class="detail-label">CAT (annual)</div><div class="detail-value">${fmtPct(c.catAnnual)}</div></div>
        <div class="detail-item"><div class="detail-label">Statement day</div><div class="detail-value">${c.statementDay}</div></div>
        <div class="detail-item"><div class="detail-label">Due date</div><div class="detail-value">${formatDate(dueDate)}</div></div>
        <div class="detail-item"><div class="detail-label">Avg. spend / mo${c.autoAverageSpend !== false ? " <span class=\"muted small\">(auto)</span>" : ""}</div><div class="detail-value">${fmtMoney(effectiveMonthlySpend(c))}</div></div>
      </div>
      <div style="margin-top:12px">
        <div class="bar-row__label"><span>Utilization</span><em>${util === null ? "—" : fmtPct(util)}</em></div>
        <div class="meter"><div class="meter__fill ${meterCls}" style="width:${clampPct(util || 0)}%"></div></div>
      </div>
      ${c.notes ? `<p class="muted">${escapeHtml(c.notes)}</p>` : ""}
      ${ledger}
      <div class="card-actions">
        <button class="secondary-button" type="button" data-card-purchase="${c.id}">+ Compra</button>
        <button class="secondary-button" type="button" data-card-payment="${c.id}">Pagar</button>
        <button class="secondary-button" type="button" data-edit-card="${c.id}">Edit</button>
        <button class="secondary-button" type="button" data-toggle-card="${c.id}">${c.isActive ? "Desactivar" : "Reactivar"}</button>
        <button class="danger-button" type="button" data-del-card="${c.id}">Eliminar</button>
      </div>
    </article>`;
}

function debtCardHtml(d) {
  const dueDate = d.dueDate ? new Date(d.dueDate + "T00:00:00") : null;
  const ob = { kind: "debt", ref: d, priority: d.priority, daysUntilDue: dueDate ? getDaysUntil(dueDate) : Infinity, dueDate };
  const st = d.isActive ? obligationStatus(ob) : { label: "Inactive", level: "neutral" };
  return `
    <article class="debt-card">
      <div class="debt-card-head">
        <div>
          <div class="debt-title">${escapeHtml(d.name || "Debt")}</div>
          <p class="debt-subtitle">${escapeHtml(d.institution || "Non-card debt")} · ${escapeHtml(d.type.replace(/_/g, " "))}</p>
        </div>
        <span class="chip ${st.level}">${st.label}</span>
      </div>
      <div class="detail-grid">
        <div class="detail-item"><div class="detail-label">Total debt</div><div class="detail-value">${fmtMoney(d.totalDebt)}</div></div>
        <div class="detail-item"><div class="detail-label">Minimum</div><div class="detail-value">${fmtMoney(d.minimumPayment)}</div></div>
        <div class="detail-item"><div class="detail-label">No-interest</div><div class="detail-value">${fmtMoney(d.noInterestPayment)}</div></div>
        <div class="detail-item"><div class="detail-label">Due date</div><div class="detail-value">${d.dueDate ? formatDate(dueDate) : "Not set"}</div></div>
        <div class="detail-item"><div class="detail-label">Priority</div><div class="detail-value">${escapeHtml(d.priority)}</div></div>
        <div class="detail-item"><div class="detail-label">Frequency</div><div class="detail-value">${escapeHtml(d.frequency)}</div></div>
      </div>
      ${d.notes ? `<p class="muted">${escapeHtml(d.notes)}</p>` : ""}
      <div class="card-actions">
        <button class="secondary-button" type="button" data-pay-debt="${d.id}">Pagar</button>
        <button class="secondary-button" type="button" data-edit-debt="${d.id}">Edit</button>
        <button class="secondary-button" type="button" data-toggle-debt="${d.id}">${d.isActive ? "Desactivar" : "Reactivar"}</button>
        <button class="danger-button" type="button" data-del-debt="${d.id}">Eliminar</button>
      </div>
    </article>`;
}

/* ---------- Transactions ---------- */
function getFilteredTransactions() {
  const term = el("txn-search").value.trim().toLowerCase();
  const cat = el("txn-filter-category").value;
  const type = el("txn-filter-type").value;
  const method = el("txn-filter-method").value;
  const sort = el("txn-sort").value;

  let list = appData.transactions.filter((t) => inMonth(t.date, viewMonth));
  if (term) list = list.filter((t) => (t.description || "").toLowerCase().includes(term) || (t.category || "").toLowerCase().includes(term));
  if (cat) list = list.filter((t) => t.category === cat);
  if (type) list = list.filter((t) => t.type === type);
  if (method) list = list.filter((t) => t.paymentMethod === method);

  list.sort((a, b) => {
    switch (sort) {
      case "date-asc": return a.date.localeCompare(b.date);
      case "amount-desc": return b.amount - a.amount;
      case "amount-asc": return a.amount - b.amount;
      default: return b.date.localeCompare(a.date);
    }
  });
  return list;
}

function renderTransactions() {
  const list = getFilteredTransactions();
  const root = el("txn-list");
  if (!list.length) { root.innerHTML = `<div class="empty-state">No hay movimientos en ${monthLabel(viewMonth)}.</div>`; return; }
  root.innerHTML = list.map((t) => {
    const inflow = t.type === "income";
    const sign = inflow ? "+" : "−";
    const cls = inflow ? "amount-income" : "amount-expense";
    const card = t.cardId ? appData.cards.find((c) => c.id === t.cardId) : null;
    const methodLabel = t.paymentMethod === "credit_card" ? (card ? `${card.bank}` : "credit card") : t.paymentMethod;
    return `
      <div class="list-item">
        <div class="list-item__main">
          <span class="list-item__title">${escapeHtml(t.description || t.category)}</span>
          <span class="list-item__sub">${t.date} · ${escapeHtml(t.category)} · ${escapeHtml(methodLabel)}
            <span class="tag ${t.necessity || ""}">${escapeHtml(prettyType(t.type))}</span></span>
        </div>
        <div class="list-item__right">
          <div class="list-item__amount ${cls}">${sign}${fmtMoney(t.amount)}</div>
          <div class="list-item__actions">
            <button class="icon-btn" type="button" data-edit-txn="${t.id}">✎</button>
            <button class="icon-btn" type="button" data-del-txn="${t.id}">🗑</button>
          </div>
        </div>
      </div>`;
  }).join("");
}
function prettyType(t) {
  return {
    income: "ingreso",
    expense: "gasto",
    savings: "ahorro",
    debt_payment: "pago deuda",
    credit_card_payment: "pago tarjeta",
    subscription: "suscripcion",
    adjustment: "ajuste"
  }[t] || t;
}

/* ---------- Subscriptions ---------- */
function renderSubscriptions() {
  const impact = calculateSubscriptionImpact();
  el("sub-summary").innerHTML = [
    ["Monthly total", fmtMoney(impact.monthly)],
    ["Yearly total", fmtMoney(impact.yearly)],
    ["% of income", fmtPct(impact.pctOfIncome)],
    ["Optional total", fmtMoney(impact.optional)],
    ["Essential total", fmtMoney(impact.essential)],
    ["Most expensive", impact.mostExpensive ? `${impact.mostExpensive.name}` : "—"]
  ].map(([t, v]) => `<article class="summary-card"><strong>${escapeHtml(t)}</strong><p>${escapeHtml(v)}</p></article>`).join("");

  const insight = el("sub-insight");
  if (impact.pctOfIncome > 10) {
    insight.className = "status-panel warning";
    insight.innerHTML = `<strong>Review subscriptions</strong><p>Subscriptions take ${fmtPct(impact.pctOfIncome)} of your income. Consider cutting optional ones${impact.suggestions.length ? ": " + impact.suggestions.map((s) => escapeHtml(s.name)).join(", ") : ""}.</p>`;
  } else if (impact.suggestions.length) {
    insight.className = "status-panel neutral";
    insight.innerHTML = `<strong>Optional subscriptions</strong><p>Worth a periodic review: ${impact.suggestions.map((s) => escapeHtml(s.name)).join(", ")}.</p>`;
  } else {
    insight.className = "status-panel safe";
    insight.innerHTML = `<strong>Healthy</strong><p>Your subscription load looks healthy.</p>`;
  }

  const root = el("sub-list");
  if (!appData.subscriptions.length) { root.innerHTML = `<div class="empty-state">No subscriptions tracked.</div>`; return; }
  root.innerHTML = appData.subscriptions.map((s) => {
    const imp = s.isEssential ? "essential" : s.isOptional ? "optional" : "useful";
    const card = s.cardId ? appData.cards.find((c) => c.id === s.cardId) : null;
    return `
      <div class="list-item">
        <div class="list-item__main">
          <span class="list-item__title">${escapeHtml(s.name)} ${s.active ? "" : '<span class="tag inactive">paused</span>'}</span>
          <span class="list-item__sub">${escapeHtml(s.category)} · ${escapeHtml(s.billingFrequency)}
            <span class="tag ${imp}">${imp}</span>
            ${s.paymentMethod === "credit_card" && card ? "· " + escapeHtml(card.bank) : ""}
            ${s.nextPaymentDate ? "· renews " + s.nextPaymentDate : ""}</span>
        </div>
        <div class="list-item__right">
          <div class="list-item__amount">${fmtMoney(subMonthlyCost(s))}/mo</div>
          <div class="list-item__actions">
            <button class="icon-btn" type="button" data-edit-sub="${s.id}">✎</button>
            <button class="icon-btn" type="button" data-del-sub="${s.id}">🗑</button>
          </div>
        </div>
      </div>`;
  }).join("");
}

/* ---------- Decisions ---------- */
function renderDecisions() {
  const decs = appData.purchaseDecisions;
  const rejected = decs.filter((d) => ["Do not buy", "No comprar"].includes(d.verdict));
  const delayed = decs.filter((d) => String(d.verdict || "").startsWith("Wait") || String(d.verdict || "").startsWith("Esperar"));
  el("decision-stats").innerHTML = [
    ["Avoided (rejected)", fmtMoney(rejected.reduce((s, d) => s + cleanNumber(d.cost), 0))],
    ["Delayed", fmtMoney(delayed.reduce((s, d) => s + cleanNumber(d.cost), 0))],
    ["Decisions logged", String(decs.length)]
  ].map(([t, v]) => `<article class="summary-card"><strong>${escapeHtml(t)}</strong><p>${escapeHtml(v)}</p></article>`).join("");

  const root = el("decision-list");
  if (!decs.length) { root.innerHTML = `<div class="empty-state">No decisions yet. Use the form above before your next purchase.</div>`; return; }
  root.innerHTML = decs.slice().reverse().map((d) => {
    const verdict = String(d.verdict || "");
    const cls = ["Do not buy", "No comprar"].includes(verdict) ? "unnecessary" : (verdict.startsWith("Wait") || verdict.startsWith("Esperar")) ? "useful" : "essential";
    return `
      <div class="list-item">
        <div class="list-item__main">
          <span class="list-item__title">${escapeHtml(d.name)}</span>
          <span class="list-item__sub">${d.date} · ${escapeHtml(d.category)} <span class="tag ${cls}">${escapeHtml(d.verdict)}</span></span>
        </div>
        <div class="list-item__right">
          <div class="list-item__amount">${fmtMoney(d.cost)}</div>
          <div class="list-item__actions"><button class="icon-btn" type="button" data-del-dec="${d.id}">🗑</button></div>
        </div>
      </div>`;
  }).join("");
}

/* ---------- Budgets ---------- */
function budgetActual(b, summary) {
  if (b.type === "savings") return Math.max(0, summary.savings);
  if (b.type === "debt_payment") return summary.debtPaid;
  if (!b.category) return summary.totalSpent;
  return summary.byCategory[b.category] || 0;
}
function calculateBudgetStatus(b, summary) {
  const actual = budgetActual(b, summary);
  const amount = cleanNumber(b.limit);
  if (b.type === "savings" || b.type === "debt_payment") {
    const pct = amount > 0 ? (actual / amount) * 100 : 0;
    return { actual, amount, goal: true, pct, remaining: amount - actual, over: 0, status: actual >= amount ? "green" : pct >= 50 ? "yellow" : "red" };
  }
  const pct = amount > 0 ? (actual / amount) * 100 : 0;
  const threshold = cleanNumber(b.alertThreshold) || 80;
  let status = "green";
  if (pct >= 100) status = "red"; else if (pct >= threshold) status = "yellow";
  return { actual, amount, goal: false, pct, remaining: amount - actual, over: actual > amount ? actual - amount : 0, status, threshold };
}
function renderBudgets() {
  const summary = calculateMonthlySummary(viewMonth);
  const active = appData.budgets.filter((b) => b.active);
  const root = el("budget-list");
  const alerts = [];
  if (!active.length) { root.innerHTML = `<div class="empty-state">No budgets yet. Add one to start tracking.</div>`; el("budget-alerts").innerHTML = ""; return; }

  root.innerHTML = active.map((b) => {
    const st = calculateBudgetStatus(b, summary);
    const barCls = st.status === "red" ? "danger" : st.status === "yellow" ? "warn" : st.goal ? "info" : "";
    const pctText = fmtPct(st.pct);
    if (st.goal) {
      if (st.actual >= st.amount) alerts.push(["green", `${b.name}: goal reached (${pctText}).`]);
      else alerts.push(["yellow", `${b.name}: ${fmtMoney(st.actual)} of ${fmtMoney(st.amount)} (${pctText}).`]);
    } else if (st.over > 0) alerts.push(["red", `${b.name} exceeded by ${fmtMoney(st.over)}.`]);
    else if (st.pct >= (st.threshold || 80)) alerts.push(["yellow", `${b.name} is ${pctText} used.`]);

    const label = st.goal
      ? `${fmtMoney(st.actual)} / ${fmtMoney(st.amount)}`
      : `${fmtMoney(st.actual)} / ${fmtMoney(st.amount)} · ${st.over > 0 ? "over " + fmtMoney(st.over) : fmtMoney(st.remaining) + " left"}`;
    return `
      <div class="list-item" style="flex-direction:column;align-items:stretch;gap:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
          <span class="list-item__title">${escapeHtml(b.name)} <span class="chip ${st.status === "red" ? "danger" : st.status === "yellow" ? "warning" : "safe"}">${pctText}</span></span>
          <span class="list-item__actions">
            <button class="icon-btn" type="button" data-edit-budget="${b.id}">✎</button>
            <button class="icon-btn" type="button" data-del-budget="${b.id}">🗑</button>
          </span>
        </div>
        <div class="bar"><div class="bar__fill ${barCls}" style="width:${clampPct(st.pct)}%"></div></div>
        <span class="muted small">${escapeHtml(label)}</span>
      </div>`;
  }).join("");

  if (!alerts.length) alerts.push(["green", "Great job staying within budget."]);
  el("budget-alerts").innerHTML = alerts.map(([cls, msg]) => `<div class="alert ${cls}">${escapeHtml(msg)}</div>`).join("");
}

/* ---------- Reports ---------- */
function renderReports() {
  const s = calculateMonthlySummary(viewMonth);
  const subs = calculateSubscriptionImpact();
  const overall = appData.budgets.find((b) => b.active && b.type === "general");
  const overallSt = overall ? calculateBudgetStatus(overall, s) : null;
  const util = calculateGlobalCreditUtilization();

  el("report-stats").innerHTML = [
    ["Ingreso", fmtMoney(s.income)], ["Gastos", fmtMoney(s.totalSpent)],
    ["Ahorro registrado", fmtMoney(s.savings)], ["Tasa de ahorro", fmtPct(s.savingsRate)],
    ["Sin asignar", fmtMoney(s.remaining)], ["Ahorro potencial", fmtMoney(s.projectedSavings)],
    ["Deuda pagada", fmtMoney(s.debtPaid)], ["Deuda total", fmtMoney(calculateTotalDebt())]
  ].map(([t, v]) => `<article class="summary-card"><strong>${escapeHtml(t)}</strong><p>${escapeHtml(v)}</p></article>`).join("");

  renderBarChart("report-category-chart", s.byCategory, s.totalSpent);
  renderBarChart("report-necessity-chart", { Essential: s.byNecessity.essential, Useful: s.byNecessity.useful, Unnecessary: s.byNecessity.unnecessary }, s.totalSpent);
  renderBarChart("report-debt", {
    "Card balance": calculateTotalCreditCardBalance(),
    "Non-card debt": calculateTotalNonCardDebt(),
    "Available credit": calculateTotalAvailableCredit()
  }, calculateTotalDebt() + calculateTotalAvailableCredit());

  const top = s.consumption.slice().sort((a, b) => b.amount - a.amount).slice(0, 5);
  el("report-top").innerHTML = top.length
    ? top.map((t) => `<div class="list-item"><div class="list-item__main"><span class="list-item__title">${escapeHtml(t.description || t.category)}</span><span class="list-item__sub">${t.date} · ${escapeHtml(t.category)}</span></div><div class="list-item__amount amount-expense">${fmtMoney(t.amount)}</div></div>`).join("")
    : `<div class="empty-state">No expenses this month.</div>`;

  const topCat = Object.entries(s.byCategory).sort((a, b) => b[1] - a[1])[0];
  const pctIncome = s.income > 0 ? (s.totalSpent / s.income) * 100 : 0;
  let focus = "keep up the discipline";
  if (util !== null && util > 70) focus = "reduce credit utilization";
  else if (subs.pctOfIncome > 10) focus = "review subscriptions";
  else if (s.unnecessary > 0) focus = "cut unnecessary spending";
  else if (overallSt && overallSt.over > 0) focus = "rein in overall spending";

  el("report-summary").innerHTML = `<strong>${escapeHtml(monthLabel(viewMonth))}</strong><p>` +
    `Spending was ${fmtMoney(s.totalSpent)} (${fmtPct(pctIncome)} of income). ` +
    (topCat ? `Largest category: ${escapeHtml(topCat[0])} (${fmtMoney(topCat[1])}). ` : "") +
    `Optional spending ${fmtMoney(s.optional)}. Debt paid ${fmtMoney(s.debtPaid)}. ` +
    (util !== null ? `Credit utilization ${fmtPct(util)}. ` : "") +
    `Suggested focus: ${escapeHtml(focus)}.</p>`;
}
function renderBarChart(id, dataObj, total) {
  const root = el(id);
  const entries = Object.entries(dataObj).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { root.innerHTML = `<div class="empty-state">No data.</div>`; return; }
  root.innerHTML = entries.map(([k, v]) => {
    const pct = total > 0 ? (v / total) * 100 : 0;
    return `<div class="chart-row"><div class="chart-row__top"><span>${escapeHtml(k)}</span><span>${fmtMoney(v)} · ${fmtPct(pct)}</span></div><div class="chart-row__bar"><div class="chart-row__fill" style="width:${clampPct(pct)}%"></div></div></div>`;
  }).join("");
}

/* ---------- Planner ---------- */
function renderPlanner() {
  const obligations = buildObligations();
  if (!obligations.length) { el("planner-output").innerHTML = `<div class="empty-state">Add cards or debts first to calculate a payment plan.</div>`; return; }
  const plan = generatePaymentPlan({
    available: el("planner-available").value,
    extra: el("planner-extra").value,
    essential: el("planner-expenses").value,
    savings: el("planner-savings").value,
    strategy: el("planner-strategy").value
  });
  const word = periodNoun();
  const titleSuffix = isBiweekly() ? " (per quincena)" : "";
  el("planner-output").innerHTML = `
    <div class="strategy-grid">
      ${strategyCard(`Available for debt${titleSuffix}`, fmtMoney(plan.availableForDebt), `Money left for debts this ${word} after essentials and savings.`)}
      ${strategyCard("Allocated", fmtMoney(plan.allocation.totalAllocated), `${fmtMoney(plan.allocation.remaining)} left over.`)}
      ${strategyCard("Unpaid minimums", fmtMoney(plan.allocation.unpaidMinimum), plan.allocation.unpaidMinimum > 0 ? "Some minimums are not covered." : "All minimums covered.")}
      ${strategyCard("Unpaid no-interest", fmtMoney(plan.allocation.unpaidNoInterest), plan.allocation.unpaidNoInterest > 0 ? "No-interest targets short." : "No-interest targets covered.")}
    </div>
    ${allocationTable(plan.allocation, `Payment plan by urgency${titleSuffix}`)}`;
}
function strategyCard(title, value, body) {
  return `<article class="strategy-card"><strong>${escapeHtml(title)}</strong><div class="metric-value">${escapeHtml(value)}</div><p class="metric-note">${escapeHtml(body)}</p></article>`;
}
function allocationTable(allocation, title) {
  const rows = allocation.rows.map((r, i) => {
    const st = rowStatus(r);
    return `<tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(r.ob.title)}</td>
      <td>${escapeHtml(r.ob.subtitle)}</td>
      <td>${r.ob.dueDate ? formatDate(r.ob.dueDate) : "—"}</td>
      <td>${Number.isFinite(r.ob.daysUntilDue) ? r.ob.daysUntilDue : "—"}</td>
      <td>${fmtMoney(r.minimumRequired)}</td>
      <td>${fmtMoney(r.noInterestRequired)}</td>
      <td>${fmtMoney(r.recommended)}</td>
      <td><span class="chip ${st.level}">${st.label}</span></td>
    </tr>`;
  }).join("");
  return `<div class="table-panel"><div class="panel-head"><h3>${escapeHtml(title)}</h3><p>Remaining: ${fmtMoney(allocation.remaining)}</p></div>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Account</th><th>Detail</th><th>Due</th><th>Days</th><th>Minimum</th><th>No-interest</th><th>Suggested</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

/* ===========================================================================
   13. MODALS & FORMS
   =========================================================================== */
function openConfirm(message, onAccept) {
  pendingConfirm = onAccept;
  el("confirm-message").textContent = message;
  el("confirm-modal").classList.remove("hidden");
  el("confirm-cancel").focus();
}
function closeConfirm() { pendingConfirm = null; el("confirm-modal").classList.add("hidden"); }

function openFormModal(title, bodyHtml) {
  el("form-modal-title").textContent = title;
  el("form-modal-body").innerHTML = bodyHtml;
  el("form-modal").classList.remove("hidden");
}
function closeFormModal() { el("form-modal").classList.add("hidden"); el("form-modal-body").innerHTML = ""; }

function optionList(items, selected) {
  return items.map((c) => `<option ${c === selected ? "selected" : ""}>${escapeHtml(c)}</option>`).join("");
}
function debtOptions(selected, includeBlank) {
  const opts = activeDebts().map((d) => `<option value="${d.id}" ${d.id === selected ? "selected" : ""}>${escapeHtml(d.name)}${d.institution ? " - " + escapeHtml(d.institution) : ""}</option>`).join("");
  return (includeBlank ? `<option value="">Sin vincular</option>` : "") + opts;
}
function cardOptions(selected, includeBlank) {
  const opts = activeCards().map((c) => `<option value="${c.id}" ${c.id === selected ? "selected" : ""}>${escapeHtml(c.bank)} — ${escapeHtml(c.name)}</option>`).join("");
  return (includeBlank ? `<option value="">Selecciona tarjeta</option>` : "") + opts;
}

/* ----- Transaction modal ----- */
function openTransactionModal(existing, preset) {
  const t = existing || Object.assign({ type: "expense", date: todayISO(), necessity: "useful", paymentMethod: "debit" }, preset || {});
  const cats = t.type === "income" ? appData.settings.incomeCategories : t.type === "savings" ? ["Ahorro"] : appData.settings.expenseCategories;
  openFormModal(existing ? "Editar movimiento" : "Agregar movimiento", `
    <form id="txn-form" class="form-panel" style="box-shadow:none;border:0;padding:0;margin:0">
      <div class="form-grid">
        <label>Tipo
          <select id="tf-type">
            ${["expense", "income", "savings", "credit_card_payment", "debt_payment", "subscription", "adjustment"].map((x) => `<option value="${x}" ${t.type === x ? "selected" : ""}>${prettyType(x)}</option>`).join("")}
          </select>
        </label>
        <label>Monto<input id="tf-amount" inputmode="decimal" value="${t.amount ?? ""}" required></label>
        <label>Fecha<input id="tf-date" type="date" value="${t.date}" required></label>
        <label>Categoria<select id="tf-category">${optionList(cats, t.category)}</select></label>
        <label>Necesidad
          <select id="tf-necessity">${optionList(["essential", "useful", "unnecessary"], t.necessity)}</select>
        </label>
        <label>Metodo de pago
          <select id="tf-method">${optionList(PAYMENT_METHODS, t.paymentMethod)}</select>
        </label>
        <label id="tf-card-wrap" class="hidden">Tarjeta<select id="tf-card">${cardOptions(t.cardId, true)}</select></label>
        <label id="tf-debt-wrap" class="hidden">Deuda vinculada<select id="tf-debt">${debtOptions(t.debtId, true)}</select></label>
      </div>
      <label>Descripcion<input id="tf-desc" value="${escapeHtml(t.description || "")}"></label>
      <label>Notas<textarea id="tf-notes" rows="2">${escapeHtml(t.notes || "")}</textarea></label>
      <button type="submit" class="primary-button btn-block">${existing ? "Guardar cambios" : "Agregar movimiento"}</button>
    </form>`);

  const typeSel = el("tf-type"), methodSel = el("tf-method"), cardWrap = el("tf-card-wrap"), debtWrap = el("tf-debt-wrap");
  function refreshCardField() {
    const type = typeSel.value, method = methodSel.value;
    const needsCard = (CONSUMPTION_TYPES.includes(type) && method === "credit_card") || type === "credit_card_payment" || (type === "adjustment" && method === "credit_card");
    cardWrap.classList.toggle("hidden", !needsCard);
    debtWrap.classList.toggle("hidden", type !== "debt_payment");
  }
  function refreshCategories() {
    const list = typeSel.value === "income" ? appData.settings.incomeCategories : typeSel.value === "savings" ? ["Ahorro"] : appData.settings.expenseCategories;
    el("tf-category").innerHTML = optionList(list, el("tf-category").value);
  }
  typeSel.addEventListener("change", () => { refreshCategories(); refreshCardField(); });
  methodSel.addEventListener("change", refreshCardField);
  refreshCardField();

  el("txn-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const amount = cleanNumber(el("tf-amount").value);
    if (!(amount >= 0) || amount === 0) { toast("Ingresa un monto valido."); return; }
    const type = el("tf-type").value;
    const method = el("tf-method").value;
    const needsCard = (CONSUMPTION_TYPES.includes(type) && method === "credit_card") || type === "credit_card_payment" || (type === "adjustment" && method === "credit_card");
    const cardId = needsCard ? el("tf-card").value : null;
    if (needsCard && !cardId) { toast("Selecciona una tarjeta."); return; }
    commitTransaction({
      type, amount, date: el("tf-date").value, category: el("tf-category").value,
      description: el("tf-desc").value, necessity: el("tf-necessity").value,
      paymentMethod: method, cardId, debtId: type === "debt_payment" ? el("tf-debt").value || null : null, notes: el("tf-notes").value
    }, existing);
    closeFormModal(); renderAll();
    toast(existing ? "Movimiento actualizado." : "Movimiento agregado.");
  });
}

/* ----- Card modal ----- */
function openCardModal(existing) {
  const c = existing || { priority: "medium", statementDay: 1, dueDay: 20 };
  openFormModal(existing ? "Edit card" : "Add credit card", `
    <form id="card-form" class="form-panel" style="box-shadow:none;border:0;padding:0;margin:0">
      <div class="form-grid">
        <label>Bank<input id="cf-bank" value="${escapeHtml(c.bank || "")}" required></label>
        <label>Card name<input id="cf-name" value="${escapeHtml(c.name || "")}"></label>
        <label>Credit limit<input id="cf-limit" inputmode="decimal" value="${c.creditLimit ?? ""}" required></label>
        <label>Current balance<input id="cf-balance" inputmode="decimal" value="${c.currentBalance ?? 0}"></label>
        <label>Minimum payment<input id="cf-min" inputmode="decimal" value="${c.minimumPayment ?? ""}"></label>
        <label>No-interest payment<input id="cf-noint" inputmode="decimal" value="${c.noInterestPayment ?? ""}"></label>
        <label>Statement day<input id="cf-statement" inputmode="numeric" value="${c.statementDay ?? 1}"></label>
        <label>Due day<input id="cf-due" inputmode="numeric" value="${c.dueDay ?? 20}"></label>
        <label>CAT % (annual)<input id="cf-cat" inputmode="decimal" value="${c.catAnnual ?? ""}"></label>
        <label>Avg. monthly spend
          <input id="cf-avg" inputmode="decimal" value="${c.averageMonthlySpend ?? ""}" ${c.autoAverageSpend !== false ? "disabled" : ""}>
          <span class="auto-toggle" style="display:flex;align-items:center;gap:7px;font-weight:400;font-size:0.82rem;color:var(--ink-2)">
            <input type="checkbox" id="cf-avg-auto" style="width:auto;min-height:0" ${c.autoAverageSpend !== false ? "checked" : ""}>
            Auto · last 30.4 days
          </span>
          <small class="muted small" id="cf-avg-hint" style="font-weight:400"></small>
        </label>
        <label>Expected monthly payment<input id="cf-expected" inputmode="decimal" value="${c.expectedMonthlyPayment ?? ""}"></label>
        <label>Priority<select id="cf-priority">${optionList(PRIORITIES, c.priority)}</select></label>
      </div>
      <label>Notes<textarea id="cf-notes" rows="2">${escapeHtml(c.notes || "")}</textarea></label>
      <p class="muted small">Available credit is calculated automatically (limit − balance).</p>
      <button type="submit" class="primary-button btn-block">${existing ? "Save card" : "Add card"}</button>
    </form>`);

  // Live auto-average wiring: disable the manual field when auto is on and
  // preview the value computed from the last 30.4 days of card purchases.
  const autoVal = existing ? computeAutoAverageMonthlySpend(existing) : 0;
  function refreshAvgHint() {
    const on = el("cf-avg-auto").checked;
    el("cf-avg").disabled = on;
    el("cf-avg-hint").textContent = on
      ? (autoVal > 0
          ? `Auto: ${fmtMoney(autoVal)} from purchases in the last 30.4 days.`
          : "No card purchases in the last 30.4 days yet — manual value used as fallback.")
      : "Manual value used for projections.";
  }
  el("cf-avg-auto").addEventListener("change", refreshAvgHint);
  refreshAvgHint();

  el("card-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const bank = el("cf-bank").value.trim();
    if (!bank) { toast("Bank name is required."); return; }
    const now = new Date().toISOString();
    const card = normalizeCard({
      id: existing ? existing.id : createId("card"),
      bank, name: el("cf-name").value, creditLimit: el("cf-limit").value,
      currentBalance: el("cf-balance").value, minimumPayment: el("cf-min").value,
      noInterestPayment: el("cf-noint").value, statementDay: el("cf-statement").value,
      dueDay: el("cf-due").value, catAnnual: el("cf-cat").value,
      averageMonthlySpend: el("cf-avg").value, autoAverageSpend: el("cf-avg-auto").checked,
      expectedMonthlyPayment: el("cf-expected").value,
      priority: el("cf-priority").value, notes: el("cf-notes").value,
      isActive: existing ? existing.isActive : true,
      createdAt: existing ? existing.createdAt : now, updatedAt: now
    });
    if (existing) appData.cards = appData.cards.map((x) => x.id === existing.id ? card : x);
    else appData.cards.push(card);
    saveData(); closeFormModal(); renderAll();
    toast(existing ? "Card updated." : "Card added.");
  });
}

/* ----- Debt modal ----- */
function openDebtModal(existing) {
  const d = existing || { priority: "medium", type: "other", frequency: "monthly" };
  openFormModal(existing ? "Edit debt" : "Add debt", `
    <form id="debt-form" class="form-panel" style="box-shadow:none;border:0;padding:0;margin:0">
      <div class="form-grid">
        <label>Name<input id="df-name" value="${escapeHtml(d.name || "")}" required></label>
        <label>Institution<input id="df-inst" value="${escapeHtml(d.institution || "")}"></label>
        <label>Type<select id="df-type">${optionList(["personal_loan", "car_loan", "store_credit", "other"], d.type)}</select></label>
        <label>Total debt<input id="df-total" inputmode="decimal" value="${d.totalDebt ?? ""}" required></label>
        <label>Minimum payment<input id="df-min" inputmode="decimal" value="${d.minimumPayment ?? ""}"></label>
        <label>No-interest payment<input id="df-noint" inputmode="decimal" value="${d.noInterestPayment ?? ""}"></label>
        <label>Due date<input id="df-due" type="date" value="${d.dueDate || ""}"></label>
        <label>Priority<select id="df-priority">${optionList(PRIORITIES, d.priority)}</select></label>
        <label>Frequency<select id="df-freq">${optionList(["monthly", "biweekly"], d.frequency)}</select></label>
      </div>
      <label>Notes<textarea id="df-notes" rows="2">${escapeHtml(d.notes || "")}</textarea></label>
      <button type="submit" class="primary-button btn-block">${existing ? "Save debt" : "Add debt"}</button>
    </form>`);

  el("debt-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = el("df-name").value.trim();
    if (!name) { toast("Debt name is required."); return; }
    const now = new Date().toISOString();
    const debt = normalizeDebt({
      id: existing ? existing.id : createId("debt"),
      name, institution: el("df-inst").value, type: el("df-type").value,
      totalDebt: el("df-total").value, minimumPayment: el("df-min").value,
      noInterestPayment: el("df-noint").value, dueDate: el("df-due").value,
      priority: el("df-priority").value, frequency: el("df-freq").value, notes: el("df-notes").value,
      isActive: existing ? existing.isActive : true,
      createdAt: existing ? existing.createdAt : now, updatedAt: now
    });
    if (existing) appData.debts = appData.debts.map((x) => x.id === existing.id ? debt : x);
    else appData.debts.push(debt);
    saveData(); closeFormModal(); renderAll();
    toast(existing ? "Debt updated." : "Debt added.");
  });
}

/* ----- Card payment / purchase quick modals ----- */
function openCardPaymentModal(card) {
  openFormModal(`Pay ${card.bank}`, `
    <form id="pay-form" class="form-panel" style="box-shadow:none;border:0;padding:0;margin:0">
      <p class="muted small">Balance ${fmtMoney(card.currentBalance)} · available ${fmtMoney(card.availableCredit)}</p>
      <div class="form-grid">
        <label>Payment amount<input id="pf-amount" inputmode="decimal" value="${card.minimumPayment || ""}" required></label>
        <label>Date<input id="pf-date" type="date" value="${todayISO()}"></label>
        <label>Paid from<select id="pf-method">${optionList(["debit", "cash"], "debit")}</select></label>
      </div>
      <button type="submit" class="primary-button btn-block">Register payment</button>
    </form>`);
  el("pay-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const amount = cleanNumber(el("pf-amount").value);
    if (!(amount > 0)) { toast("Enter a valid amount."); return; }
    commitTransaction({
      type: "credit_card_payment", amount, date: el("pf-date").value,
      category: "Debt Payments", description: `${card.bank} payment`,
      necessity: "essential", paymentMethod: el("pf-method").value, cardId: card.id
    }, null);
    closeFormModal(); renderAll(); toast("Payment registered.");
  });
}
function openCardPurchaseModal(card) {
  openFormModal(`Purchase on ${card.bank}`, `
    <form id="buy-form" class="form-panel" style="box-shadow:none;border:0;padding:0;margin:0">
      <p class="muted small">Available credit ${fmtMoney(card.availableCredit)}</p>
      <div class="form-grid">
        <label>Amount<input id="bf-amount" inputmode="decimal" required></label>
        <label>Date<input id="bf-date" type="date" value="${todayISO()}"></label>
        <label>Category<select id="bf-category">${optionList(appData.settings.expenseCategories, "Other")}</select></label>
        <label>Necessity<select id="bf-necessity">${optionList(["essential", "useful", "unnecessary"], "useful")}</select></label>
      </div>
      <label>Description<input id="bf-desc"></label>
      <button type="submit" class="primary-button btn-block">Register purchase</button>
    </form>`);
  el("buy-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const amount = cleanNumber(el("bf-amount").value);
    if (!(amount > 0)) { toast("Enter a valid amount."); return; }
    commitTransaction({
      type: "expense", amount, date: el("bf-date").value, category: el("bf-category").value,
      description: el("bf-desc").value, necessity: el("bf-necessity").value,
      paymentMethod: "credit_card", cardId: card.id
    }, null);
    closeFormModal(); renderAll(); toast("Purchase registered.");
  });
}
function openDebtPaymentModal(debt) {
  openFormModal(`Pay ${debt.name}`, `
    <form id="dpay-form" class="form-panel" style="box-shadow:none;border:0;padding:0;margin:0">
      <p class="muted small">Total debt ${fmtMoney(debt.totalDebt)}</p>
      <div class="form-grid">
        <label>Payment amount<input id="dpf-amount" inputmode="decimal" value="${debt.minimumPayment || ""}" required></label>
        <label>Date<input id="dpf-date" type="date" value="${todayISO()}"></label>
        <label>Paid from<select id="dpf-method">${optionList(["debit", "cash"], "debit")}</select></label>
      </div>
      <p class="muted small">This records a cash outflow and reduces the debt total.</p>
      <button type="submit" class="primary-button btn-block">Register payment</button>
    </form>`);
  el("dpay-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const amount = cleanNumber(el("dpf-amount").value);
    if (!(amount > 0)) { toast("Enter a valid amount."); return; }
    commitTransaction({
      type: "debt_payment", amount, date: el("dpf-date").value,
      category: "Debt Payments", description: `${debt.name} payment`,
      necessity: "essential", paymentMethod: el("dpf-method").value, debtId: debt.id
    }, null);
    closeFormModal(); renderAll(); toast("Debt payment registered.");
  });
}

/* ----- Subscription modal ----- */
function openSubscriptionModal(existing) {
  const s = existing || { billingFrequency: "monthly", active: true, category: "Subscriptions", isOptional: true, isEssential: false, paymentMethod: "debit" };
  const importance = s.isEssential ? "essential" : s.isOptional ? "optional" : "useful";
  openFormModal(existing ? "Edit subscription" : "Add subscription", `
    <form id="sub-form" class="form-panel" style="box-shadow:none;border:0;padding:0;margin:0">
      <div class="form-grid">
        <label>Name<input id="sf-name" value="${escapeHtml(s.name || "")}" required></label>
        <label>Amount<input id="sf-amount" inputmode="decimal" value="${s.amount ?? ""}" required></label>
        <label>Billing<select id="sf-freq">${optionList(["weekly", "biweekly", "monthly", "yearly"], s.billingFrequency)}</select></label>
        <label>Category<select id="sf-cat">${optionList(appData.settings.expenseCategories, s.category)}</select></label>
        <label>Importance<select id="sf-imp">${optionList(["essential", "useful", "optional"], importance)}</select></label>
        <label>Next payment<input id="sf-next" type="date" value="${s.nextPaymentDate || ""}"></label>
        <label>Payment method<select id="sf-method">${optionList(PAYMENT_METHODS, s.paymentMethod)}</select></label>
        <label id="sf-card-wrap" class="${s.paymentMethod === "credit_card" ? "" : "hidden"}">Card<select id="sf-card">${cardOptions(s.cardId, true)}</select></label>
      </div>
      <label class="toggle-row" style="width:max-content"><input type="checkbox" id="sf-active" ${s.active ? "checked" : ""}> Active</label>
      <label>Notes<textarea id="sf-notes" rows="2">${escapeHtml(s.notes || "")}</textarea></label>
      <button type="submit" class="primary-button btn-block">${existing ? "Save" : "Add subscription"}</button>
    </form>`);
  el("sf-method").addEventListener("change", (e) => el("sf-card-wrap").classList.toggle("hidden", e.target.value !== "credit_card"));
  el("sub-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const amount = cleanNumber(el("sf-amount").value);
    if (!(amount >= 0)) { toast("Enter a valid amount."); return; }
    const imp = el("sf-imp").value;
    const method = el("sf-method").value;
    const record = {
      id: existing ? existing.id : createId("sub"),
      name: el("sf-name").value.trim(), amount,
      billingFrequency: el("sf-freq").value, category: el("sf-cat").value,
      isEssential: imp === "essential", isOptional: imp === "optional",
      nextPaymentDate: el("sf-next").value, paymentMethod: method,
      cardId: method === "credit_card" ? el("sf-card").value || null : null,
      active: el("sf-active").checked, notes: el("sf-notes").value.trim(),
      createdAt: existing ? existing.createdAt : new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    if (existing) appData.subscriptions = appData.subscriptions.map((x) => x.id === existing.id ? record : x);
    else appData.subscriptions.push(record);
    saveData(); closeFormModal(); renderAll(); toast("Subscription saved.");
  });
}

/* ----- Budget modal ----- */
function openBudgetModal(existing) {
  const b = existing || { type: "category", alertThreshold: 80, active: true, category: "" };
  const catOptions = `<option value="" ${b.category === "" ? "selected" : ""}>Overall (all spending)</option>` + optionList(appData.settings.expenseCategories, b.category);
  openFormModal(existing ? "Edit budget" : "Add budget", `
    <form id="budget-form" class="form-panel" style="box-shadow:none;border:0;padding:0;margin:0">
      <div class="form-grid">
        <label>Name<input id="bf-name" value="${escapeHtml(b.name || "")}" required></label>
        <label>Type<select id="bf-type">${optionList(["general", "category", "savings", "debt_payment"], b.type)}</select></label>
        <label id="bf-cat-wrap">Applies to<select id="bf-cat">${catOptions}</select></label>
        <label>Amount / limit<input id="bf-amount" inputmode="decimal" value="${b.limit ?? ""}" required></label>
        <label>Alert threshold %<input id="bf-threshold" inputmode="numeric" value="${b.alertThreshold ?? 80}"></label>
      </div>
      <label class="toggle-row" style="width:max-content"><input type="checkbox" id="bf-active" ${b.active ? "checked" : ""}> Active</label>
      <label>Notes<textarea id="bf-notes" rows="2">${escapeHtml(b.notes || "")}</textarea></label>
      <button type="submit" class="primary-button btn-block">${existing ? "Save" : "Add budget"}</button>
    </form>`);
  el("bf-type").addEventListener("change", (e) => {
    const isCat = e.target.value === "category";
    el("bf-cat-wrap").classList.toggle("hidden", !isCat);
  });
  el("bf-type").dispatchEvent(new Event("change"));
  el("budget-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const amount = cleanNumber(el("bf-amount").value);
    if (!(amount >= 0)) { toast("Enter a valid amount."); return; }
    const type = el("bf-type").value;
    const record = {
      id: existing ? existing.id : createId("budget"),
      name: el("bf-name").value.trim(),
      category: type === "category" ? el("bf-cat").value : (type === "savings" ? "__savings__" : type === "debt_payment" ? "__debt__" : ""),
      limit: amount, period: "monthly", type,
      alertThreshold: cleanNumber(el("bf-threshold").value) || 80,
      active: el("bf-active").checked, notes: el("bf-notes").value.trim(),
      createdAt: existing ? existing.createdAt : new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    if (existing) appData.budgets = appData.budgets.map((x) => x.id === existing.id ? record : x);
    else appData.budgets.push(record);
    saveData(); closeFormModal(); renderAll(); toast("Budget saved.");
  });
}

/* ===========================================================================
   14. BACKUP / IMPORT / EXPORT / MIGRATION
   =========================================================================== */
function isStandalonePWA() {
  return window.navigator.standalone === true || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
}
async function downloadFile(filename, text, mime) {
  const type = mime || "text/plain";
  const blob = new Blob([text], { type });
  if (isStandalonePWA() && typeof File === "function") {
    try {
      const file = new File([blob], filename, { type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: filename }); return; }
    } catch (err) { if (err && err.name === "AbortError") return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function exportFullBackup() {
  downloadFile(`finance-hub-backup-${todayISO()}.json`, JSON.stringify(appData, null, 2), "application/json");
  toast("Full backup exported.");
}
function csvEscape(v) { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function rowsToCsv(rows) { return rows.map((r) => r.map(csvEscape).join(",")).join("\n"); }

// Build the transaction predicate + filename for a given period selection.
//   range === "all"            → every transaction ever recorded
//   range === {from,to} (ISO)  → inclusive date range (either bound optional)
//   range falsy                → the month currently in focus (viewMonth)
function transactionExportPlan(range) {
  if (range === "all") {
    return { predicate: () => true, name: "transactions-all.csv" };
  }
  if (range && range.month) {
    return { predicate: (t) => inMonth(t.date, range.month), name: `transactions-${range.month}.csv` };
  }
  if (range && (range.from || range.to)) {
    const from = range.from || "0000-00-00";
    const to = range.to || "9999-12-31";
    return {
      predicate: (t) => typeof t.date === "string" && t.date >= from && t.date <= to,
      name: `transactions-${range.from || "inicio"}_a_${range.to || "hoy"}.csv`,
    };
  }
  return { predicate: (t) => inMonth(t.date, viewMonth), name: `transactions-${viewMonth}.csv` };
}

function exportTransactionsCSV(range) {
  const { predicate, name } = transactionExportPlan(range);
  const rows = [["id", "date", "type", "amount", "category", "description", "necessity", "paymentMethod", "cardId", "debtId", "notes"]];
  appData.transactions
    .filter(predicate)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .forEach((t) => rows.push([t.id, t.date, t.type, t.amount, t.category, t.description, t.necessity, t.paymentMethod, t.cardId || "", t.debtId || "", t.notes]));
  if (rows.length === 1) { toast("No hay transacciones en ese periodo."); return false; }
  downloadFile(name, rowsToCsv(rows), "text/csv");
  toast(`CSV exportado (${rows.length - 1} transacciones).`);
  return true;
}

function exportCSV(kind) {
  let rows = [], name = "";
  if (kind === "transactions") {
    exportTransactionsCSV();
    return;
  } else if (kind === "cards") {
    name = "cards.csv";
    rows.push(["bank", "name", "creditLimit", "currentBalance", "availableCredit", "minimumPayment", "noInterestPayment", "statementDay", "dueDay", "catAnnual", "priority"]);
    appData.cards.forEach((c) => rows.push([c.bank, c.name, c.creditLimit, c.currentBalance, c.availableCredit, c.minimumPayment, c.noInterestPayment, c.statementDay, c.dueDay, c.catAnnual, c.priority]));
  } else if (kind === "debts") {
    name = "debts.csv";
    rows.push(["name", "institution", "type", "totalDebt", "minimumPayment", "noInterestPayment", "dueDate", "priority", "frequency"]);
    appData.debts.forEach((d) => rows.push([d.name, d.institution, d.type, d.totalDebt, d.minimumPayment, d.noInterestPayment, d.dueDate, d.priority, d.frequency]));
  } else if (kind === "subscriptions") {
    name = "subscriptions.csv";
    rows.push(["name", "amount", "billingFrequency", "category", "isEssential", "isOptional", "nextPaymentDate", "paymentMethod", "active"]);
    appData.subscriptions.forEach((s) => rows.push([s.name, s.amount, s.billingFrequency, s.category, s.isEssential, s.isOptional, s.nextPaymentDate, s.paymentMethod, s.active]));
  } else if (kind === "report") {
    name = `report-${viewMonth}.csv`;
    const s = calculateMonthlySummary(viewMonth);
    rows.push(["metric", "value"]);
    rows.push(["month", viewMonth], ["income", s.income.toFixed(2)], ["expenses", s.totalSpent.toFixed(2)],
      ["savings", s.savings.toFixed(2)], ["potentialSavings", s.projectedSavings.toFixed(2)], ["savingsRate%", s.savingsRate.toFixed(1)],
      ["essential", s.byNecessity.essential.toFixed(2)], ["useful", s.byNecessity.useful.toFixed(2)],
      ["unnecessary", s.byNecessity.unnecessary.toFixed(2)], ["debtPaid", s.debtPaid.toFixed(2)],
      ["totalDebt", calculateTotalDebt().toFixed(2)], ["creditUtilization%", (calculateGlobalCreditUtilization() || 0).toFixed(1)]);
    rows.push([]);
    rows.push(["category", "amount"]);
    Object.entries(s.byCategory).forEach(([k, v]) => rows.push([k, v.toFixed(2)]));
  }
  downloadFile(name, rowsToCsv(rows), "text/csv");
  toast("CSV exported.");
}

// Distinct months present in the data, newest first ("YYYY-MM").
function transactionMonths() {
  const set = new Set();
  appData.transactions.forEach((t) => { if (typeof t.date === "string" && t.date.length >= 7) set.add(t.date.slice(0, 7)); });
  return [...set].sort((a, b) => (a < b ? 1 : -1));
}

function openTransactionExportModal() {
  const months = transactionMonths();
  const monthOpts = months.length
    ? months.map((m) => `<option value="${m}" ${m === viewMonth ? "selected" : ""}>${m}</option>`).join("")
    : `<option value="${viewMonth}" selected>${viewMonth}</option>`;
  openFormModal("Exportar transacciones a CSV", `
    <form id="export-period-form" class="form-panel" style="box-shadow:none;border:0;padding:0;margin:0">
      <label>Periodo a exportar
        <select id="ef-mode">
          <option value="current">Mes en foco (${viewMonth})</option>
          <option value="month">Un mes específico</option>
          <option value="range">Rango de fechas</option>
          <option value="all">Todo (desde el inicio)</option>
        </select>
      </label>
      <label id="ef-month-wrap" class="hidden">Mes
        <select id="ef-month">${monthOpts}</select>
      </label>
      <div id="ef-range-wrap" class="form-grid hidden">
        <label>Desde<input type="date" id="ef-from"></label>
        <label>Hasta<input type="date" id="ef-to"></label>
      </div>
      <p id="ef-count" class="muted small" style="margin:.4rem 0"></p>
      <button type="submit" class="primary-button btn-block">Exportar CSV</button>
    </form>`);

  const rangeFor = () => {
    const mode = el("ef-mode").value;
    if (mode === "all") return "all";
    if (mode === "month") return { month: el("ef-month").value };
    if (mode === "range") return { from: el("ef-from").value || "", to: el("ef-to").value || "" };
    return null; // current viewMonth
  };
  const refresh = () => {
    const mode = el("ef-mode").value;
    el("ef-month-wrap").classList.toggle("hidden", mode !== "month");
    el("ef-range-wrap").classList.toggle("hidden", mode !== "range");
    const { predicate } = transactionExportPlan(rangeFor());
    const n = appData.transactions.filter(predicate).length;
    el("ef-count").textContent = n === 1 ? "1 transacción se exportará." : `${n} transacciones se exportarán.`;
  };
  el("ef-mode").addEventListener("change", refresh);
  ["ef-month", "ef-from", "ef-to"].forEach((id) => el(id) && el(id).addEventListener("change", refresh));
  refresh();

  el("export-period-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (exportTransactionsCSV(rangeFor())) closeFormModal();
  });
}

function downloadCsvTemplate() {
  const header = ["date", "type", "amount", "category", "description", "necessity", "paymentMethod", "notes"];
  const ex1 = [todayISO(), "expense", "250.00", "Food", "Lunch", "useful", "debit", "Example - delete me"];
  const ex2 = [todayISO(), "income", "9250.00", "Salary", "Quincena", "essential", "debit", "Example - delete me"];
  downloadFile("transactions-template.csv", rowsToCsv([header, ex1, ex2]), "text/csv");
  toast("Template downloaded.");
}

function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = []; let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}
function normalizeImportDate(s) {
  const str = String(s).trim();
  const dmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const ymd = str.replace(/\//g, "-").match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, "0")}-${ymd[3].padStart(2, "0")}`;
  return null;
}
function importTransactionsCSV(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const rows = parseCSV(reader.result);
      if (rows.length < 2) { toast("CSV has no data rows."); return; }
      const header = rows[0].map((h) => h.trim().toLowerCase());
      const idx = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i !== -1) return i; } return -1; };
      const col = { date: idx("date"), type: idx("type"), amount: idx("amount"), category: idx("category"), description: idx("description"), necessity: idx("necessity"), payment: idx("paymentmethod", "payment"), notes: idx("notes") };
      if (col.date === -1 || col.amount === -1) { toast("CSV needs 'date' and 'amount' columns."); return; }
      let added = 0, skipped = 0;
      for (let r = 1; r < rows.length; r++) {
        const cells = rows[r];
        const get = (k) => (col[k] >= 0 ? (cells[col[k]] ?? "").trim() : "");
        const date = normalizeImportDate(get("date"));
        const amount = cleanNumber(get("amount"));
        if (!date || !(amount >= 0)) { skipped++; continue; }
        const rawType = get("type").toLowerCase();
        const type = ["income", "expense", "savings"].includes(rawType) ? rawType : "expense";
        let necessity = get("necessity").toLowerCase();
        if (!["essential", "useful", "unnecessary"].includes(necessity)) necessity = "useful";
        let method = get("payment").toLowerCase();
        if (method === "credit") method = "credit_card";
        if (!PAYMENT_METHODS.includes(method)) method = "debit";
        // CSV-imported credit purchases have no card target → treat as debit to keep cash flow sane.
        if (method === "credit_card") method = "debit";
        commitTransaction({ type, amount, date, category: get("category") || "Other", description: get("description"), necessity, paymentMethod: method, notes: get("notes") }, null);
        added++;
      }
      renderAll();
      toast(`Imported ${added} transaction(s)` + (skipped ? `, skipped ${skipped}.` : "."));
    } catch (err) { console.error(err); toast("CSV import failed."); }
  };
  reader.readAsText(file);
}

function importFullBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      appData = normalizeData(parsed);
      dashboardAvailableMoney = getDefaultAvailableMoney();
      saveData(); applyThemePreference(); hydrateAll();
      toast("Backup imported.");
    } catch (err) { console.error(err); toast("Import failed — invalid file."); }
  };
  reader.readAsText(file);
}

/* ----- Migration from old apps ----- */
function migratePagoClaroData(old) {
  if (!old || !Array.isArray(old.debts)) { toast("Not a PagoClaro backup."); return; }
  let cards = 0, debts = 0;
  old.debts.forEach((d) => {
    const hasLimit = cleanNumber(d.creditLimit) > 0;
    if (hasLimit) {
      appData.cards.push(normalizeCard({
        bank: d.bankName, name: d.debtName, creditLimit: d.creditLimit, currentBalance: d.totalDebt,
        minimumPayment: d.minimumPayment, noInterestPayment: d.noInterestPayment,
        statementDay: d.cutoffDay, dueDay: d.dueDay, catAnnual: d.interestRate,
        priority: d.priority === "high" ? "high" : d.priority === "low" ? "low" : "medium",
        notes: d.notes, isActive: d.isActive !== false
      }));
      cards++;
    } else {
      appData.debts.push(normalizeDebt({
        name: d.debtName, institution: d.bankName, totalDebt: d.totalDebt,
        minimumPayment: d.minimumPayment, noInterestPayment: d.noInterestPayment,
        priority: d.priority === "high" ? "high" : d.priority === "low" ? "low" : "medium",
        notes: d.notes, isActive: d.isActive !== false
      }));
      debts++;
    }
  });
  appData.migrations.importedPagoClaro = true;
  saveData(); renderAll();
  toast(`Imported ${cards} card(s) and ${debts} debt(s) from PagoClaro.`);
}

function migrateJavisFinanceData(old) {
  if (!old || !Array.isArray(old.transactions)) { toast("Not a Javi's Finance backup."); return; }
  const methodMap = (m) => m === "credit" ? "debit" : PAYMENT_METHODS.includes(m) ? m : "debit";
  (old.transactions || []).forEach((t) => {
    commitTransaction({
      type: t.type === "income" ? "income" : "expense", amount: t.amount, date: t.date,
      category: t.category || "Other", description: t.description, necessity: t.necessity,
      paymentMethod: methodMap(t.paymentMethod), notes: t.notes
    }, null);
  });
  (old.subscriptions || []).forEach((s) => {
    appData.subscriptions.push({
      id: createId("sub"), name: s.name, amount: cleanNumber(s.monthlyCost),
      billingFrequency: ["weekly", "biweekly", "monthly", "yearly"].includes(s.frequency) ? s.frequency : "monthly",
      category: s.category || "Subscriptions", isEssential: s.importance === "essential", isOptional: s.importance === "optional",
      nextPaymentDate: s.nextRenewal || "", paymentMethod: "debit", cardId: null,
      active: s.active !== false, notes: s.notes || "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
  });
  (old.budgets || []).forEach((b) => {
    const type = b.category === "__savings__" ? "savings" : !b.category ? "general" : "category";
    appData.budgets.push({
      id: createId("budget"), name: b.name, category: b.category === "__savings__" ? "__savings__" : (b.category || ""),
      limit: cleanNumber(b.amount), period: "monthly", type, alertThreshold: cleanNumber(b.alertThreshold) || 80,
      active: b.active !== false, notes: b.notes || "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
  });
  (old.purchaseDecisions || []).forEach((d) => appData.purchaseDecisions.push(Object.assign({ id: createId("dec") }, d)));
  appData.migrations.importedJavisFinance = true;
  saveData(); renderAll();
  toast("Imported data from Javi's Finance.");
}

function importMigration(file, fn) {
  const reader = new FileReader();
  reader.onload = () => {
    try { fn(JSON.parse(reader.result)); }
    catch (err) { console.error(err); toast("Migration failed — invalid file."); }
  };
  reader.readAsText(file);
}

/* ===========================================================================
   15. SETTINGS, NAVIGATION, EVENTS, INIT
   =========================================================================== */
function fillCategorySelects() {
  const exp = appData.settings.expenseCategories;
  const inc = appData.settings.incomeCategories;
  el("qa-category").innerHTML = optionList(exp, "");
  el("dec-category").innerHTML = optionList(exp, "");
  const all = [...new Set([...exp, ...inc, "Ahorro"])];
  el("txn-filter-category").innerHTML = `<option value="">All</option>` + optionList(all, "");
}
function fillCardSelects() {
  el("qa-card").innerHTML = cardOptions("", true);
}

function loadSettingsForm() {
  const s = appData.settings;
  el("set-currency-code").value = s.currency;
  el("set-currency-symbol").value = s.currencySymbol;
  el("set-monthly-income").value = s.monthlyIncome;
  el("set-biweekly-income").value = s.biweeklyIncome;
  el("set-pay-frequency").value = s.payFrequency;
  el("set-theme").value = THEME_PREFERENCES.includes(s.theme) ? s.theme : "system";
  el("set-savings-pct").value = s.savingsGoalPercent;
  el("set-spend-pct").value = s.spendingLimitPercent;
  el("set-monthly-budget").value = s.monthlyBudget;
  el("set-warning-days").value = s.warningDays;
  el("set-danger-days").value = s.dangerDays;
  el("set-projection-months").value = s.defaultProjectionMonths;
  el("set-conservative").checked = !!s.conservativeMode;
  el("set-expense-cats").value = s.expenseCategories.join(", ");
  el("set-income-cats").value = s.incomeCategories.join(", ");
}
function saveSettingsForm() {
  const err = el("settings-form-error"); err.textContent = "";
  const warningDays = clampInteger(el("set-warning-days").value, 0, 365);
  const dangerDays = clampInteger(el("set-danger-days").value, 0, 365);
  if (dangerDays > warningDays) { err.textContent = "Danger threshold must be ≤ warning threshold."; return; }
  const s = appData.settings;
  s.currency = el("set-currency-code").value.trim() || "MXN";
  s.currencySymbol = el("set-currency-symbol").value.trim() || "$";
  s.monthlyIncome = parseMoneyInput(el("set-monthly-income").value);
  s.biweeklyIncome = parseMoneyInput(el("set-biweekly-income").value);
  s.payFrequency = el("set-pay-frequency").value === "monthly" ? "monthly" : "biweekly";
  s.theme = THEME_PREFERENCES.includes(el("set-theme").value) ? el("set-theme").value : "system";
  s.savingsGoalPercent = clampInteger(el("set-savings-pct").value, 0, 100);
  s.spendingLimitPercent = clampInteger(el("set-spend-pct").value, 0, 100);
  s.monthlyBudget = parseMoneyInput(el("set-monthly-budget").value);
  s.warningDays = warningDays;
  s.dangerDays = dangerDays;
  s.defaultProjectionMonths = clampInteger(el("set-projection-months").value, 1, 60);
  s.conservativeMode = el("set-conservative").checked;
  applyThemePreference();
  dashboardAvailableMoney = getDefaultAvailableMoney();
  saveData(); hydrateAll();
  toast("Settings saved.");
}
function saveCategories() {
  const parse = (v) => v.split(",").map((x) => x.trim()).filter(Boolean);
  const exp = parse(el("set-expense-cats").value);
  const inc = parse(el("set-income-cats").value);
  if (!exp.length || !inc.length) { toast("Categories cannot be empty."); return; }
  appData.settings.expenseCategories = exp;
  appData.settings.incomeCategories = inc;
  saveData(); fillCategorySelects(); renderAll();
  toast("Categories saved.");
}

/* ----- Theme ----- */
function getSystemTheme() {
  if (typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function applyThemePreference() {
  const pref = THEME_PREFERENCES.includes(appData?.settings?.theme) ? appData.settings.theme : "system";
  const effective = pref === "system" ? getSystemTheme() : pref;
  if (pref === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = pref;
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    const media = meta.getAttribute("media") || "";
    if (pref === "system") {
      if (media.includes("dark")) meta.content = THEME_COLORS.dark;
      else if (media.includes("light")) meta.content = THEME_COLORS.light;
      else meta.content = THEME_COLORS[effective];
    } else meta.content = THEME_COLORS[effective];
  });
}
const systemThemeQuery = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
if (systemThemeQuery) {
  const handler = () => { if ((appData?.settings?.theme || "system") === "system") applyThemePreference(); };
  if (systemThemeQuery.addEventListener) systemThemeQuery.addEventListener("change", handler);
  else if (systemThemeQuery.addListener) systemThemeQuery.addListener(handler);
}

/* ----- Navigation ----- */
function showSection(id) {
  $all(".section").forEach((s) => s.classList.toggle("active", s.id === id));
  $all(".nav-button").forEach((b) => b.classList.toggle("active", b.dataset.section === id));
  el("section-title").textContent = SECTION_TITLES[id] || "Finance Hub";
  el("month-switch").style.display = MONTH_SECTIONS.includes(id) ? "" : "none";
  if (id === "planner") { el("planner-available").value = el("planner-available").value || dashboardAvailableMoney; renderPlanner(); }
  window.scrollTo(0, 0);
}
function buildMoreMenu() {
  const items = [
    ["subscriptions", "Suscripciones"], ["decision", "Decision de compra"],
    ["budgets", "Presupuestos"], ["reports", "Reportes"], ["settings", "Configuracion"]
  ];
  el("more-nav").innerHTML = items.map(([id, label]) =>
    `<button class="nav-button" type="button" data-section="${id}"><span>${escapeHtml(label)}</span></button>`).join("");
}
function shiftMonth(delta) {
  const [y, m] = viewMonth.split("-").map(Number);
  viewMonth = monthKey(new Date(y, m - 1 + delta, 1));
  renderAll();
}

/* ----- Hydrate everything (after data change) ----- */
function hydrateAll() {
  fillCategorySelects();
  fillCardSelects();
  loadSettingsForm();
  el("dashboard-available").value = dashboardAvailableMoney;
  el("planner-available").value = dashboardAvailableMoney;
  el("qa-date").value = todayISO();
  renderAll();
}

/* ----- Event wiring ----- */
function bindElements() {
  els.storageStatus = el("storage-status");
}
function bindEvents() {
  // Navigation (sidebar + bottom nav + more menu).
  document.addEventListener("click", (e) => {
    const nav = e.target.closest(".nav-button[data-section]");
    if (nav) { showSection(nav.dataset.section); return; }
  });

  // Month switch.
  el("prev-month").addEventListener("click", () => shiftMonth(-1));
  el("next-month").addEventListener("click", () => shiftMonth(1));

  // Dashboard money + quick add.
  el("dashboard-money-form").addEventListener("submit", (e) => { e.preventDefault(); dashboardAvailableMoney = parseMoneyInput(el("dashboard-available").value); renderDashboard(); });
  el("qa-payment").addEventListener("change", (e) => el("qa-card-wrap").classList.toggle("hidden", e.target.value !== "credit_card"));
  el("quick-add-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const amount = cleanNumber(el("qa-amount").value);
    if (!(amount > 0)) { toast("Enter a valid amount."); return; }
    const method = el("qa-payment").value;
    const cardId = method === "credit_card" ? el("qa-card").value : null;
    if (method === "credit_card" && !cardId) { toast("Select a card."); return; }
    commitTransaction({ type: "expense", amount, date: el("qa-date").value || todayISO(), category: el("qa-category").value, description: el("qa-description").value, necessity: "useful", paymentMethod: method, cardId }, null);
    e.target.reset(); el("qa-date").value = todayISO(); el("qa-card-wrap").classList.add("hidden");
    renderAll(); toast("Expense added.");
  });

  // Transactions.
  el("add-txn-btn").addEventListener("click", () => openTransactionModal(null));
  ["txn-search", "txn-filter-category", "txn-filter-type", "txn-filter-method", "txn-sort"].forEach((id) => el(id).addEventListener("input", renderTransactions));
  el("export-txn-csv").addEventListener("click", openTransactionExportModal);
  el("download-csv-template").addEventListener("click", downloadCsvTemplate);
  el("import-txn-csv").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) openConfirm("Add the transactions from this CSV to your data?", () => importTransactionsCSV(f)); e.target.value = ""; });

  // Cards & debts.
  el("show-inactive").addEventListener("change", renderCardsAndDebts);
  el("add-card-btn").addEventListener("click", () => openCardModal(null));
  el("add-debt-btn").addEventListener("click", () => openDebtModal(null));

  // Planner.
  el("planner-form").addEventListener("submit", (e) => { e.preventDefault(); renderPlanner(); });
  el("planner-strategy").addEventListener("change", renderPlanner);

  // Subscriptions / budgets / decision add.
  el("add-sub-btn").addEventListener("click", () => openSubscriptionModal(null));
  el("add-budget-btn").addEventListener("click", () => openBudgetModal(null));
  el("decision-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = {
      name: el("dec-name").value.trim(), cost: cleanNumber(el("dec-cost").value), category: el("dec-category").value,
      need: el("dec-need").value, supports: el("dec-supports").checked, canWait: el("dec-can-wait").checked, freeAlt: el("dec-free-alt").checked,
      notes: el("dec-notes").value.trim()
    };
    if (!input.name) { toast("Enter an item name."); return; }
    const result = evaluatePurchaseDecision(input);
    const box = el("decision-result");
    box.className = "status-panel " + result.cls;
    box.classList.remove("hidden");
    box.innerHTML = `<strong>${escapeHtml(result.verdict)}</strong><p>${escapeHtml(result.reason)}</p>`;
    appData.purchaseDecisions.push(Object.assign({ id: createId("dec"), date: todayISO(), verdict: result.verdict }, input));
    saveData(); e.target.reset(); renderDecisions();
  });

  // Export / settings.
  el("settings-form").addEventListener("submit", (e) => { e.preventDefault(); saveSettingsForm(); });
  el("save-cats-btn").addEventListener("click", saveCategories);
  el("export-json").addEventListener("click", exportFullBackup);
  el("export-cards-csv").addEventListener("click", () => exportCSV("cards"));
  el("export-debts-csv").addEventListener("click", () => exportCSV("debts"));
  el("export-subs-csv").addEventListener("click", () => exportCSV("subscriptions"));
  el("export-report-csv").addEventListener("click", () => exportCSV("report"));
  el("import-json").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) openConfirm("Importing replaces ALL current data. Continue?", () => importFullBackup(f)); e.target.value = ""; });
  el("import-pagoclaro").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) openConfirm("Merge this PagoClaro backup into your data? Existing data is kept.", () => importMigration(f, migratePagoClaroData)); e.target.value = ""; });
  el("import-javis").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) openConfirm("Merge this Javi's Finance backup into your data? Existing data is kept.", () => importMigration(f, migrateJavisFinanceData)); e.target.value = ""; });
  el("reset-data").addEventListener("click", () => openConfirm("This erases ALL data on this device and cannot be undone. Continue?", () => { resetData(); dashboardAvailableMoney = getDefaultAvailableMoney(); applyThemePreference(); hydrateAll(); toast("All data reset."); }));

  // Delegated card / debt / list actions.
  document.addEventListener("click", (e) => {
    const t = e.target;
    let id;
    const find = (attr, arr) => (id = t.getAttribute && t.getAttribute(attr)) ? arr.find((x) => x.id === id) : null;

    let card;
    if ((card = find("data-card-purchase", appData.cards))) return openCardPurchaseModal(card);
    if ((card = find("data-card-payment", appData.cards))) return openCardPaymentModal(card);
    if ((card = find("data-edit-card", appData.cards))) return openCardModal(card);
    if ((id = t.getAttribute && t.getAttribute("data-toggle-card"))) { const c = appData.cards.find((x) => x.id === id); if (c) { c.isActive = !c.isActive; saveData(); renderAll(); } return; }
    if ((id = t.getAttribute && t.getAttribute("data-del-card"))) { const c = appData.cards.find((x) => x.id === id); if (c) openConfirm(`Delete card ${c.bank}? Its ledger movements are also removed.`, () => { appData.cards = appData.cards.filter((x) => x.id !== id); appData.cardMovements = appData.cardMovements.filter((m) => m.cardId !== id); saveData(); renderAll(); toast("Card deleted."); }); return; }

    let debt;
    if ((debt = find("data-pay-debt", appData.debts))) return openDebtPaymentModal(debt);
    if ((debt = find("data-edit-debt", appData.debts))) return openDebtModal(debt);
    if ((id = t.getAttribute && t.getAttribute("data-toggle-debt"))) { const d = appData.debts.find((x) => x.id === id); if (d) { d.isActive = !d.isActive; saveData(); renderAll(); } return; }
    if ((id = t.getAttribute && t.getAttribute("data-del-debt"))) { const d = appData.debts.find((x) => x.id === id); if (d) openConfirm(`Delete debt ${d.name}?`, () => { appData.debts = appData.debts.filter((x) => x.id !== id); saveData(); renderAll(); toast("Debt deleted."); }); return; }

    let txn;
    if ((txn = find("data-edit-txn", appData.transactions))) return openTransactionModal(txn);
    if ((id = t.getAttribute && t.getAttribute("data-del-txn"))) { openConfirm("Delete this transaction?", () => { deleteTransaction(id); renderAll(); toast("Deleted."); }); return; }

    let sub;
    if ((sub = find("data-edit-sub", appData.subscriptions))) return openSubscriptionModal(sub);
    if ((id = t.getAttribute && t.getAttribute("data-del-sub"))) { openConfirm("Delete this subscription?", () => { appData.subscriptions = appData.subscriptions.filter((x) => x.id !== id); saveData(); renderAll(); toast("Deleted."); }); return; }

    let budget;
    if ((budget = find("data-edit-budget", appData.budgets))) return openBudgetModal(budget);
    if ((id = t.getAttribute && t.getAttribute("data-del-budget"))) { openConfirm("Delete this budget?", () => { appData.budgets = appData.budgets.filter((x) => x.id !== id); saveData(); renderAll(); toast("Deleted."); }); return; }

    if ((id = t.getAttribute && t.getAttribute("data-del-dec"))) { openConfirm("Delete this decision?", () => { appData.purchaseDecisions = appData.purchaseDecisions.filter((x) => x.id !== id); saveData(); renderDecisions(); toast("Deleted."); }); return; }
  });

  // Modals.
  el("confirm-cancel").addEventListener("click", closeConfirm);
  el("confirm-accept").addEventListener("click", () => { if (typeof pendingConfirm === "function") pendingConfirm(); closeConfirm(); });
  el("form-modal-close").addEventListener("click", closeFormModal);
  el("form-modal").addEventListener("click", (e) => { if (e.target === el("form-modal")) closeFormModal(); });
  el("confirm-modal").addEventListener("click", (e) => { if (e.target === el("confirm-modal")) closeConfirm(); });
}

/* ----- iOS install hint ----- */
function initInstallHint() {
  const hint = el("ios-install-hint"), dismiss = el("ios-hint-dismiss");
  if (!hint || !dismiss) return;
  const KEY = "financeHub:iosHintDismissed";
  const ua = navigator.userAgent || "";
  const isIos = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  let dismissed = false;
  try { dismissed = localStorage.getItem(KEY) === "1"; } catch (e) { /* ignore */ }
  if (isIos && !isStandalone && !dismissed) hint.classList.add("show");
  dismiss.addEventListener("click", () => { hint.classList.remove("show"); try { localStorage.setItem(KEY, "1"); } catch (e) { /* ignore */ } });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => showStorageStatus("Offline cache registration failed.", true));
  });
}

/* ----- Init ----- */
function init() {
  bindElements();
  buildMoreMenu();
  bindEvents();
  hydrateAll();
  showSection("dashboard");
  initInstallHint();
  registerServiceWorker();
}
document.addEventListener("DOMContentLoaded", init);

