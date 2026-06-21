// Number / currency formatting helpers and Intl instances.
// Pure functions — no app state. Shared across views.

export const rupee = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2
});
export const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
export const compactNumber = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 });

export function toRupees(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n / 100 : null;
}

export function formatMoney(value) {
  const n = toRupees(value);
  return n == null ? "--" : rupee.format(n);
}

export function formatStrike(value) {
  const n = Number(value);
  return Number.isFinite(n) ? number.format(n) : "--";
}

export function formatPlain(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "--";
}

export function formatCompact(value) {
  const n = Number(value);
  return Number.isFinite(n) ? compactNumber.format(n) : "--";
}

export function formatIndexValue(value) {
  const n = toRupees(value);
  return n == null ? "--" : number.format(n);
}

export function formatPercent(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(2)}%` : "--";
}

// Compact OI/GEX axis formatters used by uPlot charts.
export function fmtOICompact(v) {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `${(v / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(Math.round(v));
}

export function fmtGEX(v) {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

export function strikePx(v) { return v; }
