// Option-chain payload normalization and strike/unit helpers.
// Pure functions — no app state.

import { toRupees } from "./format.js";

export function chainStrikeInRupees(value, chain) {
  const strike = typeof value === "string"
    ? Number(value.replace(/,/g, "").trim())
    : Number(value);
  if (!Number.isFinite(strike)) return null;

  // cp/atm are in paise, but option strikes have appeared in both units.
  // Select the representation nearest the underlying spot price.
  const spot = toRupees(chain?.cp ?? chain?.currentprice ?? chain?.current_price);
  if (Number.isFinite(spot) && spot > 0) {
    const paiseCandidate = strike / 100;
    return Math.abs(paiseCandidate - spot) < Math.abs(strike - spot)
      ? paiseCandidate
      : strike;
  }

  return Math.abs(strike) >= 100000 ? strike / 100 : strike;
}

export function normalizeOptionChainPayload(payload, fallback = {}) {
  const raw = payload?.chain ?? payload?.data?.chain ?? payload?.data ?? payload;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const firstArray = (...values) => values.find(Array.isArray) || [];
  const normalizeLeg = (leg) => ({
    ...leg,
    ref_id: leg?.ref_id ?? leg?.refId,
    inst_id: leg?.inst_id ?? leg?.instId,
    ts: leg?.ts ?? leg?.timestamp,
    sp: leg?.sp ?? leg?.strike_price ?? leg?.strikePrice ?? leg?.strike,
    ls: leg?.ls ?? leg?.lot_size ?? leg?.lotSize,
    ltp: leg?.ltp ?? leg?.last_traded_price ?? leg?.lastTradedPrice,
    ltpchg: leg?.ltpchg ?? leg?.last_traded_price_change ?? leg?.lastTradedPriceChange,
    oi: leg?.oi ?? leg?.open_interest ?? leg?.openInterest,
    previous_oi: leg?.previous_oi ?? leg?.prev_oi ?? leg?.previous_open_interest,
    volume: leg?.volume ?? leg?.vol
  });
  return {
    ...raw,
    asset: raw.asset ?? raw.underlying ?? raw.symbol ?? fallback.symbol,
    exchange: raw.exchange ?? fallback.exchange,
    expiry: String(raw.expiry ?? raw.expiry_date ?? fallback.expiry ?? ""),
    cp: raw.cp ?? raw.currentprice ?? raw.current_price ?? raw.spot_price,
    atm: raw.atm ?? raw.at_the_money_strike ?? raw.atm_strike,
    ce: firstArray(raw.ce, raw.CE, raw.calls, raw.call_options).map(normalizeLeg),
    pe: firstArray(raw.pe, raw.PE, raw.puts, raw.put_options).map(normalizeLeg),
    all_expiries: firstArray(raw.all_expiries, raw.expiries).map(String)
  };
}

export function pickOptionValue(option, keys) {
  if (!option) return undefined;
  for (const key of keys) {
    if (option[key] != null) return option[key];
  }
  return undefined;
}

// Timeseries point extraction.
export function pointMs(point) {
  const ts = Number(point?.ts ?? point?.timestamp);
  return Number.isFinite(ts) ? Math.floor(ts / 1_000_000) : null;
}

export function pointNumber(point, rupeeValue = false) {
  const raw = point?.v ?? point?.value;
  const value = rupeeValue ? toRupees(raw) : Number(raw);
  return Number.isFinite(value) ? value : 0;
}

export function extractSymbolData(data, symbol) {
  const result = data?.result?.[0]?.values || [];
  for (const entry of result) {
    if (entry[symbol]) return entry[symbol];
    const firstKey = Object.keys(entry)[0];
    if (firstKey) return entry[firstKey];
  }
  return null;
}
