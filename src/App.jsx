import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import * as KDialog from "@kobalte/core/dialog";
import * as KSelect from "@kobalte/core/select";
import Highcharts from "highcharts";
import uPlot from "uplot";

// ── extracted helpers / constants / components ──
import {
  rupee, number, compactNumber, toRupees,
  formatMoney, formatStrike, formatPlain, formatCompact, formatIndexValue, formatPercent,
  fmtOICompact, fmtGEX, strikePx
} from "./lib/format.js";
import {
  isMarketHours, msUntilMarketClose, todayKey,
  toLocalInput, todayAt, dateKey, fromLocalInput, tvTime, formatIstTime
} from "./lib/datetime.js";
import {
  chainStrikeInRupees, normalizeOptionChainPayload, pickOptionValue,
  pointMs, pointNumber, extractSymbolData
} from "./lib/chain.js";
import {
  writeParquet, readParquet,
  openInstrumentDb, readInstrumentCache, writeInstrumentCache,
  digits, deviceIdForPhone
} from "./lib/storage.js";
import {
  CHAIN_COLUMNS, CALL_COLUMN_ORDER, PUT_COLUMN_ORDER, DEFAULT_CHAIN_COLUMNS,
  MARKET_STRIP_SYMBOLS, INSTRUMENT_EXCHANGES, SYMBOL_CATEGORIES,
  INSTRUMENT_DB, INSTRUMENT_STORE,
  ROLLING_INTERVALS, ROLLING_BATCH_SIZE, ROLLING_FETCH_CONCURRENCY,
  OIE_AXIS_FONT, OIE_GRID, OIE_TICK, OIE_TEXT
} from "./lib/constants.js";
import { chartThemeOptions, makeChart } from "./lib/chart.js";
import { AppProvider } from "./state/AppContext.jsx";
import { OiTimeSeriesView } from "./views/OiTimeSeriesView.jsx";
import { VolSurfaceView } from "./views/VolSurfaceView.jsx";
import { OiProfileView } from "./views/OiProfileView.jsx";
import { MaxPainView } from "./views/MaxPainView.jsx";
import { IvTermView } from "./views/IvTermView.jsx";
import { GammaView } from "./views/GammaView.jsx";
import { RollingView } from "./views/RollingView.jsx";
import { MultiSpreadView } from "./views/MultiSpreadView.jsx";
import { PremiumDecayView } from "./views/PremiumDecayView.jsx";
import { VegaAnalysisView } from "./views/VegaAnalysisView.jsx";
import { OieView } from "./views/OieView.jsx";
import { MarketView } from "./views/MarketView.jsx";
import { ChainView } from "./views/ChainView.jsx";

import "./styles.css";
import "./utilities.css";
import "./typography.css";
import "./shell.css";
import "./rolling.css";
import "./multispread.css";
import "./premiumdecay.css";
import "./vega.css";
import "./chain.css";
import "./iv-term.css";
import "./gamma.css";
import "./oie.css";
import "uplot/dist/uPlot.min.css";

const THEME_OPTIONS = [
  { key: "terminal-pro", label: "Terminal Pro" },
  { key: "ocean-blue", label: "Ocean Blue" },
  { key: "charcoal-black", label: "Charcoal Black" }
];

function normalizeTheme(value) {
  return THEME_OPTIONS.some((theme) => theme.key === value) ? value : "terminal-pro";
}

function App() {
  const now = new Date();
  const widgetMode = new URLSearchParams(window.location.search).get("view") === "widget";
  const desktopApi = window.nubraDesktop;
  const [appTheme, setAppTheme] = createSignal(normalizeTheme(localStorage.getItem("nubraAppTheme")));
  const [environment, setEnvironment] = createSignal("https://api.nubra.io");
  const [token, setToken] = createSignal(localStorage.getItem("nubraSessionToken") || "");
  const [deviceId, setDeviceId] = createSignal(localStorage.getItem("nubraDeviceId") || "");
  const [phone, setPhone] = createSignal(localStorage.getItem("nubraPhone") || "");
  const [authMethod, setAuthMethod] = createSignal(localStorage.getItem("nubraAuthMethod") || "otp");
  const [otp, setOtp] = createSignal("");
  const [mpin, setMpin] = createSignal("");
  const [flowId, setFlowId] = createSignal(sessionStorage.getItem("nubraFlowId") || "");
  const [loginStatus, setLoginStatus] = createSignal(token() ? "Session token loaded" : "Not logged in");
  const [section, setSection] = createSignal(widgetMode ? "chain" : "rolling");

  createEffect(() => {
    localStorage.setItem("nubraAppTheme", appTheme());
  });

  // ── GEX / Options Intelligence Engine state ──
  const [oieTab, setOieTab] = createSignal("intelligence"); // intelligence | analytics | signals | chain
  const [oieSymbol, setOieSymbol] = createSignal("NIFTY");
  const [oieExpiry, setOieExpiry] = createSignal("");
  const [oieExpiries, setOieExpiries] = createSignal([]);
  const [oieExpiryLoading, setOieExpiryLoading] = createSignal(false);
  const [oieData, setOieData] = createSignal(null);       // intelligence response
  const [oieAnalytics, setOieAnalytics] = createSignal(null);
  const [oieSignals, setOieSignals] = createSignal(null);
  const [oieChain, setOieChain] = createSignal(null);
  const [oieStatus, setOieStatus] = createSignal("idle"); // idle | loading | live | error
  const [oieError, setOieError] = createSignal("");
  let oieSocket = null;
  let oieLtpSocket = null;

  function oieTagRow(row) {
    const ceOi = Number(row.ce?.oi ?? row.ce?.open_interest ?? 0);
    const peOi = Number(row.pe?.oi ?? row.pe?.open_interest ?? 0);
    const cePrevOi = Number(row.ce?.previous_oi ?? row.ce?.previous_open_interest ?? 0);
    const pePrevOi = Number(row.pe?.previous_oi ?? row.pe?.previous_open_interest ?? 0);
    const ceLtp = Number(row.ce?.ltp ?? row.ce?.last_traded_price ?? 0);
    const peLtp = Number(row.pe?.ltp ?? row.pe?.last_traded_price ?? 0);
    const tag = (oi, prevOi, ltp) => {
      if (!prevOi) return null;
      const oiUp = oi > prevOi;
      const ltpUp = ltp >= 0;
      // significant when OI moved >20% vs prior — only these get highlighted
      const strong = Math.abs(oi - prevOi) / prevOi >= 0.20;
      let label;
      if (oiUp && ltpUp)  label = "LB";  // Long Buildup
      else if (oiUp && !ltpUp) label = "SB";  // Short Buildup
      else if (!oiUp && ltpUp) label = "SC";  // Short Covering
      else label = "LU";                       // Long Unwinding
      return { label, strong };
    };
    return {
      ce: tag(ceOi, cePrevOi, ceLtp),
      pe: tag(peOi, pePrevOi, peLtp)
    };
  }

  // Compute all OIE metrics locally from the already-loaded option chain data.
  // No separate backend endpoint needed — derives from chainData() + chainSymbol().
  function computeOie() {
    setOieStatus("loading");
    setOieError("");

    // Fetch the chain — first try to reuse existing chainData if symbol matches,
    // otherwise trigger a fresh chain load then recompute.
    const chain = chainData();
    const rows  = optionRows();

    if (!rows.length) {
      // No chain loaded yet — switch to chain tab and load it, then come back
      setOieError("No option chain loaded. Loading chain first…");
      // Sync the chain symbol to whatever the user picked in OIE
      setChainSymbol(oieSymbol());
      setChainExchange(oieSymbol() === "SENSEX" ? "BSE" : "NSE");
      if (oieExpiry()) setChainExpiry(oieExpiry());
      run(() => loadOptionChain().then(() => {
        computeOie();
      }).catch((err) => {
        setOieStatus("error");
        setOieError(err?.message || "Chain load failed");
      }));
      return;
    }

    try {
      // ── helpers ──────────────────────────────────────────────
      const rn  = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
      const avg = (arr) => arr.length ? arr.reduce((s,x)=>s+x,0)/arr.length : null;

    const atmRaw   = chainStrikeInRupees(chain?.atm ?? chain?.at_the_money_strike, chain);
      const spotRaw  = rn(toRupees(chain?.cp));
      const spot     = spotRaw ?? atmRaw;
      // Real per-underlying lot size from refdata (NIFTY 75, etc.); 100 fallback.
      const lotSize  = rn(chainRefMetrics().marketLot) || 100;

      // Collect per-strike data
      let totalCeOi = 0, totalPeOi = 0;
      let totalCeVol = 0, totalPeVol = 0;
      let totalGex = 0;
      const ivValues = [];
      const strikeRows = [];

      for (const row of rows) {
        const strike = rn(row.strike);
        if (!Number.isFinite(strike)) continue;

        const ceOi  = rn(row.ce?.oi ?? row.ce?.open_interest) ?? 0;
        const peOi  = rn(row.pe?.oi ?? row.pe?.open_interest) ?? 0;
        const ceVol = rn(row.ce?.volume ?? row.ce?.vol) ?? 0;
        const peVol = rn(row.pe?.volume ?? row.pe?.vol) ?? 0;
        const ceGamma = rn(row.ce?.gamma) ?? 0;
        const peGamma = rn(row.pe?.gamma) ?? 0;
        const ceIv  = rn(row.ce?.iv ?? row.ce?.IV);
        const peIv  = rn(row.pe?.iv ?? row.pe?.IV);
        const ceLtp = rn(toRupees(row.ce?.ltp ?? row.ce?.last_traded_price));
        const peLtp = rn(toRupees(row.pe?.ltp ?? row.pe?.last_traded_price));
        const ceDelta = rn(row.ce?.delta) ?? 0.5;
        const peDelta = rn(row.pe?.delta) ?? -0.5;
        const cePrevOi = rn(row.ce?.previous_oi ?? row.ce?.previous_open_interest) ?? 0;
        const pePrevOi = rn(row.pe?.previous_oi ?? row.pe?.previous_open_interest) ?? 0;

        totalCeOi  += ceOi;
        totalPeOi  += peOi;
        totalCeVol += ceVol;
        totalPeVol += peVol;

        // GEX = Γ · OI(shares) · Spot² · 0.01 (dealer gamma exposure, ₹).
        // OI is already in shares (lot baked in) — do NOT multiply by lot again.
        if (spot) {
          totalGex += (ceGamma * ceOi - peGamma * peOi) * spot * spot * 0.01;
        }

        if (ceIv != null) ivValues.push(ceIv);
        if (peIv != null) ivValues.push(peIv);

        strikeRows.push({ strike, ceOi, peOi, ceVol, peVol, ceLtp, peLtp,
          ceIv, peIv, ceDelta, peDelta, ceGamma, peGamma, cePrevOi, pePrevOi,
          ceOiChange: ceOi - cePrevOi, peOiChange: peOi - pePrevOi });
      }

      const pcr = totalCeOi > 0 ? totalPeOi / totalCeOi : null;
      const atmIv = avg(ivValues);

      // ATM row
      const atmStrike = atmRaw ?? (spot ? nearestStrike(spot * 100, rows.map(r=>rn(r.strike)).filter(Boolean), inferStrikeStep(rows.map(r=>rn(r.strike)).filter(Boolean))) : null);
      const atmRow = atmStrike != null ? strikeRows.reduce((best,r) => !best || Math.abs(r.strike-atmStrike)<Math.abs(best.strike-atmStrike) ? r : best, null) : null;
      const atmCeIv = atmRow?.ceIv ?? null;
      const atmPeIv = atmRow?.peIv ?? null;
      const ivSkew  = (atmCeIv != null && atmPeIv != null) ? atmCeIv - atmPeIv : null;

      // Max pain — strike with lowest total option payout
      let maxPainStrike = null;
      let minPain = Infinity;
      for (const r of strikeRows) {
        const pain = strikeRows.reduce((s,x) => s + Math.max(0,(x.strike-r.strike))*x.ceOi + Math.max(0,(r.strike-x.strike))*x.peOi, 0);
        if (pain < minPain) { minPain = pain; maxPainStrike = r.strike; }
      }

      // Call/Put walls = strike with highest OI
      const callWall = strikeRows.reduce((best,r) => r.ceOi > (best?.ceOi??0) ? r : best, null)?.strike ?? null;
      const putWall  = strikeRows.reduce((best,r) => r.peOi > (best?.peOi??0) ? r : best, null)?.strike ?? null;

      // Gamma regime. gexBn = total GEX in Crore (₹·1e7). Thresholds scaled to the
      // real NIFTY net-GEX magnitude (single-digit-thousands of Crore).
      const gexBn = totalGex / 1e7; // value in Crore
      const gammaRegime = gexBn > 2000 ? "Compressed (Positive GEX)" : gexBn < -2000 ? "Amplifying (Negative GEX)" : "Neutral";

      // Expected move (1-sigma, simplified)
      const expectedMovePct = atmIv != null ? +(atmIv / Math.sqrt(252) * 100).toFixed(2) : null;

      // OI momentum — net OI change
      const totalCeOiChg = strikeRows.reduce((s,r)=>s+r.ceOiChange,0);
      const totalPeOiChg = strikeRows.reduce((s,r)=>s+r.peOiChange,0);
      const oiMomentum = totalCeOiChg + totalPeOiChg;

      // Dealer positioning
      const dealerPositioning = gexBn > 1000 ? "Stabilising" : gexBn < -1000 ? "Amplifying" : "Neutral";

      // Market bias
      let bullScore = 0, bearScore = 0;
      const signals = [];

      // PCR signal
      if (pcr != null) {
        if (pcr > 1.3)      { bullScore += 3; signals.push({ direction:"Bullish", category:"OI",   name:"PCR Bullish (>1.3)",    strength: Math.min(10, Math.round(pcr*2)) }); }
        else if (pcr < 0.7) { bearScore += 3; signals.push({ direction:"Bearish", category:"OI",   name:"PCR Bearish (<0.7)",    strength: Math.min(10, Math.round((1/pcr)*2)) }); }
        else                {                  signals.push({ direction:"Neutral", category:"OI",   name:"PCR Neutral (0.7–1.3)", strength: 3 }); }
      }

      // GEX signal (threshold in Crore; strength scaled to the crore magnitude)
      if (gexBn > 2000)       { bullScore += 2; signals.push({ direction:"Bullish", category:"GEX",  name:"Positive GEX (Pinning)", strength: Math.min(10, Math.round(gexBn / 1500)) || 1 }); }
      else if (gexBn < -2000) { bearScore += 2; signals.push({ direction:"Bearish", category:"GEX",  name:"Negative GEX (Volatile)",strength: Math.min(10, Math.round(-gexBn / 1500)) || 1 }); }

      // IV skew signal
      if (ivSkew != null) {
        if (ivSkew > 2)      { bearScore += 2; signals.push({ direction:"Bearish", category:"VOL",  name:"Call IV > Put IV (Skew)", strength: Math.min(10, Math.round(ivSkew)) }); }
        else if (ivSkew < -2){ bullScore += 2; signals.push({ direction:"Bullish", category:"VOL",  name:"Put IV > Call IV (Skew)", strength: Math.min(10, Math.round(-ivSkew)) }); }
      }

      // OI momentum signal
      if (oiMomentum > 0)  { bullScore += 1; signals.push({ direction:"Bullish", category:"OI", name:"Net OI Buildup", strength: 4 }); }
      else if (oiMomentum < 0) { bearScore += 1; signals.push({ direction:"Bearish", category:"OI", name:"Net OI Unwinding", strength: 4 }); }

      // Spot vs max pain
      if (maxPainStrike && spot) {
        if (spot > maxPainStrike * 1.005) { bearScore += 1; signals.push({ direction:"Bearish", category:"COMP", name:"Spot Above Max Pain", strength: 3 }); }
        else if (spot < maxPainStrike * 0.995) { bullScore += 1; signals.push({ direction:"Bullish", category:"COMP", name:"Spot Below Max Pain", strength: 3 }); }
      }

      const totalScore = bullScore + bearScore || 1;
      const biasMap = { Bullish: bullScore > bearScore, Bearish: bearScore > bullScore };
      const biasPct = Math.round((Math.max(bullScore,bearScore)/totalScore)*100);
      const bias = bullScore > bearScore ? "Bullish" : bearScore > bullScore ? "Bearish" : "Neutral";
      const sellerEdge = atmIv != null ? (atmIv > 20 ? "Favourable (High IV)" : atmIv < 12 ? "Unfavourable (Low IV)" : "Moderate") : "—";

      // ── Build OIE data objects ──────────────────────────────
      setOieData({
        market_bias: bias,
        confidence_score: biasPct,
        spot_price: spot,
        gamma_regime: gammaRegime,
        volatility_regime: atmIv != null ? (atmIv > 22 ? "High Volatility" : atmIv < 12 ? "Low Volatility" : "Normal") : "—",
        dealer_positioning: dealerPositioning,
        expected_move_daily: expectedMovePct,
        option_seller_favorability: sellerEdge,
        metric_summary: { pcr: pcr != null ? +pcr.toFixed(2) : null, atm_iv: atmIv != null ? +atmIv.toFixed(2) : null, iv_rank: null }
      });

      setOieAnalytics({
        metrics: {
          pcr: pcr != null ? +pcr.toFixed(2) : null,
          oi_momentum: oiMomentum > 0 ? "Buildup" : "Unwinding",
          call_wall: callWall,
          put_wall: putWall,
          max_pain: maxPainStrike,
          atm_iv: atmIv != null ? +atmIv.toFixed(2) : null,
          iv_skew: ivSkew != null ? +ivSkew.toFixed(2) : null,
          vol_regime: atmIv != null ? (atmIv > 22 ? "High" : atmIv < 12 ? "Low" : "Normal") : null,
          gex: totalGex != null ? fmtGEX(totalGex / 1e7) : null,
          gamma_regime: gammaRegime,
          gamma_flip: atmStrike,
          dealer_positioning: dealerPositioning,
          expected_move: expectedMovePct != null ? expectedMovePct+"%" : null,
          total_ce_oi: formatCompact(totalCeOi),
          total_pe_oi: formatCompact(totalPeOi),
          ce_volume: formatCompact(totalCeVol),
          pe_volume: formatCompact(totalPeVol),
        }
      });

      setOieSignals({
        bullish_score: Math.round((bullScore/totalScore)*100),
        bearish_score: Math.round((bearScore/totalScore)*100),
        signals
      });

      // OIE chain — map from existing rows
      setOieChain({
        underlying: chainSymbol(),
        spot_price: spot,
        atm_strike: atmStrike,
        strikes: strikeRows.map(r => ({
          strike_price: r.strike,
          ce_ltp:      r.ceLtp,
          ce_iv:       r.ceIv,
          ce_delta:    r.ceDelta,
          ce_gamma:    r.ceGamma,
          ce_oi:       r.ceOi,
          ce_oi_change:r.ceOiChange,
          pe_ltp:      r.peLtp,
          pe_iv:       r.peIv,
          pe_delta:    r.peDelta,
          pe_gamma:    r.peGamma,
          pe_oi:       r.peOi,
          pe_oi_change:r.peOiChange,
        }))
      });

      setOieStatus("live");
      setOieError("");
    } catch (err) {
      setOieStatus("error");
      setOieError(err?.message || "Compute failed");
    }
  }

  async function loadOieExpiries(sym) {
    if (!authed()) return;
    setOieExpiryLoading(true);
    setOieExpiries([]);
    setOieExpiry("");
    try {
      const exchange = sym === "SENSEX" ? "BSE" : "NSE";
      setChainSymbol(sym);
      setChainExchange(exchange);
      const expiries = await loadOptionChainExpiries();
      setOieExpiries(expiries);
      if (expiries.length) setOieExpiry(expiries[0]);
    } catch (err) {
      setOieError(err?.message || "Failed to load expiries");
    } finally {
      setOieExpiryLoading(false);
    }
  }

  function loadOie() {
    const sym = oieSymbol();
    const symbolChanged = chainSymbol() !== sym || chainData()?.asset?.toUpperCase() !== sym;
    setChainSymbol(sym);
    setChainExchange(sym === "SENSEX" ? "BSE" : "NSE");
    if (oieExpiry()) setChainExpiry(oieExpiry());

    if (!optionRows().length || symbolChanged) {
      setOieStatus("loading");
      setOieError("");
      run(() => loadOptionChain().then(() => {
        // sync back the expiries the chain returned
        if (chainExpiries().length) setOieExpiries(chainExpiries());
        if (chainExpiry()) setOieExpiry(chainExpiry());
        return computeOie();
      }).catch(err => {
        setOieStatus("error");
        setOieError(err?.message || "Chain load failed");
      }));
    } else {
      computeOie();
    }
  }
  const [busy, setBusy] = createSignal(false);
  const [toast, setToast] = createSignal("");
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const [mainHelpOpen, setMainHelpOpen] = createSignal(false);
  const [chainNavOpen, setChainNavOpen] = createSignal(false);
  const [labNavOpen, setLabNavOpen] = createSignal(false);
  const [controlCenterOpen, setControlCenterOpen] = createSignal(false);
  const [headerCompact, setHeaderCompact] = createSignal(false);
  const [leftSettingsCollapsed, setLeftSettingsCollapsed] = createSignal({
    rolling: false,
    premiumdecay: false,
    vega: false
  });
  const [rollSeriesVisibility, setRollSeriesVisibility] = createSignal({
    bid: localStorage.getItem("nubraRollSeriesBid") !== "0",
    ask: localStorage.getItem("nubraRollSeriesAsk") !== "0",
    iv: localStorage.getItem("nubraRollSeriesIv") !== "0",
    avg: localStorage.getItem("nubraRollSeriesAvg") !== "0"
  });
  const [widgetMaximized, setWidgetMaximized] = createSignal(false);
  const [marketStrip, setMarketStrip] = createSignal(MARKET_STRIP_SYMBOLS.map((item) => ({
    ...item,
    price: null,
    change: null,
    ok: false
  })));
  const [marketStripStatus, setMarketStripStatus] = createSignal("Waiting for session");
  const [scriptExchange, setScriptExchange] = createSignal(localStorage.getItem("nubraScriptExchange") || "NSE");
  const [scriptUnderlying, setScriptUnderlying] = createSignal(localStorage.getItem("nubraScriptUnderlying") || "");
  const [scriptCache, setScriptCache] = createSignal({ date: "", exchange: "", rows: [], downloadedAt: "" });
  const [indexMasterRows, setIndexMasterRows] = createSignal([]);
  const [scriptStatus, setScriptStatus] = createSignal("Login to download scripts");
  const [symbolSearchOpen, setSymbolSearchOpen] = createSignal(false);
  const [symbolSearchText, setSymbolSearchText] = createSignal("");
  const [symbolSearchCategory, setSymbolSearchCategory] = createSignal("all");

  const [symbol, setSymbol] = createSignal("NIFTY");
  const [instrumentType, setInstrumentType] = createSignal("INDEX");
  const [exchange, setExchange] = createSignal("NSE");
  const [interval, setIntervalValue] = createSignal("1m");
  const [startDate, setStartDate] = createSignal(toLocalInput(new Date(now.getTime() - 6 * 60 * 60 * 1000)));
  const [endDate, setEndDate] = createSignal(toLocalInput(now));
  const [spot, setSpot] = createSignal("--");
  const [change, setChange] = createSignal("--");
  const [chartStatus, setChartStatus] = createSignal("Idle");
  const [candleCount, setCandleCount] = createSignal(0);

  const [rollSymbol, setRollSymbol] = createSignal("NIFTY");
  const [rollType, setRollType] = createSignal("INDEX");
  const [rollExchange, setRollExchange] = createSignal("NSE");
  const [rollExpiry, setRollExpiry] = createSignal("");
  const [rollExpiries, setRollExpiries] = createSignal([]);
  const [rollStart, setRollStart] = createSignal(toLocalInput(todayAt(9, 15)));
  const [rollEnd, setRollEnd] = createSignal(toLocalInput(todayAt(15, 30)));
  // ── Straddle Monitor Engine ──
  const [straddleMonitor, setStraddleMonitor] = createSignal(false);
  const [straddleAlerts, setStraddleAlerts] = createSignal([]);
  let monitorState = null;

  function resetMonitorState() {
    monitorState = {
      sessionLowMid: Infinity,
      sessionLowIv: Infinity,
      lastAlertMid: 0,
      lastAlertIv: 0,
      stallStart: null,
      stallMid: null,
      stallThreshold: 2,
      stallMinutes: 5,
      bounceThreshold: 3,
      cooldownMs: 60000,
      lastNewLowTs: 0,
      lastStallTs: 0,
      lastBounceTs: 0,
    };
  }

  function sendAlert(title, body) {
    const ts = Date.now();
    setStraddleAlerts((prev) => [{ title, body, ts }, ...prev].slice(0, 50));
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body, silent: false });
    } else if (typeof Notification !== "undefined" && Notification.permission !== "denied") {
      Notification.requestPermission().then((p) => { if (p === "granted") new Notification(title, { body, silent: false }); });
    }
    if (window.electronAPI?.notify) window.electronAPI.notify(title, body);
  }

  function checkStraddleAlerts(mid, ivMid) {
    if (!monitorState || !straddleMonitor()) return;
    const now = Date.now();

    // New session low — straddle mid
    if (mid < monitorState.sessionLowMid) {
      monitorState.sessionLowMid = mid;
      if (now - monitorState.lastNewLowTs > monitorState.cooldownMs) {
        monitorState.lastNewLowTs = now;
        sendAlert("New Straddle Low", `Straddle mid hit new low: ₹${mid.toFixed(2)}`);
      }
    }

    // New session low — IV
    if (ivMid != null && Number.isFinite(ivMid) && ivMid < monitorState.sessionLowIv) {
      monitorState.sessionLowIv = ivMid;
      if (now - monitorState.lastAlertIv > monitorState.cooldownMs) {
        monitorState.lastAlertIv = now;
        sendAlert("New IV Low", `IV mid hit new low: ${ivMid.toFixed(2)}%`);
      }
    }

    // Stall detection — mid barely moves for N minutes
    if (monitorState.stallMid == null) {
      monitorState.stallMid = mid;
      monitorState.stallStart = now;
    } else if (Math.abs(mid - monitorState.stallMid) > monitorState.stallThreshold) {
      monitorState.stallMid = mid;
      monitorState.stallStart = now;
    } else if (now - monitorState.stallStart > monitorState.stallMinutes * 60000) {
      if (now - monitorState.lastStallTs > monitorState.cooldownMs * 3) {
        monitorState.lastStallTs = now;
        sendAlert("Straddle Stall", `Straddle stuck near ₹${mid.toFixed(2)} for ${monitorState.stallMinutes}+ min`);
      }
      monitorState.stallStart = now;
    }

    // Bounce off low
    if (mid - monitorState.sessionLowMid >= monitorState.bounceThreshold) {
      if (now - monitorState.lastBounceTs > monitorState.cooldownMs * 2) {
        monitorState.lastBounceTs = now;
        const pts = (mid - monitorState.sessionLowMid).toFixed(2);
        sendAlert("Straddle Bounce", `Straddle bounced ₹${pts} off low (₹${monitorState.sessionLowMid.toFixed(2)} → ₹${mid.toFixed(2)})`);
      }
    }
  }

  // ── Spot Monitor Engine ──
  const [spotMonitor, setSpotMonitor] = createSignal(false);
  const [spotAlerts, setSpotAlerts] = createSignal([]);
  let spotMonitorState = null;

  function resetSpotMonitor() {
    spotMonitorState = {
      byIndex: new Map(),   // indexName → { priceHistory:[{p,ts}], gapFired, rangeBoundCheckTimer }
      lastAlertTs: {},
      cooldownMs: 90000,    // 90 s cooldown per alert key
      // Speed alert: move > speedPct% within speedWindowSec seconds
      speedPct: 0.18,       // 0.18% ~ 43 pts on NIFTY@24000, 94 pts on BANKNIFTY@52000
      speedWindowSec: 60,
      // Range-bound: high-low range < rangePct% for rangeMins minutes
      rangePct: 0.10,
      rangeMins: 5,
      // Gap: open gap vs prevClose > gapPct%
      gapPct: 0.25,
    };
  }

  function sendSpotAlert(key, title, body) {
    const now = Date.now();
    if (!spotMonitorState) return;
    const last = spotMonitorState.lastAlertTs[key] || 0;
    if (now - last < spotMonitorState.cooldownMs) return;
    spotMonitorState.lastAlertTs[key] = now;
    setSpotAlerts((prev) => [{ title, body, ts: now }, ...prev].slice(0, 60));
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body, silent: false });
    } else if (typeof Notification !== "undefined" && Notification.permission !== "denied") {
      Notification.requestPermission().then((p) => { if (p === "granted") new Notification(title, { body, silent: false }); });
    }
  }

  function analyzeSpotTick(indexName, price, prevClose) {
    if (!spotMonitor() || !spotMonitorState) return;
    const p = Number(price);
    const pc = Number(prevClose);
    if (!Number.isFinite(p) || p <= 0) return;
    const now = Date.now();

    // Lazily init per-index state
    if (!spotMonitorState.byIndex.has(indexName)) {
      spotMonitorState.byIndex.set(indexName, { priceHistory: [], gapFired: false });
    }
    const st = spotMonitorState.byIndex.get(indexName);

    // ── Gap from previous close ─────────────────────────────────
    // Only fire within first 30 min of market open (09:15–09:45 IST)
    if (!st.gapFired && Number.isFinite(pc) && pc > 0) {
      const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
      const minutesSinceOpen = (ist.getHours() - 9) * 60 + (ist.getMinutes() - 15);
      if (minutesSinceOpen >= 0 && minutesSinceOpen <= 30) {
        const gapPct = ((p - pc) / pc) * 100;
        if (Math.abs(gapPct) >= spotMonitorState.gapPct) {
          const dir = gapPct > 0 ? "Gap Up" : "Gap Down";
          const pts = Math.abs(p - pc).toFixed(0);
          sendSpotAlert(`gap-${indexName}`,
            `${indexName} ${dir}: ${gapPct > 0 ? "+" : ""}${gapPct.toFixed(2)}%`,
            `Open ${p.toFixed(0)} vs prev close ${pc.toFixed(0)} (${gapPct > 0 ? "+" : ""}${pts} pts)`
          );
          st.gapFired = true;
        } else {
          st.gapFired = true; // gap too small — mark fired so we don't re-check
        }
      }
    }

    // Append to rolling price history, keep last 15 min
    st.priceHistory.push({ p, ts: now });
    const cutoff15m = now - 15 * 60 * 1000;
    while (st.priceHistory.length > 1 && st.priceHistory[0].ts < cutoff15m) st.priceHistory.shift();

    // ── Speed alert ──────────────────────────────────────────────
    // Find oldest price within speedWindowSec and compare
    const speedCutoff = now - spotMonitorState.speedWindowSec * 1000;
    const oldest = st.priceHistory.find((e) => e.ts >= speedCutoff);
    if (oldest && oldest.p > 0) {
      const movePct = Math.abs((p - oldest.p) / oldest.p) * 100;
      const movePts = Math.abs(p - oldest.p);
      if (movePct >= spotMonitorState.speedPct) {
        const dir = p > oldest.p ? "▲" : "▼";
        const secs = Math.round((now - oldest.ts) / 1000);
        sendSpotAlert(`speed-${indexName}`,
          `${indexName} Speed Alert ${dir} ${movePts.toFixed(0)} pts`,
          `Moved ${movePts.toFixed(0)} pts (${movePct.toFixed(2)}%) in ${secs}s  |  ${oldest.p.toFixed(0)} → ${p.toFixed(0)}`
        );
      }
    }

    // ── Range-bound alert ────────────────────────────────────────
    // Look at last rangeMins minutes — if high-low < rangePct%, it's trapped
    const rangeCutoff = now - spotMonitorState.rangeMins * 60 * 1000;
    const recentPrices = st.priceHistory.filter((e) => e.ts >= rangeCutoff);
    if (recentPrices.length >= 5) {
      const lo = Math.min(...recentPrices.map((e) => e.p));
      const hi = Math.max(...recentPrices.map((e) => e.p));
      const rangePct = ((hi - lo) / lo) * 100;
      const spanMins = Math.round((now - recentPrices[0].ts) / 60000);
      if (rangePct < spotMonitorState.rangePct && spanMins >= spotMonitorState.rangeMins) {
        const pts = (hi - lo).toFixed(0);
        sendSpotAlert(`range-${indexName}`,
          `${indexName} Range Bound — ${pts} pt range`,
          `Stuck between ${lo.toFixed(0)}–${hi.toFixed(0)} for ${spanMins} min (${rangePct.toFixed(2)}% range)`
        );
      }
    }
  }

  // ── Chain Monitor Engine ──
  const [chainMonitor, setChainMonitor] = createSignal(false);
  const [chainAlerts, setChainAlerts] = createSignal([]);
  let chainMonitorState = null;

  function resetChainMonitor() {
    chainMonitorState = {
      prevOiByStrike: new Map(),    // "sp|side" → oi
      prevIvByStrike: new Map(),    // "sp|side" → iv
      prevLtpByStrike: new Map(),   // "sp|side" → ltp
      prevTotalCeOi: 0,
      prevTotalPeOi: 0,
      prevAtm: null,
      prevCallWall: null,
      prevPutWall: null,
      prevAtmStraddleOi: 0,
      prevAtmIvSkew: null,
      tickCount: 0,
      cooldownMs: 45000,
      lastAlertTs: {},
      oiChangeThresholdPct: 8,    // % OI change to flag
      oiAbsSpikeThreshold: 50000, // absolute OI units to flag regardless of %
      pcrShiftThreshold: 0.08,
      atmRange: 5,                // ATM ± 5 strikes
      atmStraddleSpikeThreshold: 12, // % spike in ATM straddle OI
      ivSkewShiftThreshold: 1.5,  // pp shift in CE-PE IV skew at ATM
    };
  }

  function sendChainAlert(key, title, body) {
    const now = Date.now();
    if (!chainMonitorState) return;
    const last = chainMonitorState.lastAlertTs[key] || 0;
    if (now - last < chainMonitorState.cooldownMs) return;
    chainMonitorState.lastAlertTs[key] = now;
    setChainAlerts((prev) => [{ title, body, ts: now }, ...prev].slice(0, 80));
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body, silent: false });
    } else if (typeof Notification !== "undefined" && Notification.permission !== "denied") {
      Notification.requestPermission().then((p) => { if (p === "granted") new Notification(title, { body, silent: false }); });
    }
  }

  function analyzeChainTick(chain) {
    if (!chainMonitor() || !chainMonitorState || !chain) return;
    const ce = Array.isArray(chain.ce) ? chain.ce : [];
    const pe = Array.isArray(chain.pe) ? chain.pe : [];
    if (!ce.length && !pe.length) return;

    const rn = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const fmt = (v) => {
      if (v >= 10000000) return `${(v / 10000000).toFixed(2)}Cr`;
      if (v >= 100000) return `${(v / 100000).toFixed(1)}L`;
      if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
      return String(Math.round(v));
    };
    const fmtStrike = (sp) => chainStrikeInRupees(sp, chain) ?? number.format(sp);

    // ── Spot & ATM ──────────────────────────────────────────────
    const spot = rn(toRupees(chain.current_price ?? chain.cp)) ?? chainMonitorState.prevSpot;
    if (spot && spot > 0) chainMonitorState.prevSpot = spot;

    const allStrikes = [...new Set([...ce, ...pe]
      .map((l) => rn(l.sp ?? l.strike_price ?? l.strike))
      .filter(Boolean)
    )].sort((a, b) => a - b);

    const step = allStrikes.length >= 2
      ? allStrikes.reduce((mn, s, i) => i > 0 ? Math.min(mn, s - allStrikes[i - 1]) : mn, Infinity)
      : 50;

    const atm = spot && allStrikes.length
      ? allStrikes.reduce((best, s) => Math.abs(s - spot) < Math.abs(best - spot) ? s : best, allStrikes[0])
      : null;

    // Near-ATM set: ATM ± atmRange strikes
    const nearAtmSet = new Set();
    if (atm) {
      for (let i = -chainMonitorState.atmRange; i <= chainMonitorState.atmRange; i++) {
        nearAtmSet.add(atm + i * step);
      }
    }

    // ── Per-strike snapshot ──────────────────────────────────────
    const strikeData = [];
    for (const leg of ce) {
      const sp = rn(leg.sp ?? leg.strike_price ?? leg.strike);
      if (!sp) continue;
      const key = `${sp}|CE`;
      const oi  = rn(leg.oi ?? leg.open_interest) ?? 0;
      const iv  = rn(leg.iv ?? leg.IV ?? leg.implied_volatility);
      const ltp = rn(toRupees(leg.ltp ?? leg.last_traded_price));
      strikeData.push({ sp, side: "CE", key, oi, iv, ltp,
        prevOi:  chainMonitorState.prevOiByStrike.get(key) ?? null,
        prevIv:  chainMonitorState.prevIvByStrike.get(key) ?? null,
        prevLtp: chainMonitorState.prevLtpByStrike.get(key) ?? null });
      chainMonitorState.prevOiByStrike.set(key, oi);
      if (iv  != null) chainMonitorState.prevIvByStrike.set(key, iv);
      if (ltp != null) chainMonitorState.prevLtpByStrike.set(key, ltp);
    }
    for (const leg of pe) {
      const sp = rn(leg.sp ?? leg.strike_price ?? leg.strike);
      if (!sp) continue;
      const key = `${sp}|PE`;
      const oi  = rn(leg.oi ?? leg.open_interest) ?? 0;
      const iv  = rn(leg.iv ?? leg.IV ?? leg.implied_volatility);
      const ltp = rn(toRupees(leg.ltp ?? leg.last_traded_price));
      strikeData.push({ sp, side: "PE", key, oi, iv, ltp,
        prevOi:  chainMonitorState.prevOiByStrike.get(key) ?? null,
        prevIv:  chainMonitorState.prevIvByStrike.get(key) ?? null,
        prevLtp: chainMonitorState.prevLtpByStrike.get(key) ?? null });
      chainMonitorState.prevOiByStrike.set(key, oi);
      if (iv  != null) chainMonitorState.prevIvByStrike.set(key, iv);
      if (ltp != null) chainMonitorState.prevLtpByStrike.set(key, ltp);
    }

    // Warm-up: collect baseline for first 3 ticks, don't alert
    chainMonitorState.tickCount += 1;
    if (chainMonitorState.tickCount < 3) {
      chainMonitorState.prevAtm = atm;
      chainMonitorState.prevTotalCeOi = ce.reduce((s, l) => s + (rn(l.oi ?? l.open_interest) ?? 0), 0);
      chainMonitorState.prevTotalPeOi = pe.reduce((s, l) => s + (rn(l.oi ?? l.open_interest) ?? 0), 0);
      return;
    }

    // ── ATM strike shift ─────────────────────────────────────────
    if (atm && chainMonitorState.prevAtm && atm !== chainMonitorState.prevAtm) {
      const dist = spot ? `Spot ${rupee.format(spot)}` : "";
      sendChainAlert("atm-shift",
        `ATM Shifted → ${fmtStrike(atm)}`,
        `${fmtStrike(chainMonitorState.prevAtm)} → ${fmtStrike(atm)}${dist ? "  (" + dist + ")" : ""}`
      );
    }

    // ── Per-strike OI + IV + LTP analysis (near ATM only) ────────
    const alerts = [];
    for (const d of strikeData) {
      if (!nearAtmSet.has(d.sp)) continue;
      if (d.prevOi === null || d.prevOi <= 0 || d.oi <= 0) continue;

      const oiChgPct = ((d.oi - d.prevOi) / d.prevOi) * 100;
      const oiChgAbs = d.oi - d.prevOi;
      const oiSignificant = Math.abs(oiChgPct) >= chainMonitorState.oiChangeThresholdPct
                         || Math.abs(oiChgAbs) >= chainMonitorState.oiAbsSpikeThreshold;
      if (!oiSignificant) continue;

      const oiDir  = d.oi > d.prevOi ? "up" : "down";
      const ltpDir = (d.ltp != null && d.prevLtp != null)
        ? (d.ltp > d.prevLtp ? "up" : d.ltp < d.prevLtp ? "down" : "flat") : null;
      const ivDir  = (d.iv != null && d.prevIv != null)
        ? (d.iv > d.prevIv ? "up" : d.iv < d.prevIv ? "down" : "flat") : null;

      // OI interpretation using LTP direction
      let oiSignal = null;
      if (ltpDir && ltpDir !== "flat") {
        if      (oiDir === "up"   && ltpDir === "up")   oiSignal = "Long Buildup";
        else if (oiDir === "up"   && ltpDir === "down")  oiSignal = "Short Buildup";
        else if (oiDir === "down" && ltpDir === "up")    oiSignal = "Short Covering";
        else if (oiDir === "down" && ltpDir === "down")  oiSignal = "Long Unwinding";
      }

      // IV alignment with OI direction
      let ivSignal = null;
      if (ivDir && ivDir !== "flat") {
        if      (oiDir === "up"   && ivDir === "up")    ivSignal = `IV↑${d.iv != null ? " " + d.iv.toFixed(1) + "%" : ""} confirms demand`;
        else if (oiDir === "up"   && ivDir === "down")  ivSignal = `IV↓${d.iv != null ? " " + d.iv.toFixed(1) + "%" : ""} = writing/selling pressure`;
        else if (oiDir === "down" && ivDir === "up")    ivSignal = `IV↑${d.iv != null ? " " + d.iv.toFixed(1) + "%" : ""} = short covering`;
        else if (oiDir === "down" && ivDir === "down")  ivSignal = `IV↓${d.iv != null ? " " + d.iv.toFixed(1) + "%" : ""} = longs exiting`;
      }

      const distStrikes = atm ? Math.round(Math.abs(d.sp - atm) / step) : null;
      const atmTag = distStrikes === 0 ? "ATM" : distStrikes != null ? `ATM${d.sp > atm ? "+" : "-"}${distStrikes}` : "";

      alerts.push({ ...d, oiChgPct, oiChgAbs, oiDir, ltpDir, ivDir, oiSignal, ivSignal, atmTag, distStrikes });
    }

    // Fire top-3 near-ATM OI alerts, sorted by abs % change
    alerts.sort((a, b) => Math.abs(b.oiChgPct) - Math.abs(a.oiChgPct));
    for (const c of alerts.slice(0, 3)) {
      const action = c.oiDir === "up" ? "OI Added" : "OI Unwound";
      const title = `${action}: ${c.atmTag ? c.atmTag + " " : ""}${fmtStrike(c.sp)} ${c.side}`;
      const parts = [
        `${c.oiChgPct > 0 ? "+" : ""}${c.oiChgPct.toFixed(1)}% (${fmt(c.prevOi)} → ${fmt(c.oi)})`,
        c.oiSignal,
        c.ivSignal,
      ].filter(Boolean);
      sendChainAlert(`oi-${c.sp}-${c.side}`, title, parts.join(" · "));
    }

    // ── Totals ────────────────────────────────────────────────────
    let totalCeOi = 0, totalPeOi = 0;
    let maxCeStrike = null, maxCeOi = 0;
    let maxPeStrike = null, maxPeOi = 0;
    for (const leg of ce) {
      const sp = rn(leg.sp ?? leg.strike_price ?? leg.strike);
      const oi = rn(leg.oi ?? leg.open_interest) ?? 0;
      totalCeOi += oi;
      if (oi > maxCeOi) { maxCeOi = oi; maxCeStrike = sp; }
    }
    for (const leg of pe) {
      const sp = rn(leg.sp ?? leg.strike_price ?? leg.strike);
      const oi = rn(leg.oi ?? leg.open_interest) ?? 0;
      totalPeOi += oi;
      if (oi > maxPeOi) { maxPeOi = oi; maxPeStrike = sp; }
    }

    // ── Call Wall / Put Wall shift ────────────────────────────────
    if (maxCeStrike && chainMonitorState.prevCallWall && maxCeStrike !== chainMonitorState.prevCallWall) {
      sendChainAlert("call-wall-shift",
        `Call Wall Shifted → ${fmtStrike(maxCeStrike)}`,
        `${fmtStrike(chainMonitorState.prevCallWall)} → ${fmtStrike(maxCeStrike)} · Max CE OI: ${fmt(maxCeOi)}`
      );
    }
    if (maxPeStrike && chainMonitorState.prevPutWall && maxPeStrike !== chainMonitorState.prevPutWall) {
      sendChainAlert("put-wall-shift",
        `Put Wall Shifted → ${fmtStrike(maxPeStrike)}`,
        `${fmtStrike(chainMonitorState.prevPutWall)} → ${fmtStrike(maxPeStrike)} · Max PE OI: ${fmt(maxPeOi)}`
      );
    }

    // ── PCR shift ─────────────────────────────────────────────────
    if (totalCeOi > 0 && chainMonitorState.prevTotalCeOi > 0) {
      const pcr = totalPeOi / totalCeOi;
      const prevPcr = chainMonitorState.prevTotalPeOi / chainMonitorState.prevTotalCeOi;
      const pcrShift = pcr - prevPcr;
      if (Math.abs(pcrShift) >= chainMonitorState.pcrShiftThreshold) {
        const dir = pcrShift > 0 ? "Bullish (PE/CE↑)" : "Bearish (PE/CE↓)";
        sendChainAlert("pcr-shift",
          `PCR Shift: ${dir}`,
          `PCR ${prevPcr.toFixed(2)} → ${pcr.toFixed(2)} · PE: ${fmt(totalPeOi)}, CE: ${fmt(totalCeOi)}`
        );
      }
    }

    // ── ATM straddle OI spike ─────────────────────────────────────
    if (atm) {
      const atmCeOi = rn(ce.find((l) => rn(l.sp ?? l.strike_price ?? l.strike) === atm)?.oi ?? ce.find((l) => rn(l.sp ?? l.strike_price ?? l.strike) === atm)?.open_interest) ?? 0;
      const atmPeOi = rn(pe.find((l) => rn(l.sp ?? l.strike_price ?? l.strike) === atm)?.oi ?? pe.find((l) => rn(l.sp ?? l.strike_price ?? l.strike) === atm)?.open_interest) ?? 0;
      const atmStraddleOi = atmCeOi + atmPeOi;
      const prev = chainMonitorState.prevAtmStraddleOi;
      if (prev > 0 && atmStraddleOi > 0) {
        const spikePct = ((atmStraddleOi - prev) / prev) * 100;
        if (spikePct >= chainMonitorState.atmStraddleSpikeThreshold) {
          sendChainAlert(`atm-straddle-spike-${atm}`,
            `ATM Straddle OI Spike: ${fmtStrike(atm)}`,
            `+${spikePct.toFixed(1)}% combined CE+PE OI at ATM (${fmt(prev)} → ${fmt(atmStraddleOi)})`
          );
        }
      }
      chainMonitorState.prevAtmStraddleOi = atmStraddleOi;

      // ── IV skew shift at ATM ──────────────────────────────────
      const atmCeLeg = ce.find((l) => rn(l.sp ?? l.strike_price ?? l.strike) === atm);
      const atmPeLeg = pe.find((l) => rn(l.sp ?? l.strike_price ?? l.strike) === atm);
      const ceIv = rn(atmCeLeg?.iv ?? atmCeLeg?.IV ?? atmCeLeg?.implied_volatility);
      const peIv = rn(atmPeLeg?.iv ?? atmPeLeg?.IV ?? atmPeLeg?.implied_volatility);
      if (ceIv != null && peIv != null) {
        const skew = ceIv - peIv;
        const prevSkew = chainMonitorState.prevAtmIvSkew;
        if (prevSkew != null && Math.abs(skew - prevSkew) >= chainMonitorState.ivSkewShiftThreshold) {
          const dir = skew > prevSkew ? "CE IV rising vs PE (bearish skew)" : "PE IV rising vs CE (bullish skew)";
          sendChainAlert("iv-skew-shift",
            `IV Skew Shift at ATM ${fmtStrike(atm)}`,
            `CE IV ${ceIv.toFixed(1)}% vs PE IV ${peIv.toFixed(1)}% · Skew ${skew > 0 ? "+" : ""}${skew.toFixed(1)}pp · ${dir}`
          );
        }
        chainMonitorState.prevAtmIvSkew = skew;
      }
    }

    // ── Persist state ─────────────────────────────────────────────
    chainMonitorState.prevAtm = atm;
    chainMonitorState.prevCallWall = maxCeStrike;
    chainMonitorState.prevPutWall = maxPeStrike;
    chainMonitorState.prevTotalCeOi = totalCeOi;
    chainMonitorState.prevTotalPeOi = totalPeOi;
  }

  const [rollStatus, setRollStatus] = createSignal("Idle");
  const [rollStats, setRollStats] = createSignal({
    spot: "--",
    strike: "--",
    bid: "--",
    ask: "--",
    iv: "--",
    points: "0",
    meta: "Lowest ATM +/-2 straddle, sampled every second."
  });
  const [rollExportData, setRollExportData] = createSignal([]);
  const [importMode, setImportMode] = createSignal(false);
  const [rollLineName, setRollLineName] = createSignal("");
  const [rollLineValue, setRollLineValue] = createSignal("");
  const [rollLineTarget, setRollLineTarget] = createSignal("bid");
  const [rollDrawnLines, setRollDrawnLines] = createSignal([]);
  const [rollWindowMode, setRollWindowMode] = createSignal("3h");
  const [rollStrikeInput, setRollStrikeInput] = createSignal("");
  const [rollSelectedStrikes, setRollSelectedStrikes] = createSignal((() => {
    try {
      const parsed = JSON.parse(localStorage.getItem("nubraRollSelectedStrikes") || "[]");
      return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
    } catch {
      return [];
    }
  })());
  const [rollChainRows, setRollChainRows] = createSignal({ strikes: [], step: 0, atm: null });
  const [rollIndicatorMenuOpen, setRollIndicatorMenuOpen] = createSignal(false);
  const [rollIndicatorPane, setRollIndicatorPane] = createSignal("none");
  const [rollIndicatorPaneHeight, setRollIndicatorPaneHeightRaw] = createSignal(Number(localStorage.getItem("nubraRollIndicatorPaneHeight")) || 280);
  let importFileRef;

  // ── Multi Spread (grid of rolling OTM strangles) ──
  const [msLayout, setMsLayout] = createSignal(localStorage.getItem("nubraMsLayout") || "2x2");
  const [msStatus, setMsStatus] = createSignal("");
  const [msLiveOn, setMsLiveOn] = createSignal(false);
  // Per-slot OTM selection (slotIndex -> offset 1..10). Restored from storage and
  // normalized to the saved layout's slot count with unique, gap-free defaults.
  const [msSlots, setMsSlots] = createSignal((() => {
    const layoutCount = { "3x3": 9, "4x4": 10, side: 10 }[msLayout()] || 4;
    let saved = [];
    try {
      const parsed = JSON.parse(localStorage.getItem("nubraMsSlots") || "null");
      if (Array.isArray(parsed)) saved = parsed.map(Number);
    } catch {}
    const used = new Set();
    const out = [];
    for (let i = 0; i < layoutCount; i++) {
      let pick = saved[i];
      if (!Number.isFinite(pick) || pick < 1 || pick > 10 || used.has(pick)) {
        pick = 1;
        while (used.has(pick) && pick <= 10) pick++;
      }
      used.add(pick);
      out.push(pick);
    }
    return out;
  })());
  const [msCells, setMsCells] = createSignal({}); // { [offset]: { ceStrike, peStrike, bid, ask, iv, hasData } }
  const [msSeriesVisibility, setMsSeriesVisibility] = createSignal({
    bid: localStorage.getItem("nubraMsSeriesBid") !== "0",
    ask: localStorage.getItem("nubraMsSeriesAsk") !== "0",
    iv: localStorage.getItem("nubraMsSeriesIv") !== "0"
  });

  // ── Premium Decay (single overlay chart: per-leg CE/PE decay vs 9:15 open) ──
  // Each plotted line is ONE leg ({strike, side}) as % of its own 9:15 open.
  // Legs come from one of three pick modes: rolling ATM±N, fixed center±N, or a
  // hand-picked custom list selected from the sidebar chain table.
  const [pdStatus, setPdStatus] = createSignal("");
  const [pdLiveOn, setPdLiveOn] = createSignal(false);
  const [pdCells, setPdCells] = createSignal({}); // { summary: { [legKey]: {pct,ltp,iv,state} }, hasData }
  const [pdSpotVisible, setPdSpotVisible] = createSignal(localStorage.getItem("nubraPdSpot") !== "0");
  // Visibility: per-leg key ("24000|CE") on/off. Absent key = visible.
  const [pdLegVisibility, setPdLegVisibility] = createSignal((() => {
    try { return JSON.parse(localStorage.getItem("nubraPdLegVis") || "{}") || {}; } catch { return {}; }
  })());
  // Strike-selection model.
  const [pdPickMode, setPdPickMode] = createSignal(localStorage.getItem("nubraPdMode") || "atm"); // "atm" | "fixed" | "custom"
  const [pdAtmRange, setPdAtmRange] = createSignal(Number(localStorage.getItem("nubraPdAtmRange")) || 3); // ±N strikes around rolling ATM
  const [pdFixedCenter, setPdFixedCenter] = createSignal(""); // center strike for fixed mode (rupees)
  const [pdFixedRange, setPdFixedRange] = createSignal(Number(localStorage.getItem("nubraPdFixedRange")) || 2);
  const [pdCustomLegs, setPdCustomLegs] = createSignal((() => {
    try { return JSON.parse(localStorage.getItem("nubraPdCustomLegs") || "[]") || []; } catch { return []; }
  })()); // [{ strike, side }]
  // Chain rows for the sidebar table { strikes:[...], step, atm } built from refdata + spot.
  const [pdChainRows, setPdChainRows] = createSignal({ strikes: [], step: 0, atm: null });

  // ── Vega Analysis (per-leg vega vs 9:15 open: is vega building or bleeding) ──
  // Mirrors Premium Decay's layout/controls; each line is ONE leg's vega as % of
  // its own 9:15 open vega. Above 0 = vega built (vol rising), below = vega bled.
  const [vgStatus, setVgStatus] = createSignal("");
  const [vgLiveOn, setVgLiveOn] = createSignal(false);
  const [vgCells, setVgCells] = createSignal({}); // { summary: { [legKey]: {pct,vega,iv,state} }, hasData }
  const [vgSpotVisible, setVgSpotVisible] = createSignal(localStorage.getItem("nubraVgSpot") !== "0");
  const [vgLegVisibility, setVgLegVisibility] = createSignal((() => {
    try { return JSON.parse(localStorage.getItem("nubraVgLegVis") || "{}") || {}; } catch { return {}; }
  })());
  const [vgPickMode, setVgPickMode] = createSignal(localStorage.getItem("nubraVgMode") || "atm");
  const [vgAtmRange, setVgAtmRange] = createSignal(Number(localStorage.getItem("nubraVgAtmRange")) || 3);
  const [vgFixedCenter, setVgFixedCenter] = createSignal("");
  const [vgFixedRange, setVgFixedRange] = createSignal(Number(localStorage.getItem("nubraVgFixedRange")) || 2);
  const [vgCustomLegs, setVgCustomLegs] = createSignal((() => {
    try { return JSON.parse(localStorage.getItem("nubraVgCustomLegs") || "[]") || []; } catch { return []; }
  })());
  const [vgChainRows, setVgChainRows] = createSignal({ strikes: [], step: 0, atm: null });
  // Delta band: include CE legs with delta∈[min,max] and PE legs with |delta|∈[min,max].
  // Default 0.05–0.60 = the OTM range. The band rolls automatically as spot/ATM moves.
  const [vgDeltaMin, setVgDeltaMin] = createSignal(Number(localStorage.getItem("nubraVgDeltaMin")) || 0.05);
  const [vgDeltaMax, setVgDeltaMax] = createSignal(Number(localStorage.getItem("nubraVgDeltaMax")) || 0.60);

  const [chainSymbol, setChainSymbol] = createSignal("NIFTY");
  const [chainExchange, setChainExchange] = createSignal("NSE");
  const [chainExpiry, setChainExpiry] = createSignal("");
  const [chainExpiries, setChainExpiries] = createSignal([]);
  const [chainStatus, setChainStatus] = createSignal("Idle");
  const [chainData, setChainData] = createSignal(null);
  const [chainIvChange, setChainIvChange] = createSignal({ key: "", value: null, baseIv: null, baseDate: "" });
  const [chainFilterMode, setChainFilterMode] = createSignal("atm");
  const [chainAtmRange, setChainAtmRange] = createSignal("10");
  const [gammaRange, setGammaRange] = createSignal("10");
  // Intraday total-GEX time series: [{ t: epochSec, gex }] recorded each chain
  // tick so the Gamma view can plot how dealer gamma (long↔short) evolves.
  const [gexHistory, setGexHistory] = createSignal([]);
  const [gexHistStatus, setGexHistStatus] = createSignal("");
  const [gexHistLoading, setGexHistLoading] = createSignal(false);
  // Date (YYYY-MM-DD) the historical GEX backfill loads. Defaults to today.
  const [gexHistDate, setGexHistDate] = createSignal(todayKey());
  const [chainPremiumMin, setChainPremiumMin] = createSignal("");
  const [chainPremiumMax, setChainPremiumMax] = createSignal("");
  const [chainColumnMenuOpen, setChainColumnMenuOpen] = createSignal(false);
  const [chainExpiryMenuOpen, setChainExpiryMenuOpen] = createSignal(false);
  const [chainVisibleColumns, setChainVisibleColumns] = createSignal({ ...DEFAULT_CHAIN_COLUMNS });
  const [chainLive, setChainLive] = createSignal(false);
  const [chainSearchText, setChainSearchText] = createSignal("");
  const [chainSearchQuery, setChainSearchQuery] = createSignal("");
  const [chainSearchOpen, setChainSearchOpen] = createSignal(false);
  const [chainSearchCategory, setChainSearchCategory] = createSignal("all");
  const [chainSearchRows, setChainSearchRows] = createSignal([]);
  const [instrumentSwitching, setInstrumentSwitching] = createSignal(false);
  const [ivTermSymbol, setIvTermSymbol] = createSignal("NIFTY");
  const [ivTermExchange, setIvTermExchange] = createSignal("NSE");
  const [ivTermPoints, setIvTermPoints] = createSignal([]);
  const [ivTermStatus, setIvTermStatus] = createSignal("Select Load to query all expiries");
  const [smileSurfaces, setSmileSurfaces] = createSignal([]);
  const [smileExpiry, setSmileExpiry] = createSignal("");
  const selectedSmile = createMemo(() => smileSurfaces().find((surface) => surface.expiry === smileExpiry()) || smileSurfaces()[0] || null);
  const ivTermSummary = createMemo(() => {
    const points = ivTermPoints();
    const front = points[0];
    const back = points[points.length - 1];
    const slope = front && back ? back.atmIv - front.atmIv : null;
    return {
      frontIv: front?.atmIv ?? null,
      backIv: back?.atmIv ?? null,
      slope,
      shape: slope == null ? "--" : slope > 0.25 ? "Contango" : slope < -0.25 ? "Backwardation" : "Flat"
    };
  });

  // ── OI Profile signals ──
  const [oiProfileRange, setOiProfileRange] = createSignal("20");

  // ── Max Pain signals ──
  // (no extra state — derives from optionRows live)

  // ── Multi-Strike OI Time Series signals ──
  const [oiTsStrikes, setOiTsStrikes] = createSignal([]); // auto-selected ATM±N strikes
  const [oiTsHistory, setOiTsHistory] = createSignal({}); // { strike: [{ t, ceOi, peOi }] }
  const [oiTsRange, setOiTsRange] = createSignal("5");    // how many ATM-nearby strikes each side
  const [smartOiHistory, setSmartOiHistory] = createSignal([]); // [{ t, ceOi, peOi }] aggregate CE/PE OI
  const [smartOiLoaded, setSmartOiLoaded] = createSignal(false);
  const [smartOiIndicatorEnabled, setSmartOiIndicatorEnabled] = createSignal(false);
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const [oiTsStartDate, setOiTsStartDate] = createSignal(todayStr());
  const [oiTsEndDate, setOiTsEndDate] = createSignal(todayStr());

  // ── Vol Surface signals ──
  // uses existing ivTermPoints + smileSurfaces — no extra signals needed

  let priceChartHost;
  let rollChartHost;
  let appRootHost;
  let appHeaderHost;
  let chainSearchHost;
  let chainExpiryMenuHost;
  let chainNavHost;
  let labNavHost;
  let controlCenterHost;
  let ivTermChartHost;
  let ivTermChart;
  let smileChartHost;
  let smileChart;
  let gammaIntradayHost;
  let gammaIntradayChart;
  let gammaExpiryHost;
  let gammaExpiryChart;
  let gexTimeHost;
  let gexTimeChart;
  let priceChart;
  let candleSeries;
  let smartOiSeries;
  let smartOiPriceLine;
  let rollChart;
  let rollBidSeries;
  let rollAskSeries;
  let rollIvSeries;
  let rollChartLines = { bid: [], ask: [], iv: [] };
  // [time, bid, ask, iv, avg, ...drawnLines]
  let rollChartData = [[], [], [], [], []];
  let rollReferenceCount = 0;
  let rollManualScales = { x: null, price: null, iv: null };
  const rollPriceLines = new Map();
  let chartResizeQueued = false;
  let rollScaleApplyQueued = false;
  let autoChainSearchKey = "";
  let rollLiveSocket = null;

  createEffect(() => {
    appTheme();
    requestAnimationFrame(() => {
      const options = chartThemeOptions();
      priceChart?.applyOptions?.(options);
      if (rollChart?.applyOptions) {
        rollChart.applyOptions({
          ...options,
          leftPriceScale: {
            visible: true,
            borderColor: options.rightPriceScale.borderColor,
            scaleMargins: { top: 0.08, bottom: 0.08 },
            minimumWidth: 72
          },
          rightPriceScale: {
            visible: true,
            borderColor: options.rightPriceScale.borderColor,
            scaleMargins: { top: 0.08, bottom: 0.08 }
          }
        });
      }
    });
  });
  let rollLiveContext = null;
  let rollCutoffTimer = null;
  let chainLiveSocket = null;
  let chainCutoffTimer = null;
  let pendingChainData = null;
  let chainRafId = null;
  let rollThrottleTimer = null;
  let rollThrottlePending = null;
  let rollExportBuffer = [];
  // ── Multi Spread state (charts keyed by OTM offset 1..10) ──
  const msChartHosts = new Map();   // offset -> host element
  const msCharts = new Map();       // offset -> uPlot instance
  const msChartData = new Map();    // offset -> [time[], bid[], ask[], iv[]]
  const msLines = new Map();        // offset -> { bid:[], ask:[], iv:[] }
  const msManualScales = new Map(); // offset -> { x, price, iv } (user-set zoom/pan)
  let msLiveContext = null;
  let msLiveSocket = null;
  let msCutoffTimer = null;
  let msThrottleTimer = null;
  let msThrottlePending = null;
  // ── Premium Decay state (single overlay chart) ──
  // Series layout: [time, b0CE,b0PE, b2CE,b2PE, b4CE,b4PE, b6CE,b6PE, b8CE,b8PE,
  //                 b10CE,b10PE, spot]. 13 value series after x.
  let pdChartHost;
  let pdChart;
  let pdChartData = null;            // uPlot data array: [x, OTM2%, OTM4%, OTM6%, OTM8%, OTM10%, spot]
  let pdLineData = null;            // { times:[], pct:{offset:[]}, spot:[] } (% decay series)
  let pdMeta = null;                // { [offset]: { rupee:[], iv:[], state:[] } } parallel for tooltip/flags
  let pdManualScales = { x: null, decay: null, spot: null };
  let pdLiveContext = null;
  let pdLiveSocket = null;
  let pdCutoffTimer = null;
  let pdThrottleTimer = null;
  let pdThrottlePending = null;
  // ── Vega Analysis chart state (mirrors Premium Decay; per-leg vega vs open) ──
  let vgChartHost;
  let vgChart;
  let vgChartData = null;            // [x, leg0, leg1, …, spot]
  let vgLineData = null;             // { times:[], pct:{legKey:[]}, spot:[] }
  let vgMeta = null;                 // { [legKey]: { vega:[], iv:[], state:[] } }
  let vgManualScales = { x: null, vega: null, spot: null };
  let vgLiveContext = null;
  let vgLiveSocket = null;
  let vgCutoffTimer = null;
  let vgThrottleTimer = null;
  let vgThrottlePending = null;
  let vgLegs = [];
  let marketStripSocket = null;
  let marketStripReconnectTimer = null;
  let marketStripCutoffTimer = null;

  const [rollLive, setRollLive] = createSignal(false);

  const authed = createMemo(() => Boolean(token().trim() && deviceId().trim()));
  const userLabel = createMemo(() => {
    const digitsOnly = digits(phone());
    if (digitsOnly.length >= 4) return `User ${digitsOnly.slice(-4)}`;
    return authed() ? "User" : "Guest";
  });
  const userInitial = createMemo(() => {
    const label = userLabel().trim();
    return (label[0] || "U").toUpperCase();
  });
  const optionRows = createMemo(() => {
    const chain = chainData();
    if (!chain) return [];
    const byStrike = new Map();
    for (const ce of Array.isArray(chain.ce) ? chain.ce : []) {
      const strike = chainStrikeInRupees(ce.sp ?? ce.strike_price ?? ce.strikePrice ?? ce.strike, chain);
      if (!Number.isFinite(strike)) continue;
      byStrike.set(strike, { ...(byStrike.get(strike) || { strike }), ce });
    }
    for (const pe of Array.isArray(chain.pe) ? chain.pe : []) {
      const strike = chainStrikeInRupees(pe.sp ?? pe.strike_price ?? pe.strikePrice ?? pe.strike, chain);
      if (!Number.isFinite(strike)) continue;
      byStrike.set(strike, { ...(byStrike.get(strike) || { strike }), pe });
    }
    return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  });
  const visibleCallColumns = createMemo(() => CALL_COLUMN_ORDER.filter((key) => chainVisibleColumns()[key]));
  const visiblePutColumns = createMemo(() => PUT_COLUMN_ORDER.filter((key) => chainVisibleColumns()[key]));
  const visibleOptionRows = createMemo(() => {
    if (chainFilterMode() === "premium") {
      const filter = parsePremiumFilter(chainPremiumMin(), chainPremiumMax());
      if (!filter) return optionRows();
      return optionRows().filter((row) => premiumInRange(row.ce, filter) || premiumInRange(row.pe, filter));
    }
    const filter = parseChainAtmFilter(
      chainAtmRange(),
      optionRows(),
      chainStrikeInRupees(chainData()?.atm ?? chainData()?.at_the_money_strike, chainData())
    );
    if (!filter) return optionRows();
    return optionRows().filter((row) => Number(row.strike) >= filter.min && Number(row.strike) <= filter.max);
  });

  const chainRefMetrics = createMemo(() => {
    const asset = String(chainData()?.asset || chainSymbol()).trim().toUpperCase();
    const expiry = String(chainData()?.expiry || chainExpiry() || "").trim();
    const candidates = (scriptCache().rows || [])
      .filter((row) => {
        const rowAsset = String(row.asset || row.symbol || "").trim().toUpperCase();
        if (row.exchange !== chainExchange() || rowAsset !== asset) return false;
        if (expiry && String(row.expiry || "") !== expiry) return false;
        return scriptKind(row) === "OPT" || scriptKind(row) === "FUT";
      })
      .sort((a, b) => {
        const rank = (row) => scriptKind(row) === "OPT" ? 0 : 1;
        return rank(a) - rank(b) || expirySortValue(a.expiry) - expirySortValue(b.expiry);
      });
    const refLot = candidates.map((row) => rawNumber(row.lotSize)).find((value) => value != null && value > 0);
    // The option-chain API returns lot size as `ls` on each CE/PE row (per the
    // live payload). Prefer that — it's the true per-underlying lot — then fall
    // back to the other naming conventions.
    const optionLot = [
      ...(Array.isArray(chainData()?.ce) ? chainData().ce : []),
      ...(Array.isArray(chainData()?.pe) ? chainData().pe : [])
    ]
      .map((option) => rawNumber(option?.ls ?? option?.lot_size ?? option?.lotSize ?? option?.market_lot ?? option?.marketLot))
      .find((value) => value != null && value > 0);
    return {
      marketLot: optionLot ?? rawNumber(
        chainData()?.ls ??
        chainData()?.market_lot ??
        chainData()?.marketLot ??
        chainData()?.lot_size ??
        chainData()?.lotSize
      ) ?? refLot ?? null,
      daysForExpiry: rawNumber(chainData()?.days_to_expiry ?? chainData()?.daysForExpiry) ?? daysUntilExpiry(expiry)
    };
  });

  function chainOptionIv(option) {
    return normalizeLiveIv(pickOptionValue(option, ["iv", "IV", "iv_mid", "ivMid", "iv_percent", "ivPercent", "implied_volatility", "impliedVolatility", "volatility"]));
  }

  function optionOiChangeValue(option) {
    if (!option) return null;
    const oi = rawNumber(option.oi ?? option.open_interest);
    const previousOi = rawNumber(option.previous_oi ?? option.previous_open_interest);
    const rawChange = rawNumber(
      option.oi_change ??
      option.oiChange ??
      option.change_oi ??
      option.open_interest_change ??
      option.change_in_oi
    );
    return rawChange ?? (oi != null && previousOi != null ? oi - previousOi : null);
  }

  const chainDerivedStats = createMemo(() => {
    const rows = optionRows();
    let callOi = 0;
    let putOi = 0;
    for (const row of rows) {
      callOi += rawNumber(row.ce?.oi ?? row.ce?.open_interest) || 0;
      putOi += rawNumber(row.pe?.oi ?? row.pe?.open_interest) || 0;
    }

    const atmRaw = chainStrikeInRupees(chainData()?.atm ?? chainData()?.at_the_money_strike, chainData());
    const strikes = rows.map((row) => Number(row.strike)).filter(Number.isFinite);
    const atmStrike = Number.isFinite(atmRaw)
      ? atmRaw
      : strikes.length && Number.isFinite(toRupees(chainData()?.cp))
        ? nearestStrike((toRupees(chainData()?.cp) || 0) * 100, strikes, inferStrikeStep(strikes))
        : null;
    const atmRow = Number.isFinite(atmStrike)
      ? rows.reduce((best, row) =>
          !best || Math.abs(Number(row.strike) - atmStrike) < Math.abs(Number(best.strike) - atmStrike) ? row : best,
          null)
      : null;
    const ivValues = [chainOptionIv(atmRow?.ce), chainOptionIv(atmRow?.pe)].filter((value) => Number.isFinite(value));
    const atmIv = ivValues.length ? ivValues.reduce((sum, value) => sum + value, 0) / ivValues.length : null;
    return {
      atmIv,
      pcr: callOi > 0 ? putOi / callOi : null
    };
  });

  // ── Gamma Density (Γ×OI) — derives entirely from the live option chain ──
  // Declared after optionRows, chainDerivedStats, chainRefMetrics, chainOptionIv
  // to avoid a TDZ (temporal dead zone) error in the minified bundle.
  const gammaDensity = createMemo(() => {
    const allRows = optionRows();
    const spot = rawNumber(toRupees(chainData()?.cp));
    const atmRaw = chainStrikeInRupees(chainData()?.atm ?? chainData()?.at_the_money_strike, chainData());
    const atmIv = chainDerivedStats().atmIv;
    const dteDays = chainRefMetrics().daysForExpiry;
    // Contract multiplier = the underlying's real lot size from refdata (NIFTY 75,
    // BANKNIFTY 35, stocks vary). Falls back to 100 only if refdata lacks it.
    // Note: this scales GEX magnitude only — the flip/cross zero-crossings are
    // unaffected by a constant multiplier.
    const lotSize = rawNumber(chainRefMetrics().marketLot) || 100;

    // ATM filter — reuse parseChainAtmFilter; "full" shows all strikes
    const rangeFilter = parseChainAtmFilter(gammaRange(), allRows, atmRaw);
    const rows = rangeFilter
      ? allRows.filter((r) => Number(r.strike) >= rangeFilter.min && Number(r.strike) <= rangeFilter.max)
      : allRows;

    const chain = [];
    let maxIntraday = 0, maxExpiry = 0;
    let peakIntradayStrike = null, peakExpiryStrike = null;
    // Signed dealer gamma exposure across the loaded strikes:
    //   GEX = Σ (CE_gamma·CE_OI − PE_gamma·PE_OI) · 100 · spot
    // Positive = dealers net LONG gamma (pinning); negative = SHORT gamma (squeeze).
    let totalGex = 0;
    const intradayScale = Number.isFinite(dteDays) && dteDays > 0 ? Math.sqrt(dteDays) : 1;

    for (const row of rows) {
      const strike = rawNumber(row.strike);
      if (!Number.isFinite(strike)) continue;
      const ceGamma = rawNumber(row.ce?.gamma) ?? 0;
      const peGamma = rawNumber(row.pe?.gamma) ?? 0;
      const ceOi = rawNumber(row.ce?.oi ?? row.ce?.open_interest) ?? 0;
      const peOi = rawNumber(row.pe?.oi ?? row.pe?.open_interest) ?? 0;
      const vs = [chainOptionIv(row.ce), chainOptionIv(row.pe)].filter(Number.isFinite);
      const iv = vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : null;

      const densityExpiry = ceGamma * ceOi + peGamma * peOi;
      const densityIntraday = densityExpiry * intradayScale;
      // Signed per-strike dealer GEX in rupees, standard convention:
      //   GEX = Γ · OI(shares) · Spot² · 0.01   (CE long − PE short)
      // The API's OI is already in SHARES (lot baked in) — so we do NOT multiply
      // by lot again. Spot² converts gamma to ₹ dealer-exposure; ×0.01 expresses
      // it per 1% spot move. Dividing the total by 1e7 later yields Crore.
      const strikeGex = Number.isFinite(spot)
        ? (ceGamma * ceOi - peGamma * peOi) * spot * spot * 0.01 : 0;
      if (Number.isFinite(spot)) totalGex += strikeGex;

      if (densityExpiry > maxExpiry) { maxExpiry = densityExpiry; peakExpiryStrike = strike; }
      if (densityIntraday > maxIntraday) { maxIntraday = densityIntraday; peakIntradayStrike = strike; }

      chain.push({ strike, iv, ce_oi: ceOi, pe_oi: peOi, density_intraday: densityIntraday, density_expiry: densityExpiry, strike_gex: strikeGex });
    }

    // Normalised GEX (same /1e7 scaling the OIE engine uses) and a sign-based
    // regime: long gamma when positive, short when negative, with a thin neutral
    // deadband around zero so tiny residuals don't flip the label every tick.
    // gexNorm is in Crore (₹·1e7). Thin neutral deadband (±100 Cr) so the label
    // doesn't flicker right at the zero-crossing; otherwise sign = regime.
    const gexNorm = Number.isFinite(spot) && chain.length ? totalGex / 1e7 : null;
    const gexRegime = gexNorm == null ? null
      : gexNorm > 100 ? "long"
      : gexNorm < -100 ? "short"
      : "neutral";

    // ── Gamma Flip level ──────────────────────────────────────────────────
    // The price where PER-STRIKE net GEX flips from negative (put-dominated, red
    // bars) to positive (call-dominated, green bars) — i.e. where the bars cross
    // zero on the chart — picking the crossing NEAREST spot. Below it dealers are
    // net SHORT gamma (volatile), above it net LONG (pinning). The bar crossing
    // sits near spot and matches the chart visually; a cumulative-sum method
    // floats the flip far out into the wings (wrong). gammaFlipLow/High = the two
    // strikes bracketing the crossing, drawn as the flip zone band.
    let gammaFlip = null, gammaFlipLow = null, gammaFlipHigh = null;
    if (chain.length >= 2 && Number.isFinite(spot)) {
      const sorted = [...chain].sort((a, b) => a.strike - b.strike);
      const crossings = [];
      for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1], b = sorted[i];
        const ga = a.strike_gex || 0, gb = b.strike_gex || 0;
        if (ga <= 0 && gb > 0 && gb !== ga) {
          crossings.push({ x: a.strike + (b.strike - a.strike) * (-ga / (gb - ga)), low: a.strike, high: b.strike });
        }
      }
      if (crossings.length) {
        const pick = crossings.reduce((best, u) =>
          Math.abs(u.x - spot) < Math.abs(best.x - spot) ? u : best, crossings[0]);
        gammaFlip = pick.x; gammaFlipLow = pick.low; gammaFlipHigh = pick.high;
      }
    }
    // Regime = the actual sign of total Net GEX at the current spot (the ground
    // truth of dealer positioning), so it always agrees with the GAMMA LONG/SHORT
    // badge. Below the flip dealers are net SHORT gamma (volatile); above, LONG
    // (pinning). We read it off totalGex rather than spot-vs-flip so a spurious
    // tail crossing can never contradict the headline regime.
    const flipRegime = !Number.isFinite(spot) || gexNorm == null ? null
      : totalGex > 0 ? "long" : totalGex < 0 ? "short" : null;

    const ivDec = Number.isFinite(atmIv) ? atmIv / 100 : null;
    const band = (years) => {
      if (!Number.isFinite(spot) || ivDec == null || years <= 0) return null;
      const sigma = spot * ivDec * Math.sqrt(years);
      return {
        sigma_move: sigma,
        one_sigma_low: spot - sigma, one_sigma_high: spot + sigma,
        two_sigma_low: spot - 2 * sigma, two_sigma_high: spot + 2 * sigma,
      };
    };
    const yearsExpiry = Number.isFinite(dteDays) && dteDays > 0 ? dteDays / 365 : null;

    return {
      hasData: chain.length > 0 && Number.isFinite(spot),
      spot, atmIv, dteDays,
      atmStrike: Number.isFinite(atmRaw) ? atmRaw : null,
      peakIntradayStrike, peakExpiryStrike,
      intradayBand: band(1 / 365),
      expiryBand: yearsExpiry != null ? band(yearsExpiry) : null,
      gex: gexNorm, gexRegime,
      gammaFlip, gammaFlipLow, gammaFlipHigh, flipRegime,
      lotSize,
      chain,
    };
  });

  // Record the whole-chain total GEX into an intraday time series each time the
  // chain updates, so the Gamma view can plot the long↔short regime over time.
  // Keyed by symbol+expiry: switching instrument/expiry clears the buffer so one
  // instrument's history never bleeds into another's chart.
  let gexHistoryKey = "";
  createEffect(() => {
    const gd = gammaDensity();
    // Key on symbol+expiry+selected-date so switching any of them clears the
    // buffer — a past-day backfill must not mix with another day's points.
    const key = `${chainSymbol()}|${chainExpiry()}|${gexHistDate()}`;
    if (key !== gexHistoryKey) { gexHistoryKey = key; setGexHistory([]); }
    if (gd.gex == null) return;
    // Only append live "now" points when viewing today; for a past date the
    // chart should show only the backfill.
    if (gexHistDate() !== todayKey()) return;
    const t = Math.floor(Date.now() / 1000);
    // Record the flip level + spot alongside GEX so the over-time chart can plot
    // where the flip sat and whether spot held above it (long) or below (short).
    const flip = Number.isFinite(gd.gammaFlip) ? gd.gammaFlip : null;
    const spotNow = Number.isFinite(gd.spot) ? gd.spot : null;
    setGexHistory((prev) => {
      // Coalesce to one sample per second (replace the last if same second).
      const next = prev.length && prev[prev.length - 1].t === t
        ? prev.slice(0, -1)
        : prev;
      const out = [...next, { t, gex: gd.gex, flip, spot: spotNow }];
      // Cap the buffer to a full session of 1s samples (~8h) to bound memory.
      return out.length > 30000 ? out.slice(out.length - 30000) : out;
    });
  });

  // Backfill the total-GEX time series from the historical timeseries API.
  // For each ATM±N option leg we pull a 1-minute series of `gamma` and
  // `cumulative_oi`, plus a 1-minute spot series, then at every minute compute
  //   GEX(t) = Σ (CE_gamma·CE_oi − PE_gamma·PE_oi) · 100 · spot(t)   (/1e7)
  // using the same cursor-walk the rolling-straddle loader uses. The strike set
  // matches the Gamma view's ATM±N selector (gammaRange()).
  async function loadGexHistory() {
    if (gexHistLoading()) return;
    const sym = chainSymbol().trim().toUpperCase();
    const expiry = String(chainData()?.expiry || chainExpiry() || "");
    if (!sym) { setGexHistStatus("Load an option chain first"); return; }
    if (!expiry) { setGexHistStatus("Select an expiry first"); return; }
    if (!token().trim() || !deviceId().trim()) { setGexHistStatus("Session needed"); return; }

    setGexHistLoading(true);
    setGexHistStatus("Resolving strikes…");
    try {
      const date = gexHistDate() || todayKey();
      // Session window: selected-date 9:15 → 15:30 IST (for today, capped at now).
      // Pinning the end to the close (and erroring before today's open) keeps the
      // range from ever running backward — raw `now` produced endDate < startDate
      // after the close / after midnight, which the API rejects.
      const [yy, mm, dd] = date.split("-").map(Number);
      const atIst = (h, m) => { const d = new Date(); d.setFullYear(yy, mm - 1, dd); d.setHours(h, m, 0, 0); return d; };
      const open = atIst(9, 15);
      const close = atIst(15, 30);
      const now = new Date();
      const isToday = date === todayKey();
      if (isToday && now < open) {
        throw new Error("Market hasn't opened yet — no intraday GEX to load.");
      }
      const endDate = isToday && now < close ? now : close;
      const start = fromLocalInput(toLocalInput(open));
      const end = fromLocalInput(toLocalInput(endDate));

      // 1) Resolve option legs for this chain/expiry, then narrow to ATM±N.
      const legs = await chainOptionRowsForDate(date);
      if (!legs.length) throw new Error("No option legs found for this expiry.");
      const atmRaw = chainStrikeInRupees(chainData()?.atm ?? chainData()?.at_the_money_strike, chainData());
      const filter = parseChainAtmFilter(gammaRange(), legs, atmRaw);
      const inRange = filter
        ? legs.filter((l) => l.strike >= filter.min && l.strike <= filter.max)
        : legs;
      if (!inRange.length) throw new Error("No strikes in the selected ATM range.");

      // 2) Spot history (1m) → spot(t) used both as the GEX multiplier and the
      //    per-minute ATM reference.
      setGexHistStatus("Fetching spot…");
      const spotType = chainSpotType();
      const spotSym = chainExchange() === "MCX" ? await resolveMcxMarketSymbol(sym, expiry) : sym;
      const { data: spotData } = await fetchTimeseriesWithIntervals({
        exchange: chainExchange(), type: spotType, values: [spotSym],
        fields: ["close"], startDate: start, endDate: end, intraDay: false, realTime: false
      }, ["1m"]);
      const spotSeries = (Array.isArray(extractSymbolData(spotData, spotSym)?.close) ? extractSymbolData(spotData, spotSym).close : [])
        .map((p) => ({ ts: pointMs(p), spot: pointNumber(p, true) }))
        .filter((p) => Number.isFinite(p.ts) && p.spot > 0)
        .sort((a, b) => a.ts - b.ts);
      if (!spotSeries.length) throw new Error("No spot history returned.");

      // 3) Fetch gamma + cumulative_oi per leg, batched and paced to respect the
      //    60 req/min historical limit.
      const names = [...new Set(inRange.map((l) => l.name))];
      const legByName = new Map(inRange.map((l) => [String(l.name).toUpperCase(), l]));
      const gammaByName = new Map(); // name → { gamma:[{ts,v}], oi:[{ts,v}] }
      const batches = [];
      for (let i = 0; i < names.length; i += ROLLING_BATCH_SIZE) batches.push(names.slice(i, i + ROLLING_BATCH_SIZE));
      for (let b = 0; b < batches.length; b += 1) {
        setGexHistStatus(`Fetching greeks ${b + 1}/${batches.length}…`);
        try {
          const { data } = await fetchTimeseriesWithIntervals({
            exchange: chainExchange(), type: "OPT", values: batches[b],
            fields: ["gamma", "cumulative_oi"], startDate: start, endDate: end, intraDay: false, realTime: false
          }, ["1m"]);
          const values = data?.result?.[0]?.values || [];
          for (const entry of values) {
            for (const [name, sd] of Object.entries(entry)) {
              const key = String(name).toUpperCase();
              const parse = (arr) => (Array.isArray(arr) ? arr : [])
                .map((p) => ({ ts: pointMs(p), v: pointNumber(p, false) }))
                .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.v))
                .sort((a, b) => a.ts - b.ts);
              const gamma = parse(sd?.gamma), oi = parse(sd?.cumulative_oi);
              if ((gamma.length || oi.length) && !gammaByName.has(key)) gammaByName.set(key, { gamma, oi });
            }
          }
        } catch { /* skip a failed batch; partial history is still useful */ }
        // Pace batches under the 60 req/min historical limit.
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!gammaByName.size) throw new Error("No historical gamma returned.");

      // 4) Walk each spot minute; carry-forward the latest gamma/OI per leg via a
      //    cursor, sum signed GEX over ATM±N, push one point per minute.
      setGexHistStatus("Computing GEX…");
      const strikes = [...new Set(inRange.map((l) => l.strike))];
      const step = inferStrikeStep(strikes);
      const cursors = new Map(); // name → { gi, oi_i, gamma, oi }
      const advance = (name, ts) => {
        const key = String(name).toUpperCase();
        const s = gammaByName.get(key);
        if (!s) return null;
        const c = cursors.get(key) || { gi: 0, oii: 0, gamma: 0, oi: 0 };
        while (c.gi < s.gamma.length && s.gamma[c.gi].ts <= ts) { c.gamma = s.gamma[c.gi].v; c.gi += 1; }
        while (c.oii < s.oi.length && s.oi[c.oii].ts <= ts) { c.oi = s.oi[c.oii].v; c.oii += 1; }
        cursors.set(key, c);
        return c;
      };
      const byStrikeSide = new Map(); // `${strike}|${side}` → name
      for (const l of inRange) byStrikeSide.set(`${l.strike}|${l.side}`, l.name);

      const points = [];
      for (const sp of spotSeries) {
        const atm = nearestStrike(sp.spot, strikes, step);
        let totalGex = 0;
        // Per-strike signed GEX (ascending strike) → used to find the flip level
        // at this minute the same way gammaDensity does (per-strike sign cross).
        const perStrike = [];
        for (let off = -100; off <= 100; off++) {
          const strike = atm + off * step;
          const ceName = byStrikeSide.get(`${strike}|CE`);
          const peName = byStrikeSide.get(`${strike}|PE`);
          if (!ceName && !peName) continue;
          const ce = ceName ? advance(ceName, sp.ts) : null;
          const pe = peName ? advance(peName, sp.ts) : null;
          const ceG = ce ? ce.gamma * ce.oi : 0;
          const peG = pe ? pe.gamma * pe.oi : 0;
          // Same standard formula as the live view: Γ · OI(shares) · Spot² · 0.01.
          // cumulative_oi is in shares (lot baked in) — no extra lot multiplier.
          const sg = (ceG - peG) * sp.spot * sp.spot * 0.01;
          totalGex += sg;
          perStrike.push({ strike, gex: sg });
        }
        const gex = totalGex / 1e7;
        // Flip level = where the CUMULATIVE net GEX crosses zero, nearest spot.
        // Using the cumulative profile (not a single strike) keeps the flip
        // consistent with the total-GEX sign: spot above flip ⟺ GEX ≥ 0.
        const flip = flipFromPerStrike(perStrike, sp.spot);
        if (Number.isFinite(gex)) points.push({ t: Math.floor(sp.ts / 1000), gex, flip, spot: sp.spot });
      }
      if (!points.length) throw new Error("No GEX points computed.");

      // Merge the backfill under any live points already recorded, de-duped by t.
      setGexHistory((live) => {
        const byT = new Map(points.map((p) => [p.t, p]));
        for (const p of live) byT.set(p.t, p); // live wins on overlap
        return [...byT.values()].sort((a, b) => a.t - b.t);
      });
      setGexHistStatus(`Loaded ${points.length} pts · ${names.length} legs`);
    } catch (err) {
      setGexHistStatus(err?.message || "History load failed");
    } finally {
      setGexHistLoading(false);
    }
  }

  // ── OI Profile (butterfly) — CE OI right, PE OI left, OI change overlay ──
  const oiProfile = createMemo(() => {
    const allRows = optionRows();
    const atmRaw = chainStrikeInRupees(chainData()?.atm ?? chainData()?.at_the_money_strike, chainData());
    const rangeFilter = parseChainAtmFilter(oiProfileRange(), allRows, atmRaw);
    const rows = (rangeFilter
      ? allRows.filter((r) => Number(r.strike) >= rangeFilter.min && Number(r.strike) <= rangeFilter.max)
      : allRows).slice().sort((a, b) => Number(b.strike) - Number(a.strike)); // high→low for butterfly display

    let maxOi = 1;
    const chain = rows.map((row) => {
      const ceOi = rawNumber(row.ce?.oi ?? row.ce?.open_interest) ?? 0;
      const peOi = rawNumber(row.pe?.oi ?? row.pe?.open_interest) ?? 0;
      const ceChg = optionOiChangeValue(row.ce) ?? 0;
      const peChg = optionOiChangeValue(row.pe) ?? 0;
      maxOi = Math.max(maxOi, ceOi, peOi);
      return { strike: Number(row.strike), ceOi, peOi, ceChg, peChg };
    });
    const atmStrike = Number.isFinite(atmRaw) ? atmRaw : null;
    return { hasData: chain.length > 0, chain, maxOi, atmStrike };
  });

  // ── Max Pain ──
  const maxPain = createMemo(() => {
    const rows = optionRows();
    if (!rows.length) return { hasData: false, strikes: [], pain: [], maxPainStrike: null, spot: null };
    const spot = rawNumber(toRupees(chainData()?.cp));
    const strikes = rows.map((r) => Number(r.strike)).filter(Number.isFinite).sort((a, b) => a - b);
    const ceOiByStrike = new Map();
    const peOiByStrike = new Map();
    for (const row of rows) {
      const k = Number(row.strike);
      ceOiByStrike.set(k, rawNumber(row.ce?.oi ?? row.ce?.open_interest) ?? 0);
      peOiByStrike.set(k, rawNumber(row.pe?.oi ?? row.pe?.open_interest) ?? 0);
    }
    let minPain = Infinity, maxPainStrike = null;
    const pain = strikes.map((expiry) => {
      // total loss to all option writers if price expires at `expiry`
      let callPain = 0, putPain = 0;
      for (const k of strikes) {
        if (expiry > k) callPain += (expiry - k) * (ceOiByStrike.get(k) ?? 0);
        if (expiry < k) putPain += (k - expiry) * (peOiByStrike.get(k) ?? 0);
      }
      const total = callPain + putPain;
      if (total < minPain) { minPain = total; maxPainStrike = expiry; }
      return { strike: expiry, callPain, putPain, total };
    });
    return { hasData: true, strikes, pain, maxPainStrike, spot };
  });

  // ── Multi-Strike OI Time Series — accumulates OI snapshots on each chain tick ──
  createEffect(() => {
    const rows = optionRows();
    if (!rows.length) return;
    const atmRaw = chainStrikeInRupees(chainData()?.atm ?? chainData()?.at_the_money_strike, chainData());
    if (!Number.isFinite(atmRaw)) return;
    const n = Number(oiTsRange()) || 5;
    const sorted = rows.slice().sort((a, b) => Math.abs(Number(a.strike) - atmRaw) - Math.abs(Number(b.strike) - atmRaw));
    const top = sorted.slice(0, Math.min(n * 2 + 1, sorted.length)).map((r) => Number(r.strike)).sort((a, b) => a - b);
    setOiTsStrikes(top);
    const now = Date.now();
    setOiTsHistory((prev) => {
      const next = { ...prev };
      for (const row of rows) {
        const k = Number(row.strike);
        if (!top.includes(k)) continue;
        const ceOi = rawNumber(row.ce?.oi ?? row.ce?.open_interest) ?? 0;
        const peOi = rawNumber(row.pe?.oi ?? row.pe?.open_interest) ?? 0;
        const arr = next[k] ? [...next[k]] : [];
        if (!arr.length || arr[arr.length - 1].t !== now) arr.push({ t: now, ceOi, peOi });
        if (arr.length > 2000) arr.splice(0, arr.length - 2000);
        next[k] = arr;
      }
      return next;
    });
  });

  // Smart OI appends aggregate CE/PE OI snapshots while the indicator is open
  // or after its historical series has been loaded.
  createEffect(() => {
    const rows = optionRows();
    if (!rows.length || !smartOiLoaded() || oiTsEndDate() !== dateKey(new Date())) return;
    const ceOi = rows.reduce((sum, row) => sum + (rawNumber(row.ce?.oi ?? row.ce?.open_interest) ?? 0), 0);
    const peOi = rows.reduce((sum, row) => sum + (rawNumber(row.pe?.oi ?? row.pe?.open_interest) ?? 0), 0);
    const minuteT = Math.floor(Date.now() / 60000) * 60000;
    setSmartOiHistory((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.t === minuteT) next[next.length - 1] = { t: minuteT, ceOi, peOi };
      else next.push({ t: minuteT, ceOi, peOi });
      if (next.length > 1200) next.splice(0, next.length - 1200);
      return next;
    });
  });

  createEffect(() => {
    smartOiHistory();
    if (smartOiIndicatorEnabled()) renderSmartOiIndicator();
  });

  // ── OI Time Series — load intraday historical OI for tracked strikes ──
  async function loadOiTsHistory() {
    const rows = optionRows();
    const strikes = oiTsStrikes();
    if (!rows.length || !strikes.length) return false;

    const asset   = String(chainData()?.asset || chainSymbol()).trim().toUpperCase();
    const expiry  = String(chainData()?.expiry || chainExpiry() || "").trim();
    const exch    = chainExchange() || "NSE";
    if (!asset || !expiry) return false;

    // Build zanskar_name for each CE+PE per tracked strike
    // Format: OPT_{ASSET}_{EXPIRY}_CE_{STRIKE_PAISE}  (strike already in integer units)
    const strikePaise = (k) => {
      // If chain rows have their strike in rupees we need to convert back
      const refRow = rows.find((r) => Number(r.strike) === k);
      if (refRow) {
        const sp = rawNumber(refRow.ce?.sp ?? refRow.pe?.sp ?? refRow.ce?.strike_price ?? refRow.pe?.strike_price);
        if (Number.isFinite(sp) && sp > 1000) return Math.round(sp); // already in paise/integer units
      }
      return Math.round(k * 100); // convert rupees → paise (×100)
    };

    // The historical API expects dated instrument symbols. Resolve those from
    // refdata (stock_name/zanskar_name) and only synthesize the documented
    // zanskar_name shape when dated refdata is unavailable.
    let refOptions = [];
    try {
      refOptions = await chainOptionRowsForDate(oiTsStartDate());
    } catch (error) {
      console.warn("OI TS refdata lookup failed; using zanskar names:", error.message);
    }
    const refByStrikeSide = new Map(refOptions.map((row) => [`${row.strike}|${row.side}`, row.name]));
    const optionSymbol = (strike, side) => refByStrikeSide.get(`${strike}|${side}`)
      || `OPT_${asset}_${expiry}_${side}_${strikePaise(strike)}`;
    const ceSyms = strikes.map((k) => optionSymbol(k, "CE"));
    const peSyms = strikes.map((k) => optionSymbol(k, "PE"));
    const allSyms = [...ceSyms, ...peSyms];

    // IST 9:15 = UTC 3:45 ; IST 15:30 = UTC 10:00
    const startDate = new Date(`${oiTsStartDate()}T03:45:00.000Z`);
    const requestedEndDate = new Date(`${oiTsEndDate()}T10:00:00.000Z`);
    const localToday = dateKey(new Date());
    const endDate = oiTsEndDate() === localToday && requestedEndDate.getTime() > Date.now()
      ? new Date()
      : requestedEndDate;
    if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || endDate <= startDate) {
      throw new Error("OI history requires a valid date range ending after market open.");
    }

    // Match the rolling-straddle request strategy: at most 8 symbols per
    // request (the API limit is 10), with a small concurrent worker pool.
    const fetchOi = async (syms) => {
      const batches = [];
      for (let i = 0; i < syms.length; i += ROLLING_BATCH_SIZE) {
        batches.push(syms.slice(i, i + ROLLING_BATCH_SIZE));
      }
      const map = {};
      let cursor = 0;
      let completed = 0;
      let firstError = null;

      const worker = async () => {
        while (cursor < batches.length) {
          const batchIndex = cursor;
          cursor += 1;
          try {
            const res = await nubraFetch("charts/timeseries", {
              method: "POST",
              timeoutMs: 25000,
              body: JSON.stringify({
                query: [{
                  exchange: exch,
                  type: "OPT",
                  values: batches[batchIndex],
                  fields: ["cumulative_oi"],
                  startDate: startDate.toISOString(),
                  endDate: endDate.toISOString(),
                  interval: "1m",
                  intraDay: false,
                  realTime: false
                }]
              })
            });
            for (const entry of (res?.result?.[0]?.values || [])) {
              for (const [sym, symData] of Object.entries(entry)) map[String(sym).toUpperCase()] = symData;
            }
          } catch (error) {
            firstError ??= error;
          } finally {
            completed += 1;
            setChainStatus(`Loading REST OI ${completed}/${batches.length} batches`);
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
      };

      const workerCount = Math.min(ROLLING_FETCH_CONCURRENCY, batches.length);
      await Promise.all(Array.from({ length: workerCount }, worker));
      if (!Object.keys(map).length && firstError) throw firstError;
      return map;
    };

    let oiMap;
    try {
      oiMap = await fetchOi(allSyms);
    } catch (e) {
      console.warn("OI TS history load failed:", e.message);
      return false;
    }

    // cumulative_oi is the documented historical option-OI field. Keep the
    // legacy key as a compatibility fallback for older API deployments.
    const bestOiPoints = (symData) => {
      if (!symData) return [];
      const cumulative = Array.isArray(symData.cumulative_oi) ? symData.cumulative_oi : [];
      const legacy = Array.isArray(symData.open_interest) ? symData.open_interest : [];
      return cumulative.length ? cumulative : legacy;
    };

    // Build history: merge CE+PE OI per timestamp per strike
    const newHistory = {};
    for (let i = 0; i < strikes.length; i++) {
      const k = strikes[i];
      const cePoints = bestOiPoints(oiMap[ceSyms[i]]);
      const pePoints = bestOiPoints(oiMap[peSyms[i]]);

      const ceM = new Map();
      for (const pt of cePoints) { const t = pointMs(pt); if (t != null) ceM.set(t, pointNumber(pt)); }
      const peM = new Map();
      for (const pt of pePoints) { const t = pointMs(pt); if (t != null) peM.set(t, pointNumber(pt)); }

      // CE and PE feeds can be stamped a few milliseconds apart. Carry the
      // last value from each leg instead of treating a missing leg as zero,
      // which otherwise creates false OI drops on the chart.
      const allTs = [...new Set([...ceM.keys(), ...peM.keys()])].sort((a, b) => a - b);
      let lastCe = null;
      let lastPe = null;
      const arr = [];
      for (const t of allTs) {
        if (ceM.has(t)) lastCe = ceM.get(t);
        if (peM.has(t)) lastPe = peM.get(t);
        if (lastCe != null && lastPe != null) arr.push({ t, ceOi: lastCe, peOi: lastPe });
      }
      if (arr.length) newHistory[k] = arr;
    }

    if (Object.keys(newHistory).length) {
      setOiTsHistory((prev) => {
        const merged = { ...newHistory };
        // Append any newer live points that came in after history window
        for (const [k, liveArr] of Object.entries(prev)) {
          const histArr = merged[Number(k)] || [];
          const lastHistT = histArr.length ? histArr[histArr.length - 1].t : 0;
          const newLive = liveArr.filter((pt) => pt.t > lastHistT);
          if (newLive.length) merged[Number(k)] = [...histArr, ...newLive];
        }
        return merged;
      });
      return true;
    }
    return false;
  }

  // Build the OI chart in chronological source order:
  // 1) resolve the current contracts, 2) load REST history,
  // 3) append a fresh option-chain snapshot, 4) continue over live WS ticks.
  async function loadOiTsSeries() {
    stopChainLive();
    setChainStatus("Resolving OI contracts");
    await loadOptionChain({ startLive: false });

    // The bootstrap chain is only contract metadata for the history request.
    // Remove its reactive snapshot so the plotted series starts with REST data.
    setOiTsHistory({});
    setChainStatus("Loading REST OI history");
    const hasHistory = await loadOiTsHistory();

    // A historical-only selection must end at that session's close. Appending
    // today's chain snapshot would stretch every series flat up to today.
    if (oiTsEndDate() !== dateKey(new Date())) {
      setChainStatus(hasHistory ? `OI history · ${oiTsStartDate()} to ${oiTsEndDate()} · 1m` : "No REST OI history");
      return;
    }

    setChainStatus(hasHistory ? "Loading latest option chain" : "No REST history · loading latest option chain");
    await loadOptionChain({ startLive: false });
    startChainLive();
  }

  async function loadSmartOiSeries(options = {}) {
    stopChainLive();
    setSmartOiLoaded(false);
    setSmartOiHistory([]);
    setChainStatus("Resolving Smart OI contracts");
    await loadOptionChain({ startLive: false });

    const asset = String(chainData()?.asset || chainSymbol()).trim().toUpperCase();
    const expiry = String(chainData()?.expiry || chainExpiry() || "").trim();
    const exch = chainExchange() || "NSE";
    if (!asset || !expiry) throw new Error("Smart OI requires an underlying and expiry.");

    let legs = [];
    try {
      legs = await chainOptionRowsForDate(oiTsStartDate());
    } catch (error) {
      console.warn("Smart OI refdata lookup failed; using chain rows:", error.message);
    }

    if (!legs.length) {
      const strikePaise = (row) => {
        const raw = rawNumber(row.ce?.sp ?? row.pe?.sp ?? row.ce?.strike_price ?? row.pe?.strike_price);
        return Number.isFinite(raw) && raw > 1000 ? Math.round(raw) : Math.round(Number(row.strike) * 100);
      };
      legs = optionRows().flatMap((row) => {
        const k = Number(row.strike);
        if (!Number.isFinite(k)) return [];
        const sp = strikePaise(row);
        return [
          { name: `OPT_${asset}_${expiry}_CE_${sp}`, side: "CE", strike: k },
          { name: `OPT_${asset}_${expiry}_PE_${sp}`, side: "PE", strike: k }
        ];
      });
    }

    const uniqueLegs = [...new Map(legs.map((leg) => [String(leg.name).toUpperCase(), leg])).values()];
    if (!uniqueLegs.length) throw new Error("No option contracts found for Smart OI.");

    const startDate = new Date(`${oiTsStartDate()}T03:45:00.000Z`);
    const requestedEndDate = new Date(`${oiTsEndDate()}T10:00:00.000Z`);
    const localToday = dateKey(new Date());
    const endDate = oiTsEndDate() === localToday && requestedEndDate.getTime() > Date.now()
      ? new Date()
      : requestedEndDate;
    if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || endDate <= startDate) {
      throw new Error("Smart OI requires a valid date range ending after market open.");
    }

    const batches = [];
    for (let i = 0; i < uniqueLegs.length; i += ROLLING_BATCH_SIZE) {
      batches.push(uniqueLegs.slice(i, i + ROLLING_BATCH_SIZE));
    }

    const oiByName = new Map();
    let cursor = 0;
    let completed = 0;
    let firstError = null;
    const worker = async () => {
      while (cursor < batches.length) {
        const batchIndex = cursor;
        cursor += 1;
        try {
          const batch = batches[batchIndex];
          const res = await nubraFetch("charts/timeseries", {
            method: "POST",
            timeoutMs: 25000,
            body: JSON.stringify({
              query: [{
                exchange: exch,
                type: "OPT",
                values: batch.map((leg) => leg.name),
                fields: ["cumulative_oi"],
                startDate: startDate.toISOString(),
                endDate: endDate.toISOString(),
                interval: "1m",
                intraDay: false,
                realTime: false
              }]
            })
          });
          for (const entry of (res?.result?.[0]?.values || [])) {
            for (const [name, data] of Object.entries(entry)) {
              const points = Array.isArray(data?.cumulative_oi) ? data.cumulative_oi : (Array.isArray(data?.open_interest) ? data.open_interest : []);
              oiByName.set(String(name).toUpperCase(), points);
            }
          }
        } catch (error) {
          firstError ??= error;
        } finally {
          completed += 1;
          setChainStatus(`Loading Smart OI ${completed}/${batches.length} batches`);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    };

    const workerCount = Math.min(ROLLING_FETCH_CONCURRENCY, batches.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    if (!oiByName.size && firstError) throw firstError;

    const allTs = new Set();
    const legSeries = uniqueLegs.map((leg) => {
      const byT = new Map();
      for (const point of oiByName.get(String(leg.name).toUpperCase()) || []) {
        const t = pointMs(point);
        const v = pointNumber(point);
        if (t != null && Number.isFinite(v)) {
          const minute = Math.floor(t / 60000) * 60000;
          byT.set(minute, v);
          allTs.add(minute);
        }
      }
      return { ...leg, byT, last: null };
    });

    const points = [...allTs].sort((a, b) => a - b).map((t) => {
      let ceOi = 0;
      let peOi = 0;
      let ceSeen = false;
      let peSeen = false;
      for (const leg of legSeries) {
        if (leg.byT.has(t)) leg.last = leg.byT.get(t);
        if (leg.last == null) continue;
        if (leg.side === "CE") { ceOi += leg.last; ceSeen = true; }
        if (leg.side === "PE") { peOi += leg.last; peSeen = true; }
      }
      return ceSeen && peSeen ? { t, ceOi, peOi } : null;
    }).filter(Boolean);

    setSmartOiHistory(points);
    setSmartOiLoaded(true);
    if (oiTsEndDate() === dateKey(new Date())) {
      await loadOptionChain({ startLive: false });
      startChainLive();
    }
    setChainStatus(points.length ? `Smart OI · ${points.length} 1m points · ${uniqueLegs.length} legs` : "No Smart OI history");
    if (options.attachToChart || smartOiIndicatorEnabled()) renderSmartOiIndicator();
  }

  const chainIvChangePercent = createMemo(() => {
    const currentIv = chainDerivedStats().atmIv;
    const baseIv = chainIvChange().baseIv;
    return Number.isFinite(currentIv) && Number.isFinite(baseIv) && baseIv > 0
      ? ((currentIv - baseIv) / baseIv) * 100
      : null;
  });

  const maxOiChangeAbs = createMemo(() => {
    let max = 0;
    for (const row of visibleOptionRows()) {
      for (const option of [row.ce, row.pe]) {
        const change = optionOiChangeValue(option);
        if (Number.isFinite(change)) max = Math.max(max, Math.abs(change));
      }
    }
    return max || 1;
  });
  const maxOiAbs = createMemo(() => {
    let max = 0;
    for (const row of visibleOptionRows()) {
      for (const option of [row.ce, row.pe]) {
        const oi = rawNumber(option?.oi ?? option?.open_interest);
        if (Number.isFinite(oi)) max = Math.max(max, Math.abs(oi));
      }
    }
    return max || 1;
  });
  let chainSearchDebounceTimer;
  createEffect(() => {
    const nextQuery = chainSearchText();
    window.clearTimeout(chainSearchDebounceTimer);
    chainSearchDebounceTimer = window.setTimeout(() => setChainSearchQuery(nextQuery), 90);
    onCleanup(() => window.clearTimeout(chainSearchDebounceTimer));
  });

  const chainSearchIndex = createMemo(() => {
    const indexAssets = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX", "INDIA VIX", "INDIAVIX"]);
    const isIndexRow = (row) =>
      String(row.assetType || "").toUpperCase().includes("INDEX") ||
      scriptKind(row) === "INDEX" ||
      indexAssets.has(String(row.asset || row.symbol || "").trim().toUpperCase());
    const grouped = new Map();
    const addRow = (row) => {
      const asset = row.asset || row.symbol;
      if (!asset) return;
      const kind = scriptKind(row);
      const category = row.exchange === "MCX"
        ? "commodity"
        : isIndexRow(row)
          ? "index"
          : kind === "FUT"
            ? "future"
            : kind === "OPT"
              ? "option"
              : "stock";
      const key = `${category}|${row.exchange}|${asset}`;
      const current = grouped.get(key) || {
        asset,
        exchange: row.exchange,
        category,
        displayName: category === "index" ? `${asset} Index` : row.displayName || asset,
        types: new Set(),
        expiries: new Set(),
        searchText: `${asset} ${row.symbol || ""} ${row.displayName || ""}`.toUpperCase()
      };
      if (category === "index") current.types.add("INDEX");
      else current.types.add(kind);
      if (row.expiry && category !== "index") current.expiries.add(row.expiry);
      grouped.set(key, current);
    };
    for (const row of scriptCache().rows || []) addRow(row);
    for (const row of chainSearchRows()) addRow(row);
    return [...grouped.values()].map((item) => ({
        ...item,
        typesText: [...item.types].sort().join("/"),
        expiryText: [...item.expiries].sort((a, b) => expirySortValue(a) - expirySortValue(b))[0] || "",
        label: `${item.asset} | ${item.exchange} | ${[...item.types].sort().join("/")}`,
        rankText: `${item.asset} ${item.displayName} ${item.exchange} ${[...item.types].join(" ")} ${item.searchText}`.toUpperCase()
      }));
  });

  const chainScriptMatches = createMemo(() => {
    const query = chainSearchQuery().trim().toUpperCase();
    const matches = chainSearchIndex()
      .filter((item) => (!query || item.rankText.includes(query)) && (chainSearchCategory() === "all" || item.category === chainSearchCategory()))
      .sort((a, b) => {
        const aExact = a.asset === query ? 0 : a.asset.startsWith(query) ? 1 : 2;
        const bExact = b.asset === query ? 0 : b.asset.startsWith(query) ? 1 : 2;
        if (aExact !== bExact) return aExact - bExact;
        const exchangeRank = (name) => name === scriptExchange() ? 0 : name === "NSE" ? 1 : name === "BSE" ? 2 : 3;
        const exchangeCompare = exchangeRank(a.exchange) - exchangeRank(b.exchange);
        if (exchangeCompare) return exchangeCompare;
        return a.asset.localeCompare(b.asset);
      });
    return matches.slice(0, query ? 80 : 40);
  });

  const groupedChainScriptMatches = createMemo(() => {
    const groups = new Map();
    for (const item of chainScriptMatches()) {
      const key = item.category || "stock";
      const label = key === "stock" ? "Cash" : key === "future" ? "Futures" : key === "option" ? "Options" : categoryLabel(key);
      const current = groups.get(key) || { key, label, items: [] };
      current.items.push(item);
      groups.set(key, current);
    }
    const order = ["index", "stock", "future", "option", "commodity"];
    return [...groups.values()].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  });

  async function chooseChainScript(item) {
    if (!item) return;
    setChainSearchText(item.asset);
    setChainSearchOpen(false);
    const rows = item.exchange === scriptExchange()
      ? scriptCache().rows || []
      : chainSearchRows().filter((row) => row.exchange === item.exchange);
    const sameAsset = rows.filter((row) => (row.asset || row.symbol) === item.asset);
    const categoryPreferred = item.category === "index"
      ? ["INDEX", "OPT", "FUT", "STOCK"]
      : item.category === "future" || item.category === "commodity"
        ? ["FUT", "OPT", "INDEX", "STOCK"]
        : item.category === "option"
          ? ["OPT", "FUT", "INDEX", "STOCK"]
          : ["STOCK", "INDEX", "OPT", "FUT"];
    const script = categoryPreferred
      .map((kind) => sameAsset.find((row) => scriptKind(row) === kind || (kind === "INDEX" && String(row.assetType || "").toUpperCase().includes("INDEX"))))
      .find(Boolean)
      || sameAsset[0]
      || preferredScriptForUnderlying(item.asset);
    if (script) {
      autoChainSearchKey = `${item.exchange}|${item.asset}`;
      await applyScript({ ...script, exchange: item.exchange, selectedCategory: item.category });
    }
  }
  function parseChainAtmFilter(rawValue, rows, atmValue) {
    const raw = String(rawValue || "").trim().toLowerCase();
    if (!raw || raw === "full") return null;
    const atm = Number(atmValue);
    if (!Number.isFinite(atm)) return null;
    const match = raw.match(/([+-])?\s*(?:atm)?\s*([+-])?\s*(\d+(?:\.\d+)?)/);
    if (!match) return null;
    const sign = match[2] || match[1] || "";
    const value = Number(match[3]);
    if (!Number.isFinite(value) || value <= 0) return null;
    const strikes = rows.map((row) => Number(row.strike)).filter(Number.isFinite);
    const step = inferStrikeStep(strikes);
    const distance = Number.isFinite(step) && step > 0 && Number.isInteger(value) && value <= 100
      ? value * step
      : value;
    if (sign === "+") return { min: atm, max: atm + distance };
    if (sign === "-") return { min: atm - distance, max: atm };
    return { min: atm - distance, max: atm + distance };
  }

  function parsePremiumFilter(minValue, maxValue) {
    const min = Number(String(minValue || "").replace(/,/g, ""));
    const max = Number(String(maxValue || "").replace(/,/g, ""));
    const hasMin = Number.isFinite(min) && min >= 0;
    const hasMax = Number.isFinite(max) && max >= 0;
    if (!hasMin && !hasMax) return null;
    const low = hasMin ? min : 0;
    const high = hasMax ? max : Number.POSITIVE_INFINITY;
    return { min: Math.min(low, high), max: Math.max(low, high) };
  }

  function premiumInRange(option, filter) {
    const premium = toRupees(option?.ltp);
    return premium != null && premium >= filter.min && premium <= filter.max;
  }

  function showPremiumSide(option) {
    if (chainFilterMode() !== "premium") return true;
    const filter = parsePremiumFilter(chainPremiumMin(), chainPremiumMax());
    return filter ? premiumInRange(option, filter) : true;
  }

  function toggleChainColumn(key) {
    setChainVisibleColumns((current) => {
      const visibleCount = Object.values(current).filter(Boolean).length;
      if (current[key] && visibleCount <= 1) return current;
      return { ...current, [key]: !current[key] };
    });
  }

  function showAllChainColumns() {
    setChainVisibleColumns({ ...DEFAULT_CHAIN_COLUMNS });
  }

  function chainColumnLabel(key) {
    return CHAIN_COLUMNS.find((column) => column.key === key)?.label || key;
  }

  function rawNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function oiChangeProps(option) {
    if (!option) return { text: "--", tone: "oi-change" };
    const oi = rawNumber(option.oi ?? option.open_interest);
    const previousOi = rawNumber(option.previous_oi ?? option.previous_open_interest);
    const change = optionOiChangeValue(option);
    const rawPct = rawNumber(
      option.oi_change_percent ??
      option.oiChangePercent ??
      option.oi_change_pct ??
      option.open_interest_change_percent ??
      option.change_in_oi_percent
    );
    const pct = rawPct ?? (change != null && previousOi ? (change / previousOi) * 100 : null);
    const changeText = change == null ? "--" : number.format(Math.round(Math.abs(change)));
    const pctText = pct == null ? "" : ` (${pct.toFixed(2)}%)`;
    return {
      text: `${change != null && change < 0 ? "-" : ""}${changeText}${pctText}`,
      tone: change != null && change < 0 ? "oi-change down" : "oi-change up",
      style: `--oi-bar:${Math.min(100, Math.round((Math.abs(change || 0) / maxOiChangeAbs()) * 100))}%`
    };
  }

  function optionCellProps(option, key) {
    switch (key) {
      case "ltp":
        return { value: pickOptionValue(option, ["ltp", "last_traded_price", "lastTradedPrice"]), money: true, tone: "ltp" };
      case "iv":
        return { value: normalizeLiveIv(pickOptionValue(option, ["iv", "IV", "iv_mid", "ivMid", "iv_percent", "ivPercent", "implied_volatility", "impliedVolatility", "volatility"])), tone: "iv" };
      case "gamma":
        return { value: pickOptionValue(option, ["gamma", "gamma_value", "gammaValue"]), digits: 5 };
      case "theta":
        return { value: pickOptionValue(option, ["theta", "theta_value", "thetaValue"]) };
      case "vega":
        return { value: pickOptionValue(option, ["vega", "vega_value", "vegaValue"]) };
      case "volume":
        return { value: pickOptionValue(option, ["volume", "vol", "traded_volume", "tradedVolume"]), indian: true };
      case "oi":
        return {
          value: pickOptionValue(option, ["oi", "open_interest", "openInterest"]),
          indian: true,
          tone: "oi",
          style: `--oi-bar:${Math.min(100, Math.round(((Math.abs(rawNumber(option?.oi ?? option?.open_interest) || 0)) / maxOiAbs()) * 100))}%`
        };
      case "oi_change":
        return oiChangeProps(option);
      default:
        return { value: option?.[key] };
    }
  }

  function resizeChart(chart, host) {
    if (!chart || !host) return;
    const rect = host.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    if (typeof chart.setSize === "function") chart.setSize({ width, height });
    else chart.resize(width, height);
    if (chart === rollChart) scheduleApplyRollManualScales();
  }

  function resizeVisibleCharts() {
    resizeChart(priceChart, priceChartHost);
    resizeChart(rollChart, rollChartHost);
    resizeChart(ivTermChart, ivTermChartHost);
    resizeChart(smileChart, smileChartHost);
    resizeChart(gammaIntradayChart, gammaIntradayHost);
    resizeChart(gammaExpiryChart, gammaExpiryHost);
    resizeChart(gexTimeChart, gexTimeHost);
    for (const [offset, chart] of msCharts) resizeChart(chart, msChartHosts.get(offset));
    resizeChart(pdChart, pdChartHost);
    resizeChart(vgChart, vgChartHost);
  }

  function queueChartResize() {
    if (chartResizeQueued) return;
    chartResizeQueued = true;
    requestAnimationFrame(() => {
      chartResizeQueued = false;
      resizeVisibleCharts();
    });
  }

  function toggleSettingsPanel(key) {
    setLeftSettingsCollapsed((current) => ({ ...current, [key]: !current[key] }));
    queueChartResize();
    window.setTimeout(queueChartResize, 260);
  }

  function saveAuthInputs() {
    localStorage.setItem("nubraDeviceId", deviceId().trim());
    localStorage.setItem("nubraPhone", phone().trim());
    localStorage.setItem("nubraAuthMethod", authMethod());
  }

  function authHeaders() {
    if (!authed()) throw new Error("Session token and device ID are required.");
    const rawToken = token().trim();
    return {
      Authorization: rawToken.startsWith("Bearer ") ? rawToken : `Bearer ${rawToken}`,
      "x-device-id": deviceId().trim(),
      "x-app-version": "0.4.5",
      "x-device-os": "sdk",
      "content-type": "application/json"
    };
  }

  async function nubraFetch(path, options = {}) {
    const target = new URL(path, `${environment()}/`);
    const controller = options.timeoutMs ? new AbortController() : null;
    const timeout = controller ? window.setTimeout(() => controller.abort(), options.timeoutMs) : null;
    let response;
    try {
      response = await fetch(`/api/proxy?url=${encodeURIComponent(target.toString())}`, {
        method: options.method || "GET",
        headers: { ...authHeaders(), ...(options.headers || {}) },
        body: options.body,
        signal: controller?.signal
      });
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(`Request timed out: ${path}`);
      throw error;
    } finally {
      if (timeout != null) window.clearTimeout(timeout);
    }
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (!response.ok) {
      const detail = payload?.error || payload?.message || response.statusText;
      throw new Error(`${response.status}: ${detail}`);
    }
    return payload;
  }

  async function fetchTimeseriesWithIntervals(query, intervals = ROLLING_INTERVALS) {
    let lastError = null;
    for (const intervalValue of intervals) {
      try {
        const data = await nubraFetch("charts/timeseries", {
          method: "POST",
          body: JSON.stringify({
            query: [{
              ...query,
              interval: intervalValue
            }]
          })
        });
        return { data, interval: intervalValue };
      } catch (error) {
        lastError = error;
        const message = String(error?.message || "");
        if (!message.startsWith("400:")) throw error;
      }
    }
    throw lastError || new Error("No supported chart interval returned data.");
  }

  function instrumentCacheKey(exchange = scriptExchange(), date = todayKey()) {
    return `${environment().includes("uat") ? "uat" : "prod"}:${date}:${exchange}`;
  }

  function normalizeInstrumentRow(row, exchangeValue) {
    const exchangeName = String(row.exchange || exchangeValue || "").toUpperCase();
    const asset = String(row.asset || row.underlying || row.underlying_symbol || row.underlyingSymbol || row.symbol || row.stock_name || row.name || "").trim().toUpperCase();
    const symbolName = String(row.stock_name || row.trading_symbol || row.tradingSymbol || row.symbol || row.instrument || row.display_name || row.displayName || asset).trim().toUpperCase();
    const displayName = String(row.display_name || row.displayName || row.stock_name || row.trading_symbol || row.symbol || row.name || row.zanskar_name || row.nubra_name || asset).trim();
    const type = String(row.derivative_type || row.asset_type || row.instrument_type || row.instrumentType || (row.expiry ? "FUT" : "STOCK") || "").toUpperCase();
    const assetType = String(row.asset_type || row.assetType || row.instrument_type || row.instrumentType || "").toUpperCase();
    const expiry = String(row.expiry ?? row.expiry_date ?? row.expiryDate ?? "");
    const optionType = String(row.option_type || row.optionType || row.ot || row.side || "").toUpperCase();
    const strike = row.strike_price ?? row.sp ?? "";
    const key = [
      exchangeName,
      row.ref_id ?? row.refId ?? row.token ?? "",
      symbolName,
      expiry,
      optionType,
      strike
    ].join("|");
    return {
      key,
      refId: row.ref_id ?? row.refId ?? null,
      token: row.token ?? null,
      exchange: exchangeName,
      asset,
      symbol: symbolName,
      displayName,
      type,
      assetType,
      expiry,
      optionType,
      strike,
      lotSize: row.lot_size ?? row.lotSize ?? row.market_lot ?? row.marketLot ?? "",
      searchText: `${exchangeName} ${asset} ${symbolName} ${displayName} ${type} ${expiry} ${optionType}`.toUpperCase()
    };
  }

  function sortInstruments(rows) {
    return [...rows].sort((a, b) => {
      const assetCompare = a.asset.localeCompare(b.asset);
      if (assetCompare) return assetCompare;
      const expiryCompare = String(a.expiry).localeCompare(String(b.expiry));
      if (expiryCompare) return expiryCompare;
      return a.symbol.localeCompare(b.symbol);
    });
  }

  function refdataPath(date, exchangeValue = "NSE") {
    const exchangeName = String(exchangeValue || "NSE").toUpperCase();
    return exchangeName === "NSE"
      ? `refdata/refdata/${date}`
      : `refdata/refdata/${date}?exchange=${encodeURIComponent(exchangeName)}`;
  }

  function parseCsvRows(text) {
    const records = [];
    let row = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === '"') {
        if (quoted && text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = !quoted;
      } else if (char === "," && !quoted) {
        row.push(cell);
        cell = "";
      } else if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && text[index + 1] === "\n") index += 1;
        row.push(cell);
        cell = "";
        if (row.some((value) => value.trim())) records.push(row);
        row = [];
      } else cell += char;
    }
    if (cell || row.length) {
      row.push(cell);
      if (row.some((value) => value.trim())) records.push(row);
    }
    if (records.length < 2) return [];
    const headers = records[0].map((value) => value.replace(/^\uFEFF/, "").trim().toLowerCase());
    return records.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, String(values[index] || "").trim()])));
  }

  function normalizeIndexMasterRow(row) {
    const symbol = String(row.symbol || row.index_symbol || row.indexsymbol || row.stock_name || row.name || row.index_name || row.asset || "").trim().toUpperCase();
    const asset = String(row.asset || symbol).trim().toUpperCase();
    const exchangeName = String(row.exchange || row.exchange_code || "NSE").trim().toUpperCase();
    if (!symbol && !asset) return null;
    return {
      key: `INDEX|${exchangeName}|${symbol || asset}`,
      refId: row.ref_id || row.refid || null,
      token: row.token || null,
      exchange: exchangeName,
      asset: asset || symbol,
      symbol: symbol || asset,
      displayName: row.display_name || row.index_name || row.name || asset || symbol,
      type: "INDEX",
      assetType: "INDEX",
      expiry: "",
      optionType: "",
      strike: "",
      lotSize: "",
      searchText: `${exchangeName} ${asset} ${symbol} INDEX`.toUpperCase()
    };
  }

  async function loadIndexMaster(force = false) {
    const cacheKey = "nubraIndexMasterV2";
    if (!force) {
      try {
        const cached = JSON.parse(localStorage.getItem(cacheKey) || "[]");
        if (Array.isArray(cached) && cached.length) {
          setIndexMasterRows(cached);
          return cached;
        }
      } catch {}
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    try {
      const indexUrl = "https://api.nubra.io/public/indexes?format=csv";
      const response = await fetch(`/api/proxy?url=${encodeURIComponent(indexUrl)}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Index master ${response.status}`);
      const rows = parseCsvRows(await response.text()).map(normalizeIndexMasterRow).filter(Boolean);
      if (!rows.length) throw new Error("Index master returned no rows");
      setIndexMasterRows(rows);
      localStorage.setItem(cacheKey, JSON.stringify(rows));
      return rows;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function extractRefdataRows(payload) {
    const candidates = [
      payload?.refdata,
      payload?.data?.refdata,
      payload?.result?.refdata,
      payload?.data?.instruments,
      payload?.result?.instruments,
      payload?.instruments,
      payload?.scripts,
      payload?.data,
      payload?.result,
      payload?.results
    ];
    for (const candidate of candidates) {
      if (!Array.isArray(candidate)) continue;
      if (candidate.length === 1 && Array.isArray(candidate[0]?.refdata)) return candidate[0].refdata;
      return candidate;
    }
    const visit = (value, depth = 0) => {
      if (depth > 4 || value == null) return [];
      if (Array.isArray(value)) {
        const looksLikeScripts = value.some((row) => row && typeof row === "object" && (
          row.asset || row.underlying || row.symbol || row.stock_name || row.trading_symbol || row.ref_id
        ));
        if (looksLikeScripts) return value;
        for (const item of value) {
          const nested = visit(item, depth + 1);
          if (nested.length) return nested;
        }
        return [];
      }
      if (typeof value === "object") {
        for (const nestedValue of Object.values(value)) {
          const nested = visit(nestedValue, depth + 1);
          if (nested.length) return nested;
        }
      }
      return [];
    };
    return visit(payload);
  }

  async function readRecentScriptCache(exchangeName, days = 7) {
    for (let offset = 0; offset <= days; offset += 1) {
      const date = new Date();
      date.setDate(date.getDate() - offset);
      const cached = await readInstrumentCache(instrumentCacheKey(exchangeName, dateKey(date)));
      if (cached?.rows?.length) return cached;
    }
    return null;
  }

  async function downloadRecentScripts(exchangeName, days = 3) {
    let lastError = null;
    for (let offset = 0; offset <= days; offset += 1) {
      const date = new Date();
      date.setDate(date.getDate() - offset);
      if (date.getDay() === 0 || date.getDay() === 6) continue;
      const sourceDate = dateKey(date);
      try {
        const data = await nubraFetch(refdataPath(sourceDate, exchangeName), { timeoutMs: 8000 });
        const rows = sortInstruments(extractRefdataRows(data)
          .map((row) => normalizeInstrumentRow(row, exchangeName))
          .filter((row) => row.asset || row.symbol));
        if (rows.length) return { rows, sourceDate };
      } catch (error) {
        lastError = error;
        if (/^(401|403):/.test(String(error?.message || ""))) throw error;
      }
    }
    throw lastError || new Error(`No ${exchangeName} scripts returned for recent trading dates.`);
  }

  async function loadCachedScripts(exchangeValue = scriptExchange(), force = false) {
    if (!authed()) {
      setScriptStatus("Login to download scripts");
      return [];
    }
    const exchangeName = String(exchangeValue || "NSE").toUpperCase();
    const date = todayKey();
    const key = instrumentCacheKey(exchangeName, date);
    const fallback = await readRecentScriptCache(exchangeName, 7);
    if (!force) {
      const cached = await readInstrumentCache(key) || fallback;
      if (cached?.rows?.length) {
        if (!Object.prototype.hasOwnProperty.call(cached.rows[0], "assetType")) {
          return loadCachedScripts(exchangeName, true);
        }
        setScriptCache(cached);
        setScriptStatus(`${exchangeName} ready: ${cached.rows.length.toLocaleString("en-IN")} instruments`);
        return cached.rows;
      }
    }

    setScriptStatus(`Downloading ${exchangeName} scripts`);
    try {
      const { rows, sourceDate } = await downloadRecentScripts(exchangeName, 3);
      const record = { key, date, sourceDate, exchange: exchangeName, rows, downloadedAt: new Date().toISOString() };
      await writeInstrumentCache(record);
      setScriptCache(record);
      setScriptStatus(`${exchangeName} ready: ${rows.length.toLocaleString("en-IN")} instruments`);
      return rows;
    } catch (error) {
      if (!fallback?.rows?.length) throw error;
      setScriptCache(fallback);
      setScriptStatus(`${exchangeName} cached: ${fallback.rows.length.toLocaleString("en-IN")} instruments`);
      return fallback.rows;
    }
  }

  async function loadChainSearchRows() {
    if (!authed()) return [];
    const allRows = [];
    const errors = [];
    for (const exchangeName of INSTRUMENT_EXCHANGES) {
      try {
        const cached = await readRecentScriptCache(exchangeName);
        if (cached?.rows?.length) {
          allRows.push(...cached.rows);
          continue;
        }
        const { rows } = await downloadRecentScripts(exchangeName, 3);
        allRows.push(...rows);
      } catch (error) {
        errors.push(`${exchangeName}: ${error?.message || "unavailable"}`);
      }
    }
    setChainSearchRows(allRows);
    if (!allRows.length) throw new Error(errors.join(" · ") || "No instrument masters returned.");
    setScriptStatus(`All exchanges: ${allRows.length.toLocaleString("en-IN")} tradable instruments`);
    return allRows;
  }

  // Open the global symbol-search modal and warm its data sources. Mirrors the
  // analysis toolbar's search-input onFocus so any view (e.g. the Premium Decay
  // sidebar) can offer the same underlying picker.
  function openSymbolSearch() {
    setSymbolSearchOpen(true);
    if (!authed()) return;
    if (!(scriptCache().rows || []).length) {
      loadCachedScripts(scriptExchange(), false).catch((e) => setScriptStatus(e.message || "Script download failed"));
    }
    if (!chainSearchRows().length) {
      loadChainSearchRows().catch((e) => setScriptStatus(e.message || "Instrument masters unavailable"));
    }
    if (!indexMasterRows().length) {
      loadIndexMaster().catch(() => {});
    }
  }

  async function refreshAllScripts() {
    if (!authed()) throw new Error("Login before downloading scripts.");
    let total = 0;
    for (const exchangeName of INSTRUMENT_EXCHANGES) {
      const rows = await loadCachedScripts(exchangeName, true);
      total += rows.length;
    }
    await loadCachedScripts(scriptExchange(), false);
    setScriptStatus(`All exchanges ready: ${total.toLocaleString("en-IN")} instruments`);
  }

  function scriptKind(script) {
    const type = String(script?.type || "").toUpperCase();
    if (type.includes("OPT")) return "OPT";
    if (type.includes("FUT")) return "FUT";
    if (["INDEX", "IDX"].includes(type)) return "INDEX";
    if (String(script?.exchange || "").toUpperCase() === "MCX" && script?.expiry) return "FUT";
    return "STOCK";
  }

  function categoryForKinds(kinds) {
    if (kinds.has("INDEX")) return "index";
    if (kinds.has("STOCK")) return "stock";
    if (kinds.has("FUT")) return "future";
    if (kinds.has("OPT")) return "option";
    return "stock";
  }

  function categoryLabel(category) {
    return SYMBOL_CATEGORIES.find((item) => item.key === category)?.label || category;
  }

  function getScriptUnderlying(script) {
    return String(script?.asset || script?.symbol || "").trim().toUpperCase();
  }

  function expirySortValue(expiry) {
    const n = Number(expiry);
    return Number.isFinite(n) && n > 0 ? n : Number.MAX_SAFE_INTEGER;
  }

  function parseExpiryDate(expiry) {
    const raw = String(expiry || "").trim();
    const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
    const dashed = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const parts = compact || dashed;
    if (!parts) return null;
    const year = Number(parts[1]);
    const month = Number(parts[2]);
    const day = Number(parts[3]);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
  }

  function daysUntilExpiry(expiry) {
    const expiryDate = parseExpiryDate(expiry);
    if (!expiryDate) return null;
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return Math.max(0, Math.ceil((expiryDate.getTime() - start.getTime()) / 86400000));
  }

  function mcxFutureForAsset(assetValue, expiryValue = "") {
    const asset = String(assetValue || "").trim().toUpperCase();
    const expiry = String(expiryValue || "");
    if (!asset) return null;
    const rows = [...(scriptCache().rows || []), ...chainSearchRows()].filter((row) =>
      row.exchange === "MCX" &&
      (row.asset === asset || row.symbol === asset) &&
      scriptKind(row) === "FUT"
    );
    if (!rows.length) return null;
    const exact = expiry ? rows.find((row) => String(row.expiry) === expiry) : null;
    const row = exact || [...rows].sort((a, b) => expirySortValue(a.expiry) - expirySortValue(b.expiry))[0];
    const symbol = preferredMcxFutureAlias(row);
    return symbol ? { ...row, symbol } : row;
  }

  function mcxMarketSymbol(symbolValue, expiryValue = "") {
    const sym = String(symbolValue || "").trim().toUpperCase();
    if (!sym) return "";
    if (sym.startsWith("FUT_")) return sym;
    return mcxFutureForAsset(sym, expiryValue)?.symbol || sym;
  }

  async function resolveMcxMarketSymbol(symbolValue, expiryValue = "") {
    const sym = String(symbolValue || "").trim().toUpperCase();
    if (!sym || sym.startsWith("FUT_")) return sym;
    const cached = mcxMarketSymbol(sym, expiryValue);
    if (cached && cached !== sym) return cached;
    const date = rollStart().slice(0, 10) || todayKey();
    const data = await nubraFetch(refdataPath(date, "MCX"));
    const rows = (Array.isArray(data.refdata) ? data.refdata : [])
      .filter((row) =>
        String(row.asset || row.underlying || "").trim().toUpperCase() === sym &&
        String(row.derivative_type || row.asset_type || "").toUpperCase().includes("FUT")
      )
      .map((row) => {
        const normalized = normalizeInstrumentRow(row, "MCX");
        const symbol = preferredMcxFutureAlias(row);
        return symbol ? { ...normalized, symbol } : normalized;
      })
      .filter((row) => row.symbol);
    if (!rows.length) return sym;
    const expiry = String(expiryValue || "");
    const exact = expiry ? rows.find((row) => String(row.expiry) === expiry) : null;
    return (exact || rows.sort((a, b) => expirySortValue(a.expiry) - expirySortValue(b.expiry))[0]).symbol;
  }

  function preferredScriptForUnderlying(assetValue) {
    const asset = String(assetValue || "").trim().toUpperCase();
    const rows = [...(scriptCache().rows || []), ...chainSearchRows()].filter((row) => row.asset === asset || row.symbol === asset);
    if (!rows.length) return null;
    const ranked = [...rows].sort((a, b) => {
      const aKind = scriptKind(a);
      const bKind = scriptKind(b);
      const preferred = section() === "market"
        ? ["INDEX", "STOCK", "FUT", "OPT"]
        : ["OPT", "FUT", "INDEX", "STOCK"];
      const kindCompare = preferred.indexOf(aKind) - preferred.indexOf(bKind);
      if (kindCompare) return kindCompare;
      return expirySortValue(a.expiry) - expirySortValue(b.expiry);
    });
    return ranked[0];
  }

  function preferredScriptForSearchItem(item) {
    if (!item) return null;
    const rows = [...(scriptCache().rows || []), ...chainSearchRows()];
    if (item.rowKey) {
      const exact = rows.find((row) => row.key === item.rowKey);
      if (exact) return { ...exact, selectedCategory: item.category };
    }
    if (item.category === "commodity") {
      const future = mcxFutureForAsset(item.asset, item.expiry);
      if (future) return { ...future, selectedCategory: item.category };
    }
    if (item.category === "index") {
      const indexRow = indexMasterRows().find((row) =>
        row.exchange === item.exchange && (row.asset === item.asset || row.symbol === item.symbol)
      );
      return {
        ...(indexRow || item),
        asset: item.asset,
        symbol: item.symbol || item.asset,
        exchange: item.exchange,
        type: "INDEX",
        assetType: "INDEX",
        selectedCategory: "index"
      };
    }
    const matches = rows.filter((row) => {
      if ((row.asset || row.symbol) !== item.asset) return false;
      if (item.expiry && String(row.expiry) !== String(item.expiry)) return false;
      if (item.category === "future") return scriptKind(row) === "FUT";
      if (item.category === "option") return scriptKind(row) === "OPT";
      if (item.category === "stock") return scriptKind(row) === "STOCK";
      return true;
    });
    if (matches.length) return { ...matches.sort((a, b) => expirySortValue(a.expiry) - expirySortValue(b.expiry))[0], selectedCategory: item.category };
    const fallback = preferredScriptForUnderlying(item.asset);
    return fallback ? { ...fallback, selectedCategory: item.category } : null;
  }

  function expiriesForUnderlying(assetValue = scriptUnderlying()) {
    const asset = String(assetValue || "").trim().toUpperCase();
    return [...new Set((scriptCache().rows || [])
      .filter((row) => (row.asset === asset || row.symbol === asset) && row.expiry)
      .map((row) => String(row.expiry)))]
      .sort((a, b) => expirySortValue(a) - expirySortValue(b));
  }

  function optionExpiriesForUnderlying(assetValue, rows = scriptCache().rows || []) {
    const asset = String(assetValue || "").trim().toUpperCase();
    return [...new Set(rows
      .filter((row) => {
        const rowAsset = String(row.asset || row.symbol || "").trim().toUpperCase();
        return rowAsset === asset && scriptKind(row) === "OPT" && row.expiry;
      })
      .map((row) => String(row.expiry)))]
      .sort((a, b) => expirySortValue(a) - expirySortValue(b));
  }

  function firstValidExpiry(current, expiries) {
    const selected = String(current || "");
    return selected && expiries.includes(selected) ? selected : expiries[0] || "";
  }

  function setUnifiedExpiry(expiry) {
    setRollExpiry(expiry);
    setChainExpiry(expiry);
    setRollExpiries((items) => items.includes(expiry) || !expiry ? items : [expiry, ...items]);
    setChainExpiries((items) => items.includes(expiry) || !expiry ? items : [expiry, ...items]);
  }

  function selectChainExpiry(expiry) {
    if (expiry == null) return;
    const nextExpiry = String(expiry ?? "");
    if (nextExpiry === String(chainExpiry() || "")) {
      setChainExpiryMenuOpen(false);
      return;
    }
    stopChainLive();
    setChainExpiry(nextExpiry);
    setChainData(null);
    setChainExpiryMenuOpen(false);
  }

  function setUnifiedStart(value) {
    setRollStart(value);
    setStartDate(value);
  }

  function setUnifiedEnd(value) {
    setRollEnd(value);
    setEndDate(value);
  }

  async function applyScript(script) {
    if (!script) return;
    setInstrumentSwitching(true);
    const exchangeName = String(script.exchange || scriptExchange()).toUpperCase();
    try {
      setScriptExchange(exchangeName);
      const loadedRows = [...(scriptCache().rows || []), ...chainSearchRows()]
        .filter((row) => row.exchange === exchangeName);
      let exchangeRows = loadedRows;
      if (!loadedRows.length) {
        try {
          exchangeRows = await loadCachedScripts(exchangeName, false);
        } catch {
          exchangeRows = [];
        }
      }
      const kind = scriptKind(script);
      const underlying = getScriptUnderlying(script);
      const tradableSymbol = String(script.symbol || underlying).trim().toUpperCase();
      const isIndexAsset = String(script.assetType || "").toUpperCase().includes("INDEX");
      const selectedCategory = String(script.selectedCategory || "").toLowerCase();
      const chartType = selectedCategory === "index" || (isIndexAsset && section() === "market")
        ? "INDEX"
        : kind === "OPT" || kind === "FUT"
          ? kind
          : exchangeName === "MCX"
            ? "FUT"
            : "STOCK";
      const displaySymbol = chartType === "INDEX" ? underlying : tradableSymbol;
      const optionUnderlying = underlying || tradableSymbol;
      let expiries = optionExpiriesForUnderlying(optionUnderlying, exchangeRows);
      if (!expiries.length && exchangeRows.length) {
        expiries = optionExpiriesForUnderlying(optionUnderlying, [...exchangeRows, ...chainSearchRows()]);
      }
      if (!expiries.length && section() !== "market") {
        try {
          const freshRows = await loadCachedScripts(exchangeName, true);
          expiries = optionExpiriesForUnderlying(optionUnderlying, freshRows);
        } catch {}
      }
      const selectedExpiry = firstValidExpiry(section() === "gamma" ? "" : script.expiry, expiries);

      stopChainLive();
      stopRollLive();
      stopMsLive();
      stopPdLive();
      stopVgLive();

      setScriptUnderlying(optionUnderlying);
      localStorage.setItem("nubraScriptUnderlying", optionUnderlying);

      setSymbol(displaySymbol);
      setInstrumentType(chartType);
      setExchange(exchangeName);

      setChainSymbol(optionUnderlying);
      setChainExchange(exchangeName);
      setChainData(null);
      setChainExpiries(expiries);
      setChainExpiry(selectedExpiry);

      setRollSymbol(optionUnderlying);
      setRollType(chartType === "INDEX" ? "INDEX" : exchangeName === "MCX" ? "FUT" : "STOCK");
      setRollExchange(exchangeName);
      setRollExpiry(selectedExpiry);
      setRollExpiries(expiries);

      if (section() === "gamma" || section() === "oi-profile" || section() === "max-pain" || section() === "oi-timeseries") {
        if (!expiries.length) await loadOptionChainExpiries();
        await loadOptionChain();
        return;
      }

      if (section() === "iv-term" || section() === "vol-surface") {
        setIvTermSymbol(optionUnderlying);
        setIvTermExchange(exchangeName);
        await loadIvTermStructure();
        return;
      }

      if (!expiries.length && section() !== "market") {
        const message = `No option expiries found for ${exchangeName} ${optionUnderlying}`;
        setChainStatus(message);
        setRollStatus(message);
        return;
      }

      if (section() === "market") {
        await loadSpotPrice();
        await loadPriceChart();
        return;
      }
      if (section() === "chain") {
        await loadOptionChain();
        return;
      }
      await loadRollingStraddle();
    } finally {
      setInstrumentSwitching(false);
    }
  }

  const scriptUnderlyings = createMemo(() => {
    const grouped = new Map();
    for (const row of [...(scriptCache().rows || []), ...chainSearchRows(), ...indexMasterRows()]) {
      const asset = row.asset || row.symbol;
      if (!asset) continue;
      const isCleanName = (name) => name && name === asset || (!name.includes("CE") && !name.includes("PE") && !name.includes("FUT") && !/\d{5,}/.test(name));
      const current = grouped.get(asset) || {
        asset,
        exchange: row.exchange,
        displayName: asset,
        types: new Set(),
        expiries: new Set(),
        count: 0
      };
      if (row.displayName && isCleanName(row.displayName) && current.displayName === asset) {
        current.displayName = row.displayName;
      }
      if (String(row.assetType || "").toUpperCase().includes("INDEX")) current.types.add("INDEX");
      current.types.add(scriptKind(row));
      if (row.expiry) current.expiries.add(row.expiry);
      current.count += 1;
      grouped.set(asset, current);
    }
    return [...grouped.values()]
      .map((item) => ({
        ...item,
        typesText: [...item.types].sort().join("/"),
        expiryText: [...item.expiries].sort()[0] || "",
        label: `${item.asset} | ${item.exchange} | ${[...item.types].sort().join("/")}${item.expiries.size ? ` | ${[...item.expiries].sort()[0]}` : ""}`
      }))
      .sort((a, b) => a.asset.localeCompare(b.asset));
  });

  const symbolSearchItems = createMemo(() => {
    const rows = [...(scriptCache().rows || []), ...chainSearchRows(), ...indexMasterRows()];
    const items = [];
    const seen = new Set();
    const addItem = (item) => {
      // For options/futures/commodity deduplicate by category+exchange+asset+expiry only
      // (many individual strike/series rows share the same underlying+expiry)
      const dedupSymbol = (item.category === "option" || item.category === "future" || item.category === "commodity") ? "" : (item.symbol || "");
      const key = [item.category, item.exchange, item.asset, item.expiry || "", dedupSymbol].join("|");
      if (seen.has(key)) return;
      seen.add(key);
      items.push({
        ...item,
        searchText: [
          item.asset,
          item.symbol,
          item.title,
          item.subtitle,
          item.exchange,
          item.category,
          categoryLabel(item.category),
          item.category === "future" ? "FUT FUTURE FUTURES" : "",
          item.category === "option" ? "OPT OPTION OPTIONS CE PE" : "",
          item.category === "commodity" ? "COMMODITY MCX" : "",
          item.category === "index" ? "INDEX INDICES" : ""
        ].filter(Boolean).join(" ").toUpperCase()
      });
    };

    for (const item of scriptUnderlyings()) {
      if (item.types.has("INDEX")) {
        const indexLabel = item.displayName !== item.asset ? item.displayName : `${item.asset} Index`;
        addItem({
          category: "index",
          asset: item.asset,
          symbol: item.asset,
          exchange: item.exchange,
          title: item.asset,
          subtitle: `${indexLabel} · ${item.exchange}`,
          badge: item.asset.slice(0, 2)
        });
      }
      if (item.types.has("STOCK")) {
        addItem({
          category: "stock",
          asset: item.asset,
          symbol: item.asset,
          exchange: item.exchange,
          title: item.asset,
          subtitle: "Equity",
          badge: item.asset.slice(0, 2)
        });
      }
    }

    for (const row of rows) {
      const kind = scriptKind(row);
      const asset = row.asset || row.symbol;
      if (!asset) continue;
      if (kind === "FUT") {
        if (row.exchange === "MCX") {
          addItem({
            category: "commodity",
            asset,
            symbol: row.symbol,
            exchange: row.exchange,
            title: asset,
            subtitle: row.expiry ? `Commodity FUT · ${row.expiry}` : "Commodity FUT",
            expiry: row.expiry,
            rowKey: row.key,
            badge: asset.slice(0, 2)
          });
        }
        addItem({
          category: "future",
          asset,
          symbol: row.symbol,
          exchange: row.exchange,
          title: `${asset} FUT`,
          subtitle: row.expiry ? `Futures · ${row.expiry}` : "Futures",
          expiry: row.expiry,
          rowKey: row.key,
          badge: "FU"
        });
      }
      if (kind === "OPT") {
        addItem({
          category: "option",
          asset,
          symbol: row.symbol,
          exchange: row.exchange,
          title: `${asset} OPTIONS`,
          subtitle: row.expiry ? `Options chain · ${row.expiry}` : "Options chain",
          expiry: row.expiry,
          rowKey: row.key,
          badge: "OP"
        });
      }
    }

    const order = { index: 0, stock: 1, future: 2, option: 3, commodity: 4 };
    return items.sort((a, b) => (order[a.category] ?? 9) - (order[b.category] ?? 9) || a.asset.localeCompare(b.asset) || String(a.expiry || "").localeCompare(String(b.expiry || "")));
  });

  const symbolSearchResults = createMemo(() => {
    const query = symbolSearchText().trim().toUpperCase();
    const activeCategory = symbolSearchCategory();
    return symbolSearchItems()
      .filter((item) => {
        if (activeCategory !== "all" && item.category !== activeCategory) return false;
        if (!query) return true;
        return query.split(/\s+/).every((part) => item.searchText.includes(part));
      })
      .sort((a, b) => {
        if (!query) return 0;
        const rank = (item) => {
          const asset = String(item.asset || "").toUpperCase();
          const symbol = String(item.symbol || "").toUpperCase();
          const title = String(item.title || "").toUpperCase();
          if (asset === query || symbol === query || title === query) return 0;
          if (asset.startsWith(query) || symbol.startsWith(query) || title.startsWith(query)) return 1;
          return 2;
        };
        return rank(a) - rank(b) || String(a.asset).localeCompare(String(b.asset));
      })
      .slice(0, 120);
  });

  async function loadMarketStrip() {
    if (!authed()) {
      setMarketStripStatus("Waiting for session");
      return;
    }
    const results = await Promise.all(MARKET_STRIP_SYMBOLS.map(async (item) => {
      // MCX commodities (CRUDEOIL, NATURALGAS) are not available via the optionchains REST endpoint.
      // Their prices arrive via the WebSocket index feed — skip the REST fetch for them.
      if (item.exchange === "MCX") return { ...item, price: null, change: null, ok: false };
      let lastError = "";
      for (const instrument of item.instruments || [item.instrument]) {
        const suffix = item.exchange && item.exchange !== "NSE" ? `?exchange=${encodeURIComponent(item.exchange)}` : "";
        const path = `optionchains/${encodeURIComponent(instrument)}/price${suffix}`;
        try {
          const data = await nubraFetch(path);
          return {
            ...item,
            instrument,
            price: data?.price,
            prevClose: data?.prev_close,
            change: data?.change,
            ok: data?.price != null || data?.change != null
          };
        } catch (error) {
          lastError = error.message;
        }
      }
      return { ...item, price: null, change: null, ok: false, error: lastError };
    }));
    setMarketStrip(results);
    setMarketStripStatus(results.some((item) => item.ok) ? "Live snapshot" : "Market data unavailable");
  }

  function stopMarketStripLive() {
    if (marketStripCutoffTimer) { clearTimeout(marketStripCutoffTimer); marketStripCutoffTimer = null; }
    if (marketStripReconnectTimer) {
      window.clearTimeout(marketStripReconnectTimer);
      marketStripReconnectTimer = null;
    }
    const socket = marketStripSocket;
    marketStripSocket = null;
    if (socket) socket.close();
  }

  function startMarketStripLive() {
    stopMarketStripLive();
    resetSpotMonitor();
    if (!authed()) return;
    // Use MCX hours (23:30) as the strip includes commodities that trade till 11:30 PM
    if (!isMarketHours("MCX")) { setMarketStripStatus("Market closed"); return; }
    const ms = msUntilMarketClose("MCX");
    if (ms > 0) marketStripCutoffTimer = setTimeout(() => { stopMarketStripLive(); setMarketStripStatus("Market closed"); }, ms);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws/live`);
    marketStripSocket = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({
        type: "subscribe",
        environment: environment().includes("uat") ? "uat" : "prod",
        token: token().replace("Bearer ", "").trim(),
        deviceId: deviceId().trim(),
        indexSubscriptions: [
          { exchange: "NSE", symbols: ["NIFTY", "BANKNIFTY"] },
          { exchange: "BSE", symbols: ["SENSEX"] },
          { exchange: "MCX", symbols: ["CRUDEOIL", "NATURALGAS"] }
        ]
      }));
      setMarketStripStatus("Connecting live indices");
    };
    socket.onmessage = (event) => {
      if (!isMarketHours("MCX")) { stopMarketStripLive(); setMarketStripStatus("Market closed"); return; }
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.event === "status" && (message.status === "connected" || message.status === "subscribed")) {
        setMarketStripStatus("Live WebSocket");
      }
      if (message.event !== "index" || !message.data) return;
      const ticks = Array.isArray(message.data) ? message.data : [message.data];
      for (const tick of ticks) {
        const tickName = String(tick?.indexname || tick?.index_name || tick?.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        const tickExchange = String(tick?.exchange || "").toUpperCase();
        const tickPrice = tick.index_value ?? tick.indexValue;
        const tickPrevClose = tick.prev_close ?? tick.prevClose;
        if (tickName && tickPrice != null) analyzeSpotTick(tickName, tickPrice, tickPrevClose);
        setMarketStrip((items) => items.map((item) => {
          const itemName = String(item.instrument || item.label).toUpperCase().replace(/[^A-Z0-9]/g, "");
          if (itemName !== tickName || (tickExchange && item.exchange !== tickExchange)) return item;
          return {
            ...item,
            price: tickPrice ?? item.price,
            prevClose: tickPrevClose ?? item.prevClose,
            change: tick.changepercent ?? tick.change_percent ?? tick.changePercent ?? item.change,
            ok: true
          };
        }));
      }
    };
    socket.onerror = () => setMarketStripStatus("Live stream reconnecting");
    socket.onclose = () => {
      if (marketStripSocket !== socket) return;
      marketStripSocket = null;
      setMarketStripStatus("Live stream reconnecting");
      if (authed() && isMarketHours("MCX")) marketStripReconnectTimer = window.setTimeout(startMarketStripLive, 3000);
    };
  }

  async function run(action) {
    setBusy(true);
    setToast("");
    try {
      await action();
    } catch (error) {
      setToast(error.message || "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function startLogin() {
    const cleanPhone = digits(phone());
    if (cleanPhone.length < 10) throw new Error("Enter a valid Nubra phone number.");
    setPhone(cleanPhone);
    setDeviceId(deviceIdForPhone(cleanPhone));
    saveAuthInputs();
    setLoginStatus(authMethod() === "totp" ? "TOTP mode ready" : "Starting OTP login");
    const response = await fetch("/api/auth/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phone: cleanPhone,
        auth_method: authMethod(),
        environment: environment().includes("uat") ? "UAT" : "PROD"
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || data.message || "Unable to start Nubra login.");
    setFlowId(data.flow_id || "");
    sessionStorage.setItem("nubraFlowId", data.flow_id || "");
    if (data.device_id) {
      setDeviceId(data.device_id);
      localStorage.setItem("nubraDeviceId", data.device_id);
    }
    setLoginStatus(data.message || "Code sent. Verify and enter MPIN.");
  }

  async function verifyCode() {
    if (!flowId()) throw new Error("Start login first.");
    if (!otp().trim()) throw new Error("OTP or TOTP is required.");
    const endpoint = authMethod() === "totp" ? "/api/auth/verify-totp" : "/api/auth/verify-otp";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(authMethod() === "totp"
        ? { flow_id: flowId(), totp: otp().trim() }
        : { flow_id: flowId(), otp: otp().trim() })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || data.message || "Verification failed.");
    setLoginStatus(data.message || "Code verified. Enter MPIN.");
  }

  async function verifyMpin() {
    if (!flowId()) throw new Error("Start login first.");
    if (!mpin().trim()) throw new Error("MPIN is required.");
    const response = await fetch("/api/auth/verify-mpin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_id: flowId(), mpin: mpin().trim() })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || data.message || "MPIN incorrect.");
    if (!data.access_token) throw new Error("Nubra did not return session_token.");
    setToken(data.access_token);
    localStorage.setItem("nubraSessionToken", data.access_token);
    if (data.device_id) {
      setDeviceId(data.device_id);
      localStorage.setItem("nubraDeviceId", data.device_id);
    }
    setOtp("");
    setMpin("");
    setFlowId("");
    sessionStorage.removeItem("nubraFlowId");
    setLoginStatus(data.message || "Logged in");
    try {
      await refreshAllScripts();
    } catch (error) {
      setScriptStatus(error.message || "Script download failed");
    }
  }

  function initPriceChart() {
    if (priceChart || !priceChartHost) return;
    if (!window.LightweightCharts) {
      window.setTimeout(initPriceChart, 100);
      return;
    }
    priceChart = makeChart(priceChartHost, { timeScale: { timeVisible: true, secondsVisible: false } });
    if (!priceChart) {
      window.setTimeout(initPriceChart, 100);
      return;
    }
    const options = {
      upColor: "#10B981",
      downColor: "#EF4444",
      borderUpColor: "#10B981",
      borderDownColor: "#EF4444",
      wickUpColor: "#10B981",
      wickDownColor: "#EF4444"
    };
    candleSeries = priceChart.addCandlestickSeries
      ? priceChart.addCandlestickSeries(options)
      : priceChart.addSeries(window.LightweightCharts.CandlestickSeries, options);
    queueChartResize();
  }

  function smartOiIndicatorRows() {
    const rows = [...smartOiHistory()]
      .map((row) => ({
        t: Math.floor(Number(row.t) / 60000) * 60000,
        ceOi: Number(row.ceOi),
        peOi: Number(row.peOi)
      }))
      .filter((row) => Number.isFinite(row.t) && Number.isFinite(row.ceOi) && Number.isFinite(row.peOi))
      .sort((a, b) => a.t - b.t);
    const opening = rows.find((row) => row.ceOi > 0 || row.peOi > 0);
    if (!opening) return [];
    const openingValue = opening.ceOi + opening.peOi;
    return rows
      .filter((row) => row.t >= opening.t && (row.ceOi > 0 || row.peOi > 0))
      .map((row) => {
        const value = (row.ceOi + row.peOi) - openingValue;
        return {
          time: tvTime(row.t),
          value,
          color: value >= 0 ? "rgba(16,185,129,0.78)" : "rgba(239,68,68,0.78)"
        };
      });
  }

  function ensureSmartOiSeries() {
    if (!priceChart || smartOiSeries) return;
    const options = {
      title: "Smart OI",
      priceScaleId: "smartOi",
      priceFormat: { type: "volume" },
      base: 0,
      lastValueVisible: true,
      priceLineVisible: true
    };
    smartOiSeries = priceChart.addHistogramSeries
      ? priceChart.addHistogramSeries(options)
      : priceChart.addSeries(window.LightweightCharts.HistogramSeries, options);
    priceChart.priceScale("smartOi").applyOptions({
      scaleMargins: { top: 0.72, bottom: 0.06 },
      borderColor: "rgba(59,130,246,0.35)",
      visible: true
    });
    smartOiPriceLine = smartOiSeries.createPriceLine?.({
      price: 0,
      color: "rgba(59,130,246,0.50)",
      lineWidth: 1,
      lineStyle: window.LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: false,
      title: "0"
    });
  }

  function renderSmartOiIndicator() {
    if (!smartOiIndicatorEnabled()) return;
    initPriceChart();
    ensureSmartOiSeries();
    const data = smartOiIndicatorRows();
    smartOiSeries?.setData(data);
    setChartStatus(data.length ? `Smart OI · ${data.length} bars` : "Smart OI · no data");
  }

  function removeSmartOiIndicator() {
    if (smartOiSeries && priceChart) {
      try {
        if (smartOiPriceLine) smartOiSeries.removePriceLine?.(smartOiPriceLine);
        priceChart.removeSeries(smartOiSeries);
      } catch {}
    }
    smartOiSeries = null;
    smartOiPriceLine = null;
  }

  async function toggleSmartOiIndicator() {
    initPriceChart();
    setSection("market");
    setChainNavOpen(false);
    setLabNavOpen(false);
    const chartSymbol = symbol().trim().toUpperCase();
    if (chartSymbol) setChainSymbol(chartSymbol);
    setChainExchange(exchange());
    const chartStartDate = String(startDate() || "").slice(0, 10);
    const chartEndDate = String(endDate() || "").slice(0, 10);
    if (chartStartDate) setOiTsStartDate(chartStartDate);
    if (chartEndDate) setOiTsEndDate(chartEndDate);
    if (smartOiIndicatorEnabled()) {
      setSmartOiIndicatorEnabled(false);
      removeSmartOiIndicator();
      setChartStatus("Smart OI removed");
      return;
    }
    setSmartOiIndicatorEnabled(true);
    if (!candleCount()) await loadPriceChart();
    await loadSmartOiSeries({ attachToChart: true });
  }

  async function loadSpotPrice() {
    setChartStatus("Spot");
    const exchangeName = exchange();
    const priceSymbol = exchangeName === "MCX"
      ? mcxMarketSymbol(symbol(), chainExpiry() || rollExpiry())
      : symbol().trim().toUpperCase();
    const suffix = exchangeName !== "NSE" ? `?exchange=${encodeURIComponent(exchangeName)}` : "";
    const data = await nubraFetch(`optionchains/${encodeURIComponent(priceSymbol)}/price${suffix}`);
    const price = toRupees(data.price);
    setSpot(price == null ? "--" : rupee.format(price));
    setChange(Number.isFinite(data.change) ? `${number.format(data.change)}%` : "--");
    setChartStatus("Ready");
  }

  async function loadPriceChart() {
    initPriceChart();
    if (!candleSeries) throw new Error("Chart engine is still loading. Try Load Chart again in a moment.");
    setChartStatus("Loading");
    const exchangeName = exchange();
    const sym = exchangeName === "MCX"
      ? mcxMarketSymbol(symbol(), chainExpiry() || rollExpiry())
      : symbol().trim().toUpperCase();
    const type = exchangeName === "MCX" && sym.startsWith("FUT_") ? "FUT" : instrumentType();
    const data = await nubraFetch("charts/timeseries", {
      method: "POST",
      body: JSON.stringify({
        query: [{
          exchange: exchangeName,
          type,
          values: [sym],
          fields: ["open", "high", "low", "close"],
          startDate: fromLocalInput(startDate()),
          endDate: fromLocalInput(endDate()),
          interval: interval(),
          intraDay: false,
          realTime: false
        }]
      })
    });
    const symbolData = extractSymbolData(data, sym);
    const byTs = new Map();
    for (const field of ["open", "high", "low", "close"]) {
      for (const point of (Array.isArray(symbolData?.[field]) ? symbolData[field] : [])) {
        const ts = pointMs(point);
        const value = pointNumber(point, true);
        if (!Number.isFinite(ts) || !Number.isFinite(value)) continue;
        const row = byTs.get(ts) || { time: tvTime(ts), open: null, high: null, low: null, close: null };
        row[field] = value;
        byTs.set(ts, row);
      }
    }
    const candles = [...byTs.values()]
      .filter((row) => [row.open, row.high, row.low, row.close].every(Number.isFinite))
      .sort((a, b) => a.time - b.time);
    candleSeries.setData(candles);
    queueChartResize();
    resizeChart(priceChart, priceChartHost);
    priceChart.timeScale().fitContent();
    setCandleCount(candles.length);
    setChartStatus(candles.length ? "Ready" : "No data");
  }

  function normalizeStrike(value) {
    const rupeeValue = toRupees(value);
    return rupeeValue == null ? Number(value) : rupeeValue;
  }

  function optionRowSide(row) {
    return String(row.option_type || row.ot || row.side || "").toUpperCase();
  }

  function optionSymbolAliases(row) {
    return [...new Set([
      row.stock_name,
      row.symbol,
      row.trading_symbol,
      row.tradingsymbol,
      row.display_name,
      row.displayName,
      row.zanskar_name,
      row.nubra_name
    ]
      .map((value) => String(value || "").trim().toUpperCase())
      .filter(Boolean))];
  }

  function preferredMcxFutureAlias(row) {
    const aliases = optionSymbolAliases(row);
    return aliases.find((alias) => alias.startsWith("FUT_")) || aliases[0] || "";
  }

  async function rollingOptionRows() {
    const date = rollStart().slice(0, 10) || new Date().toISOString().slice(0, 10);
    const data = await nubraFetch(refdataPath(date, rollExchange()));
    const refRows = Array.isArray(data.refdata) ? data.refdata : [];
    const sym = rollSymbol().trim().toUpperCase();
    return refRows
      .filter((row) => {
        const asset = String(row.asset || "").toUpperCase();
        const dtype = String(row.derivative_type || "").toUpperCase();
        const side = optionRowSide(row);
        return asset === sym && dtype === "OPT" && (side === "CE" || side === "PE") && optionSymbolAliases(row).length;
      })
      .map((row) => {
        const aliases = optionSymbolAliases(row);
        return {
          name: aliases[0],
          aliases,
          refId: liveRefId(row),
          expiry: String(row.expiry || ""),
          side: optionRowSide(row),
          strike: normalizeStrike(row.strike_price)
        };
      })
      .filter((row) => Number.isFinite(row.strike) && row.expiry && row.name);
  }

  async function loadRollingExpiries() {
    setRollStatus("Refdata");
    const rows = await rollingOptionRows();
    const expiries = [...new Set(rows.map((row) => row.expiry))].sort();
    if (!expiries.length) throw new Error("No option expiries found.");
    setRollExpiries(expiries);
    setRollExpiry((current) => firstValidExpiry(current, expiries));
    setRollStatus(`${expiries.length} expiries`);
    return expiries;
  }

  async function loadOptionChainExpiries() {
    setChainStatus("Expiries");
    const sym = chainSymbol().trim().toUpperCase();
    if (!sym) throw new Error("Option Chain symbol is required.");

    let expiries = [];
    try {
      // The option-chain contract returns all_expiries even when expiry is
      // omitted. Prefer it over date-bound refdata (which can be empty on
      // weekends and exchange holidays).
      const data = await nubraFetch(`optionchains/${encodeURIComponent(sym)}?exchange=${chainExchange()}`);
      const chain = normalizeOptionChainPayload(data, { symbol: sym, exchange: chainExchange() });
      expiries = [...new Set(chain?.all_expiries || [])].sort();
    } catch {
      // Fall back to refdata for API deployments that require expiry.
    }

    if (!expiries.length) {
      const date = dateKey(new Date());
      const data = await nubraFetch(refdataPath(date, chainExchange()));
      const refRows = Array.isArray(data.refdata) ? data.refdata : [];
      expiries = [...new Set(refRows
        .filter((row) => {
          const asset = String(row.asset || "").toUpperCase();
          const dtype = String(row.derivative_type || "").toUpperCase();
          const side = optionRowSide(row);
          return asset === sym && dtype === "OPT" && (side === "CE" || side === "PE") && row.expiry;
        })
        .map((row) => String(row.expiry)))]
        .sort();
    }
    if (!expiries.length) throw new Error("No option expiries found for option chain.");
    setChainExpiries(expiries);
    setChainExpiry((current) => firstValidExpiry(current, expiries));
    setChainStatus(`${expiries.length} expiries`);
    return expiries;
  }

  async function chainOptionRowsForDate(date) {
    const data = await nubraFetch(refdataPath(date, chainExchange()));
    const refRows = Array.isArray(data.refdata) ? data.refdata : [];
    const sym = chainSymbol().trim().toUpperCase();
    const expiry = String(chainData()?.expiry || chainExpiry() || "");
    return refRows
      .filter((row) => {
        const asset = String(row.asset || row.underlying || "").toUpperCase();
        const dtype = String(row.derivative_type || row.asset_type || "").toUpperCase();
        const side = optionRowSide(row);
        return asset === sym && dtype.includes("OPT") && (side === "CE" || side === "PE") && String(row.expiry || "") === expiry;
      })
      .map((row) => {
        const aliases = optionSymbolAliases(row);
        return {
          name: aliases[0],
          aliases,
          side: optionRowSide(row),
          strike: normalizeStrike(row.strike_price ?? row.sp)
        };
      })
      .filter((row) => row.name && Number.isFinite(row.strike));
  }

  function chainSpotType() {
    const sym = chainSymbol().trim().toUpperCase();
    if (chainExchange() === "MCX") return "FUT";
    const indexAssets = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX", "INDIA VIX", "INDIAVIX"]);
    if (indexAssets.has(sym)) return "INDEX";
    const row = (scriptCache().rows || []).find((item) => {
      const asset = String(item.asset || item.symbol || "").trim().toUpperCase();
      return asset === sym && (scriptKind(item) === "INDEX" || String(item.assetType || "").includes("INDEX"));
    });
    return row ? "INDEX" : "STOCK";
  }

  function previousTradingTenWindows(maxCalendarDays = 10) {
    const windows = [];
    for (let offset = 1; offset <= maxCalendarDays; offset += 1) {
      const start = new Date();
      start.setDate(start.getDate() - offset);
      start.setHours(10, 0, 0, 0);
      const day = start.getDay();
      if (day === 0 || day === 6) continue;
      const end = new Date(start.getTime() + 2 * 60 * 1000);
      windows.push({ start, end, targetMs: start.getTime(), date: dateKey(start) });
    }
    return windows;
  }

  function nearestPointValue(points, targetMs, rupeeValue = false) {
    const parsed = (Array.isArray(points) ? points : [])
      .map((point) => ({ ts: pointMs(point), value: pointNumber(point, rupeeValue) }))
      .filter((point) => Number.isFinite(point.ts) && Number.isFinite(point.value) && point.value > 0)
      .sort((a, b) => Math.abs(a.ts - targetMs) - Math.abs(b.ts - targetMs));
    return parsed[0]?.value ?? null;
  }

  async function fetchChainSpotAtPreviousTen(windowInfo) {
    const sym = chainSymbol().trim().toUpperCase();
    const spotSym = chainExchange() === "MCX" ? await resolveMcxMarketSymbol(sym, chainExpiry()) : sym;
    const { data } = await fetchTimeseriesWithIntervals({
      exchange: chainExchange(),
      type: chainSpotType(),
      values: [spotSym],
      fields: ["close"],
      startDate: fromLocalInput(toLocalInput(windowInfo.start)),
      endDate: fromLocalInput(toLocalInput(windowInfo.end)),
      intraDay: false,
      realTime: false
    }, ["1m"]);
    const symbolData = extractSymbolData(data, spotSym);
    return nearestPointValue(symbolData?.close, windowInfo.targetMs, true);
  }

  function ivFromSymbolData(symbolData, targetMs) {
    const mid = nearestPointValue(symbolData?.iv_mid, targetMs, false);
    if (mid != null) return normalizeLiveIv(mid);
    const bid = normalizeLiveIv(nearestPointValue(symbolData?.iv_bid, targetMs, false));
    const ask = normalizeLiveIv(nearestPointValue(symbolData?.iv_ask, targetMs, false));
    if (bid != null && ask != null) return (bid + ask) / 2;
    return bid ?? ask;
  }

  async function fetchChainIvBaselineForWindow(windowInfo) {
    const rows = await chainOptionRowsForDate(windowInfo.date);
    const strikes = [...new Set(rows.map((row) => row.strike))].sort((a, b) => a - b);
    if (!strikes.length) throw new Error(`No option rows on ${windowInfo.date}.`);
    const spot = await fetchChainSpotAtPreviousTen(windowInfo);
    if (!Number.isFinite(spot)) throw new Error(`No 10:00 spot close on ${windowInfo.date}.`);
    const strike = nearestStrike(spot, strikes, inferStrikeStep(strikes));
    const ce = rows.find((row) => row.strike === strike && row.side === "CE");
    const pe = rows.find((row) => row.strike === strike && row.side === "PE");
    const aliases = [...new Set([...(ce?.aliases || []), ...(pe?.aliases || [])])];
    if (!aliases.length) throw new Error("No CE/PE symbols for IV baseline strike.");

    const { data } = await fetchTimeseriesWithIntervals({
      exchange: chainExchange(),
      type: "OPT",
      values: aliases,
      fields: ["iv_mid", "iv_bid", "iv_ask"],
      startDate: fromLocalInput(toLocalInput(windowInfo.start)),
      endDate: fromLocalInput(toLocalInput(windowInfo.end)),
      intraDay: false,
      realTime: false
    }, ["1m"]);

    const values = data?.result?.[0]?.values || [];
    const ivByName = new Map();
    for (const entry of values) {
      for (const [name, symbolData] of Object.entries(entry || {})) {
        const iv = ivFromSymbolData(symbolData, windowInfo.targetMs);
        if (iv != null) ivByName.set(String(name).toUpperCase(), iv);
      }
    }
    const legIv = (row) => (row?.aliases || []).map((name) => ivByName.get(String(name).toUpperCase())).find((value) => value != null);
    const ivs = [legIv(ce), legIv(pe)].filter((value) => value != null);
    if (!ivs.length) throw new Error(`No 10:00 CE/PE IV on ${windowInfo.date}.`);
    const avgIv = ivs.reduce((sum, value) => sum + value, 0) / ivs.length;
    console.log("[Option Chain] Previous trading-session 10:00 IV", {
      date: windowInfo.date,
      symbol: chainSymbol().trim().toUpperCase(),
      exchange: chainExchange(),
      expiry: chainData()?.expiry || chainExpiry(),
      spotClose: spot,
      strike,
      ceIv: legIv(ce) ?? null,
      peIv: legIv(pe) ?? null,
      avgIv,
      avgIvText: formatPlain(avgIv, 2)
    });
    return { baseIv: avgIv, baseDate: windowInfo.date };
  }

  async function fetchChainIvBaseline() {
    let lastError = null;
    for (const windowInfo of previousTradingTenWindows()) {
      try {
        return await fetchChainIvBaselineForWindow(windowInfo);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("No prior trading-session 10:00 IV found.");
  }

  async function fetchOptionChainSnapshot(sym, expiry) {
    const data = await nubraFetch(`optionchains/${encodeURIComponent(sym)}?exchange=${chainExchange()}&expiry=${encodeURIComponent(expiry)}`);
    const chain = normalizeOptionChainPayload(data, {
      symbol: sym,
      exchange: chainExchange(),
      expiry
    });
    if (!chain) throw new Error("No option chain returned.");
    if (!(Array.isArray(chain.ce) && chain.ce.length) && !(Array.isArray(chain.pe) && chain.pe.length)) {
      throw new Error("The option-chain response contains no CE or PE rows.");
    }
    return chain;
  }

  function ivTermPointFromChain(chain, expiry) {
    const byStrike = new Map();
    for (const ce of Array.isArray(chain?.ce) ? chain.ce : []) {
      const strike = chainStrikeInRupees(ce.sp ?? ce.strike_price, chain);
      if (Number.isFinite(strike)) byStrike.set(strike, { ...(byStrike.get(strike) || { strike }), ce });
    }
    for (const pe of Array.isArray(chain?.pe) ? chain.pe : []) {
      const strike = chainStrikeInRupees(pe.sp ?? pe.strike_price, chain);
      if (Number.isFinite(strike)) byStrike.set(strike, { ...(byStrike.get(strike) || { strike }), pe });
    }
    const rows = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
    if (!rows.length) return null;

    const spot = toRupees(chain?.cp ?? chain?.currentprice ?? chain?.current_price);
    const reportedAtm = chainStrikeInRupees(chain?.atm ?? chain?.at_the_money_strike, chain);
    const target = Number.isFinite(reportedAtm) ? reportedAtm : spot;
    const atmRow = Number.isFinite(target)
      ? rows.reduce((best, row) => !best || Math.abs(row.strike - target) < Math.abs(best.strike - target) ? row : best, null)
      : rows[Math.floor(rows.length / 2)];
    const ceIv = chainOptionIv(atmRow?.ce);
    const peIv = chainOptionIv(atmRow?.pe);
    const ivs = [ceIv, peIv].filter(Number.isFinite);
    if (!ivs.length) return null;

    return {
      expiry: String(chain?.expiry || expiry),
      dte: daysUntilExpiry(chain?.expiry || expiry),
      spot,
      strike: atmRow.strike,
      ceIv,
      peIv,
      atmIv: ivs.reduce((sum, value) => sum + value, 0) / ivs.length
    };
  }

  function smileSurfaceFromChain(chain, expiry) {
    let ceOptions = Array.isArray(chain?.ce) ? chain.ce : [];
    let peOptions = Array.isArray(chain?.pe) ? chain.pe : [];
    const ceDeltaSigns = ceOptions.reduce((counts, option) => {
      const delta = rawNumber(option?.delta);
      if (delta > 0) counts.positive += 1;
      if (delta < 0) counts.negative += 1;
      return counts;
    }, { positive: 0, negative: 0 });
    if (ceDeltaSigns.negative > ceDeltaSigns.positive && ceDeltaSigns.negative > 3) {
      [ceOptions, peOptions] = [peOptions, ceOptions];
    }

    const byStrike = new Map();
    for (const option of ceOptions) {
      const strike = chainStrikeInRupees(option.sp ?? option.strike_price, chain);
      const iv = chainOptionIv(option);
      if (!Number.isFinite(strike)) continue;
      byStrike.set(strike, { ...(byStrike.get(strike) || { strike }), ceIv: iv, ceDelta: rawNumber(option.delta) });
    }
    for (const option of peOptions) {
      const strike = chainStrikeInRupees(option.sp ?? option.strike_price, chain);
      const iv = chainOptionIv(option);
      if (!Number.isFinite(strike)) continue;
      byStrike.set(strike, { ...(byStrike.get(strike) || { strike }), peIv: iv, peDelta: rawNumber(option.delta) });
    }
    const rows = [...byStrike.values()]
      .filter((row) => Number.isFinite(row.ceIv) || Number.isFinite(row.peIv))
      .sort((a, b) => a.strike - b.strike);
    if (!rows.length) return null;

    const reportedAtm = chainStrikeInRupees(chain?.atm ?? chain?.at_the_money_strike, chain);
    const spot = toRupees(chain?.cp ?? chain?.currentprice ?? chain?.current_price);
    const atmTarget = Number.isFinite(reportedAtm) ? reportedAtm : spot;
    const atmRow = rows.reduce((best, row) => !best || Math.abs(row.strike - atmTarget) < Math.abs(best.strike - atmTarget) ? row : best, null);
    const atmIvs = [atmRow?.ceIv, atmRow?.peIv].filter(Number.isFinite);
    const atmIv = atmIvs.length ? atmIvs.reduce((sum, value) => sum + value, 0) / atmIvs.length : null;
    const normalizedDelta = (value) => {
      const delta = Math.abs(Number(value));
      return Number.isFinite(delta) ? (delta > 1 ? delta / 100 : delta) : null;
    };
    const nearestDeltaRow = (side) => rows
      .filter((row) => Number.isFinite(row[`${side}Iv`]) && normalizedDelta(row[`${side}Delta`]) != null)
      .sort((a, b) => Math.abs(normalizedDelta(a[`${side}Delta`]) - 0.25) - Math.abs(normalizedDelta(b[`${side}Delta`]) - 0.25))[0];
    const call25 = nearestDeltaRow("ce");
    const put25 = nearestDeltaRow("pe");
    const call25Iv = call25?.ceIv ?? null;
    const put25Iv = put25?.peIv ?? null;
    const rr25 = Number.isFinite(call25Iv) && Number.isFinite(put25Iv) ? call25Iv - put25Iv : null;
    const bf25 = Number.isFinite(call25Iv) && Number.isFinite(put25Iv) && Number.isFinite(atmIv)
      ? (call25Iv + put25Iv) / 2 - atmIv
      : null;
    return {
      expiry: String(chain?.expiry || expiry),
      atmStrike: atmRow?.strike ?? reportedAtm,
      atmIv,
      call25Iv,
      put25Iv,
      call25Strike: call25?.strike ?? null,
      put25Strike: put25?.strike ?? null,
      rr25,
      bf25,
      atmSkew: Number.isFinite(atmRow?.ceIv) && Number.isFinite(atmRow?.peIv) ? atmRow.ceIv - atmRow.peIv : null,
      rows
    };
  }

  function smileSurfaceForExpiry(expiry) {
    return smileSurfaces().find((surface) => surface.expiry === expiry);
  }

  async function fetchIvTermPoint(symbolValue, exchangeValue, expiry) {
    const data = await nubraFetch(`optionchains/${encodeURIComponent(symbolValue)}?exchange=${encodeURIComponent(exchangeValue)}&expiry=${encodeURIComponent(expiry)}`, { timeoutMs: 8000 });
    const chain = normalizeOptionChainPayload(data, { symbol: symbolValue, exchange: exchangeValue, expiry });
    return chain ? { point: ivTermPointFromChain(chain, expiry), surface: smileSurfaceFromChain(chain, expiry) } : null;
  }

  async function loadIvTermStructure() {
    const symbolValue = ivTermSymbol().trim().toUpperCase();
    const exchangeValue = ivTermExchange();
    if (!symbolValue) throw new Error("Underlying is required for IV Term Structure.");
    setIvTermPoints([]);
    setSmileSurfaces([]);
    setSmileExpiry("");
    setIvTermStatus("Loading expiries");

    const metadata = await nubraFetch(`optionchains/${encodeURIComponent(symbolValue)}?exchange=${encodeURIComponent(exchangeValue)}`, { timeoutMs: 10000 });
    const metadataChain = normalizeOptionChainPayload(metadata, { symbol: symbolValue, exchange: exchangeValue });
    const today = Number(dateKey(new Date()).replace(/-/g, ""));
    const allExpiries = [...new Set(metadataChain?.all_expiries || [])].sort((a, b) => expirySortValue(a) - expirySortValue(b));
    const futureExpiries = allExpiries.filter((expiry) => Number(expiry) >= today);
    const expiries = futureExpiries.length ? futureExpiries : allExpiries;
    if (!expiries.length) throw new Error("No option expiries returned for IV Term Structure.");

    const points = [];
    const surfaces = [];
    let cursor = 0;
    let completed = 0;
    const worker = async () => {
      while (cursor < expiries.length) {
        const expiry = expiries[cursor++];
        try {
          const result = await fetchIvTermPoint(symbolValue, exchangeValue, expiry);
          if (result?.point) points.push(result.point);
          if (result?.surface) surfaces.push(result.surface);
        } catch {
          // Keep the curve usable when one expiry is unavailable.
        } finally {
          completed += 1;
          setIvTermStatus(`Loading ${completed}/${expiries.length} expiries`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, expiries.length) }, worker));
    points.sort((a, b) => expirySortValue(a.expiry) - expirySortValue(b.expiry));
    surfaces.sort((a, b) => expirySortValue(a.expiry) - expirySortValue(b.expiry));
    if (!points.length) throw new Error("No ATM IV values were returned across the available expiries.");
    setIvTermPoints(points);
    setSmileSurfaces(surfaces);
    setSmileExpiry((current) => surfaces.some((surface) => surface.expiry === current) ? current : surfaces[0]?.expiry || "");
    setIvTermStatus(`${points.length} expiries · ${symbolValue} ${exchangeValue}`);
  }

  async function loadOptionChain({ startLive = true } = {}) {
    setChainStatus("Loading");
    const sym = chainSymbol().trim().toUpperCase();
    if (!sym) throw new Error("Option Chain symbol is required.");
    const expiries = chainExpiries().length ? chainExpiries() : await loadOptionChainExpiries();
    const selectedExpiry = chainExpiry();
    const candidates = selectedExpiry
      ? [selectedExpiry, ...expiries.filter((expiry) => expiry !== selectedExpiry)]
      : expiries;
    if (!candidates.length) throw new Error("Option Chain expiry is required.");

    let lastError;
    for (const expiry of candidates) {
      try {
        setChainStatus(`Loading ${expiry}`);
        const chain = await fetchOptionChainSnapshot(sym, expiry);
        const rowCount = chainRowCount(chain);
        if (!rowCount) throw new Error("Option data arrived, but no valid strike-price fields were found.");
        setChainExpiry(String(chain.expiry || expiry));
        if (Array.isArray(chain.all_expiries) && chain.all_expiries.length) {
          setChainExpiries(chain.all_expiries.map(String).sort());
        }
        // Set the snapshot last. Kobalte can emit onChange when its option list
        // is refreshed; the guarded expiry handler must not clear these rows.
        setChainData(chain);
        setChainStatus(`Ready · ${rowCount} strikes`);
        if (startLive) startChainLive();
        return;
      } catch (err) {
        lastError = err;
        const message = String(err?.message || "");
        if (
          !message.startsWith("400:") &&
          !message.toLowerCase().includes("invalid expiry") &&
          !message.includes("no CE or PE rows")
        ) throw err;
      }
    }

    setChainStatus("No chain");
    throw new Error(lastError?.message || "No valid option-chain expiry found.");
  }

  function normalizeLiveOption(option) {
    if (!option || typeof option !== "object") return option;
    return {
      ...option,
      sp: option.sp ?? option.strike_price ?? option.strikePrice ?? option.strike,
      strike_price: option.strike_price ?? option.strikePrice ?? option.strike ?? option.sp,
      ltp: option.ltp ?? option.last_traded_price,
      oi: option.oi ?? option.open_interest,
      previous_oi: option.previous_oi ?? option.previous_open_interest,
      option_type: option.option_type ?? option.side
    };
  }

  function liveOptionKey(option) {
    const refId = option?.ref_id ?? option?.refId;
    if (refId != null && refId !== "") return `ref:${refId}`;
    const strike = option?.sp ?? option?.strike_price ?? option?.strikePrice ?? option?.strike;
    return strike != null && strike !== "" ? `strike:${strike}` : "";
  }

  function mergeLiveOptions(previousOptions, incomingOptions) {
    const previous = Array.isArray(previousOptions) ? previousOptions : [];
    const incoming = (Array.isArray(incomingOptions) ? incomingOptions : [])
      .map(normalizeLiveOption)
      .filter((option) => liveOptionKey(option));
    if (!incoming.length) return previous;

    const merged = new Map();
    for (const option of previous) {
      const key = liveOptionKey(option);
      if (key) merged.set(key, option);
    }
    for (const option of incoming) {
      const key = liveOptionKey(option);
      merged.set(key, { ...(merged.get(key) || {}), ...option });
    }
    return [...merged.values()];
  }

  function chainRowCount(chain) {
    const strikes = new Set();
    for (const option of [
      ...(Array.isArray(chain?.ce) ? chain.ce : []),
      ...(Array.isArray(chain?.pe) ? chain.pe : [])
    ]) {
      const strike = chainStrikeInRupees(
        option?.sp ?? option?.strike_price ?? option?.strikePrice ?? option?.strike,
        chain
      );
      if (Number.isFinite(strike)) strikes.add(strike);
    }
    return strikes.size;
  }

  function normalizeLiveChain(chain) {
    const packet = Array.isArray(chain)
      ? chain.find((item) =>
          String(item?.asset || "").toUpperCase() === chainSymbol().trim().toUpperCase() &&
          (!item?.expiry || String(item.expiry) === String(chainExpiry()))
        ) || chain[0]
      : chain;
    if (!packet || typeof packet !== "object") return null;
    const previous = chainData() || {};
    const incomingCe = [packet.ce, packet.CE, packet.calls, packet.call_options].find(Array.isArray);
    const incomingPe = [packet.pe, packet.PE, packet.puts, packet.put_options].find(Array.isArray);
    return {
      ...previous,
      ...packet,
      asset: packet.asset ?? previous.asset ?? chainSymbol().trim().toUpperCase(),
      expiry: packet.expiry ?? previous.expiry ?? chainExpiry(),
      exchange: packet.exchange ?? previous.exchange ?? chainExchange(),
      cp: packet.cp ?? packet.currentprice ?? packet.current_price ?? packet.spot_price ?? previous.cp,
      atm: packet.atm ?? packet.at_the_money_strike ?? packet.atm_strike ?? previous.atm,
      ce: mergeLiveOptions(previous.ce, incomingCe),
      pe: mergeLiveOptions(previous.pe, incomingPe),
      all_expiries: previous.all_expiries || chainExpiries()
    };
  }

  function firstRawPriceLevel(levels) {
    const level = Array.isArray(levels) ? levels[0] : null;
    const price = Number(level?.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  }

  function normalizeLiveQuoteTick(tick) {
    if (!tick || typeof tick !== "object") return null;
    const bid = firstRawPriceLevel(tick.bids);
    const ask = firstRawPriceLevel(tick.asks);
    const midpoint = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : bid ?? ask ?? null;
    return {
      ...tick,
      ltp: tick.ltp ?? tick.last_traded_price ?? tick.lastTradedPrice ?? midpoint,
      last_traded_price: tick.last_traded_price ?? tick.lastTradedPrice ?? tick.ltp ?? midpoint,
      bid_price: tick.bid_price ?? bid,
      ask_price: tick.ask_price ?? ask
    };
  }

  function mergeChainLiveTicks(payload) {
    const current = chainData();
    if (!current) return;
    const updatesByRef = new Map();
    eachLivePayload(payload, (tick) => {
      const refId = liveRefId(tick);
      const update = normalizeLiveQuoteTick(tick);
      if (refId && update) updatesByRef.set(refId, { ...(updatesByRef.get(refId) || {}), ...update });
    });
    if (!updatesByRef.size) return;
    const mergeSide = (options) => (Array.isArray(options) ? options : []).map((option) => {
      const refId = liveRefId(option);
      return refId && updatesByRef.has(refId)
        ? normalizeLiveOption({ ...option, ...updatesByRef.get(refId) })
        : option;
    });
    const next = {
      ...current,
      ce: mergeSide(current.ce),
      pe: mergeSide(current.pe)
    };
    pendingChainData = next;
    if (!chainRafId) chainRafId = requestAnimationFrame(flushChainData);
  }

  function flushChainData() {
    chainRafId = null;
    if (!pendingChainData) return;
    const next = pendingChainData;
    pendingChainData = null;
    analyzeChainTick(next);
    setChainData(next);
    if (next.expiry) setChainExpiry(String(next.expiry));
    setChainStatus(`Live · ${chainRowCount(next)} strikes`);
  }

  function handleChainLiveTick(chain) {
    const next = normalizeLiveChain(chain);
    if (!next) return;
    if (!chainRowCount(next)) return;
    pendingChainData = next;
    if (!chainRafId) chainRafId = requestAnimationFrame(flushChainData);
  }

  function startChainLive() {
    resetChainMonitor();
    if (chainCutoffTimer) { clearTimeout(chainCutoffTimer); chainCutoffTimer = null; }
    if (chainLiveSocket) { chainLiveSocket.close(); chainLiveSocket = null; }
    const _chainExch = chainExchange();
    if (!isMarketHours(_chainExch)) {
      const rowCount = chainRowCount(chainData());
      setChainStatus(rowCount ? `${rowCount} strikes · Market closed` : "Market closed");
      return;
    }
    const cutoffMs = msUntilMarketClose(_chainExch);
    if (cutoffMs > 0) chainCutoffTimer = setTimeout(() => { stopChainLive(); setChainStatus("Market closed"); }, cutoffMs);
    const sym = chainSymbol().trim().toUpperCase();
    const expiry = chainData()?.expiry || chainExpiry();
    const refIds = [...new Set([
      ...(Array.isArray(chainData()?.ce) ? chainData().ce : []),
      ...(Array.isArray(chainData()?.pe) ? chainData().pe : [])
    ]
      .map((option) => option?.ref_id ?? option?.refId)
      .filter((refId) => refId != null && refId !== ""))];
    if (!sym) { setChainStatus("Symbol needed"); return; }
    if (!expiry) { setChainStatus("Load/select expiry first"); return; }
    if (!token().trim() || !deviceId().trim()) { setChainStatus("Session needed"); return; }

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws/live`);
    chainLiveSocket = ws;
    setChainStatus("Live starting");
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "subscribe",
        environment: environment().includes("uat") ? "uat" : "prod",
        token: token().replace("Bearer ", "").trim(),
        deviceId: deviceId().trim(),
        symbol: sym,
        spotSymbol: sym,
        exchange: chainExchange(),
        interval: "1m",
        expiry,
        refIds
      }));
      setChainLive(true);
      setChainStatus("Live subscribing");
    };
    ws.onmessage = (event) => {
      if (!isMarketHours(chainExchange())) { stopChainLive(); setChainStatus("Market closed"); return; }
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.event === "option" && msg.data) handleChainLiveTick(msg.data);
      if ((msg.event === "orderbook" || msg.event === "greeks") && msg.data) mergeChainLiveTicks(msg.data);
      if (msg.event === "status" && msg.status === "connected") setChainStatus("Live connected");
      if (msg.event === "status" && msg.status === "subscribed") {
        const rowCount = chainRowCount(chainData());
        setChainStatus(rowCount ? `Live · ${rowCount} strikes` : "Live connected · waiting for chain");
      }
      if (msg.event === "status" && msg.status === "bridge-exit") setChainStatus(`Live bridge exited ${msg.code ?? ""}`.trim());
      if (msg.event === "log" && msg.message) setChainStatus(msg.message.slice(0, 80));
      if (msg.event === "error") setChainStatus(msg.message || "Live error");
    };
    ws.onclose = () => {
      if (chainLiveSocket !== ws) return;
      chainLiveSocket = null;
      setChainLive(false);
      setChainStatus("Live stopped");
    };
    ws.onerror = () => setChainStatus("WS error");
  }

  function stopChainLive() {
    if (chainCutoffTimer) { clearTimeout(chainCutoffTimer); chainCutoffTimer = null; }
    if (chainRafId) { cancelAnimationFrame(chainRafId); chainRafId = null; pendingChainData = null; }
    if (chainLiveSocket) {
      try { chainLiveSocket.send(JSON.stringify({ type: "stop" })); } catch {}
      chainLiveSocket.close();
      chainLiveSocket = null;
    }
    setChainLive(false);
    setChainStatus("Ready");
  }

  function inferStrikeStep(strikes) {
    const unique = [...new Set(strikes)].sort((a, b) => a - b);
    let step = Infinity;
    for (let i = 1; i < unique.length; i++) {
      const diff = unique[i] - unique[i - 1];
      if (diff > 0) step = Math.min(step, diff);
    }
    return Number.isFinite(step) ? step : 50;
  }

  function nearestStrike(price, strikes, step) {
    const target = Math.round(price / step) * step;
    return strikes.reduce((best, strike) =>
      Math.abs(strike - target) < Math.abs(best - target) ? strike : best, strikes[0]);
  }

  // Gamma flip level from a per-strike signed-GEX list ([{strike, gex}], any order).
  // The flip is where per-strike GEX crosses from ≤0 (put-dominated) to >0
  // (call-dominated) — the red→green bar crossing on the chart — picking the
  // crossing nearest spot. Bar-crossing sits near spot and matches the chart; a
  // cumulative-sum method floats the flip out into the wings (wrong).
  function flipFromPerStrike(perStrike, spot) {
    if (!Array.isArray(perStrike) || perStrike.length < 2) return null;
    const sorted = [...perStrike].sort((a, b) => a.strike - b.strike);
    const crossings = [];
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1], b = sorted[i];
      const ga = a.gex || 0, gb = b.gex || 0;
      if (ga <= 0 && gb > 0 && gb !== ga) {
        crossings.push(a.strike + (b.strike - a.strike) * (-ga / (gb - ga)));
      }
    }
    if (!crossings.length) return null;
    if (!Number.isFinite(spot)) return crossings[crossings.length - 1];
    return crossings.reduce((best, x) => Math.abs(x - spot) < Math.abs(best - spot) ? x : best, crossings[0]);
  }

  function symbolDataHasPoints(symData) {
    return ["l1bid", "l1ask", "iv_bid", "iv_ask", "iv_mid", "close", "open", "high", "low"].some((field) =>
      Array.isArray(symData?.[field]) && symData[field].length
    );
  }

  function parseRollingSeriesValues(values, seriesByName, aliasToCanonical) {
    for (const entry of values) {
      for (const [name, symData] of Object.entries(entry)) {
        const keyName = String(name || "").toUpperCase();
        if (!symbolDataHasPoints(symData)) continue;
        const canonicalName = aliasToCanonical.get(keyName) || keyName;
        const parsePoints = (arr, rupee = false) =>
          (Array.isArray(arr) ? arr : [])
            .map((p) => ({ ts: pointMs(p), v: pointNumber(p, rupee) }))
            .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.v))
            .sort((a, b) => a.ts - b.ts);
        const close = parsePoints(symData?.close, true);
        const open = parsePoints(symData?.open, true);
        const bid = parsePoints(symData?.l1bid, true);
        const ask = parsePoints(symData?.l1ask, true);
        const ivMid = parsePoints(symData?.iv_mid, false);
        const priceFallback = close.length ? close : open;
        const series = {
          bid: bid.length ? bid : priceFallback,
          ask: ask.length ? ask : priceFallback,
          // LTP per interval = candle close (fallback to open). Used by Premium
          // Decay so it tracks last traded price instead of the bid/ask mid.
          ltp: close.length ? close : open,
          ivBid: parsePoints(symData?.iv_bid, false),
          ivAsk: parsePoints(symData?.iv_ask, false),
          ivMid
        };
        if ((series.bid.length || series.ask.length) && !seriesByName.has(canonicalName)) {
          seriesByName.set(canonicalName, series);
        }
        if ((series.bid.length || series.ask.length) && !seriesByName.has(keyName)) {
          seriesByName.set(keyName, series);
        }
      }
    }
  }

  async function fetchRollingBatch(batch, start, end, intervalValue) {
    const requests = rollExchange() === "MCX"
      ? [
          { type: "OPT", fields: ["l1bid", "l1ask", "iv_bid", "iv_ask", "iv_mid", "close"] },
          { type: "CHAIN", fields: ["l1bid", "l1ask", "iv_bid", "iv_ask", "iv_mid", "close"] }
        ]
      : [{ type: "OPT", fields: ["l1bid", "l1ask", "iv_bid", "iv_ask", "close"] }];
    let lastError = null;
    for (const request of requests) {
      try {
        const { data } = await fetchTimeseriesWithIntervals({
          exchange: rollExchange(),
          type: request.type,
          values: batch,
          fields: request.fields,
          startDate: start,
          endDate: end,
          intraDay: false,
          realTime: false
        }, [intervalValue]);
        const values = data?.result?.[0]?.values || [];
        if (values.some((entry) => Object.values(entry || {}).some(symbolDataHasPoints))) return values;
      } catch (error) {
        lastError = error;
        const message = String(error?.message || "");
        if (message.startsWith("400:") && intervalValue === "1s") {
          try {
            const { data } = await fetchTimeseriesWithIntervals({
              exchange: rollExchange(),
              type: request.type,
              values: batch,
              fields: request.fields,
              startDate: start,
              endDate: end,
              intraDay: false,
              realTime: false
            }, ["1m"]);
            const values = data?.result?.[0]?.values || [];
            if (values.some((entry) => Object.values(entry || {}).some(symbolDataHasPoints))) return values;
          } catch (fallbackError) {
            lastError = fallbackError;
          }
        }
      }
    }
    if (lastError) throw lastError;
    return [];
  }

  async function fetchRollingSeries(names, start, end, aliasToCanonical = new Map(), intervalValue = "1s") {
    const seriesByName = new Map();
    const batches = [];
    for (let i = 0; i < names.length; i += ROLLING_BATCH_SIZE) {
      batches.push(names.slice(i, i + ROLLING_BATCH_SIZE));
    }
    let cursor = 0;
    let completed = 0;
    let firstError = null;
    const workerCount = Math.min(ROLLING_FETCH_CONCURRENCY, batches.length);
    setRollStatus(`Fetching 0/${batches.length} batches`);

    const worker = async () => {
      while (cursor < batches.length) {
        const batchIndex = cursor;
        cursor += 1;
        try {
          const values = await fetchRollingBatch(batches[batchIndex], start, end, intervalValue);
          parseRollingSeriesValues(values, seriesByName, aliasToCanonical);
        } catch (error) {
          firstError ??= error;
        } finally {
          completed += 1;
          setRollStatus(`Fetching ${completed}/${batches.length} batches`);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, worker));
    if (!seriesByName.size && firstError) throw firstError;
    return seriesByName;
  }

  function advanceQuote(name, seriesByName, cursorByName, ts) {
    const keyName = String(name || "").toUpperCase();
    const series = seriesByName.get(keyName);
    if (!series) return { bid: 0, ask: 0, ivBid: null, ivAsk: null, ivMid: null };
    const cursor = cursorByName.get(keyName) || { bidIndex: 0, askIndex: 0, ivBidIndex: 0, ivAskIndex: 0, ivMidIndex: 0, bid: 0, ask: 0, ivBid: null, ivAsk: null, ivMid: null };
    while (cursor.bidIndex < series.bid.length && series.bid[cursor.bidIndex].ts <= ts) {
      cursor.bid = series.bid[cursor.bidIndex].v;
      cursor.bidIndex += 1;
    }
    while (cursor.askIndex < series.ask.length && series.ask[cursor.askIndex].ts <= ts) {
      cursor.ask = series.ask[cursor.askIndex].v;
      cursor.askIndex += 1;
    }
    while (cursor.ivBidIndex < (series.ivBid?.length || 0) && series.ivBid[cursor.ivBidIndex].ts <= ts) {
      cursor.ivBid = series.ivBid[cursor.ivBidIndex].v;
      cursor.ivBidIndex += 1;
    }
    while (cursor.ivAskIndex < (series.ivAsk?.length || 0) && series.ivAsk[cursor.ivAskIndex].ts <= ts) {
      cursor.ivAsk = series.ivAsk[cursor.ivAskIndex].v;
      cursor.ivAskIndex += 1;
    }
    while (cursor.ivMidIndex < (series.ivMid?.length || 0) && series.ivMid[cursor.ivMidIndex].ts <= ts) {
      cursor.ivMid = series.ivMid[cursor.ivMidIndex].v;
      cursor.ivMidIndex += 1;
    }
    cursorByName.set(keyName, cursor);
    return cursor;
  }

  function firstPriceLevel(levels) {
    const level = Array.isArray(levels) ? levels[0] : null;
    const price = toRupees(level?.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  }

  function liveRefId(rowOrTick) {
    const refId = rowOrTick?.refId ?? rowOrTick?.ref_id ?? rowOrTick?.refid ?? rowOrTick?.refID ?? rowOrTick?.instrument_id;
    return refId == null ? "" : String(refId);
  }

  function liveIv(option) {
    if (!option || typeof option !== "object") return null;
    const directKeys = [
      "iv",
      "IV",
      "iv_mid",
      "ivMid",
      "iv_percent",
      "ivPercent",
      "implied_volatility",
      "impliedVolatility",
      "volatility"
    ];
    for (const key of directKeys) {
      const value = normalizeLiveIv(option[key]);
      if (value != null) return value;
    }
    const bidIv = normalizeLiveIv(option.iv_bid ?? option.ivBid ?? option.bid_iv ?? option.bidIv);
    const askIv = normalizeLiveIv(option.iv_ask ?? option.ivAsk ?? option.ask_iv ?? option.askIv);
    if (bidIv != null && askIv != null) return (bidIv + askIv) / 2;
    return bidIv ?? askIv;
  }

  function normalizeLiveIv(raw) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;
    return value <= 1 ? value * 100 : value;
  }

  function eachLivePayload(payload, visit) {
    if (!payload) return;
    if (Array.isArray(payload)) {
      for (const item of payload) eachLivePayload(item, visit);
      return;
    }
    if (typeof payload !== "object") return;
    if (Array.isArray(payload.data)) eachLivePayload(payload.data, visit);
    if (Array.isArray(payload.values)) eachLivePayload(payload.values, visit);
    if (Array.isArray(payload.items)) eachLivePayload(payload.items, visit);
    visit(payload);
  }

  function withPreviewPoint(baseData, time, bid, ask, iv) {
    const data = baseData.map((series) => series.slice());
    const x = data[0];
    let index = x.length - 1;
    if (index >= 0 && x[index] === time) {
      data[1][index] = bid;
      data[2][index] = ask;
      data[3][index] = iv;
    } else {
      x.push(time);
      data[1].push(bid);
      data[2].push(ask);
      data[3].push(iv);
      // Drawn reference lines live at index 5+ (after the running-avg series).
      for (let i = 5; i < data.length; i += 1) {
        const line = rollDrawnLines()[i - 5];
        data[i].push(line ? line.value : null);
      }
    }
    // Recompute the running-average series (index 4) over the previewed data.
    data[4] = computeRunningAvg(data[1], data[2]);
    return data;
  }

  function drawRollPreview(data) {
    if (!rollChart) return;
    rollChartData = data;
    rollChart.setData(rollChartData);
    setRollChartWindow();
    applyRollManualScales();
  }

  function animateRollChartSnapshot(time, target, commit) {
    if (!rollLiveContext || !rollChart) {
      commit();
      return;
    }
    const baseData = rollChartData.map((series) => series.slice());
    if (rollLiveContext.frames.live) cancelAnimationFrame(rollLiveContext.frames.live);
    rollLiveContext.frames.live = null;
    rollLiveContext.lastValues.bid = target.bid;
    rollLiveContext.lastValues.ask = target.ask;
    if (target.ivMid != null) rollLiveContext.lastValues.iv = target.ivMid;
    drawRollPreview(withPreviewPoint(baseData, time, target.bid, target.ask, target.ivMid));
    commit();
  }

  function readLiveLeg(row) {
    if (!rollLiveContext || !row) return null;
    const refId = liveRefId(row);
    const book = refId ? rollLiveContext.orderbookByRef.get(refId) : null;
    const greek = refId ? rollLiveContext.greeksByRef.get(refId) : null;
    const optionTick = refId ? rollLiveContext.optionByRef.get(refId) : null;
    const fallbackPrice = toRupees(
      book?.last_traded_price ??
      book?.ltp ??
      optionTick?.last_traded_price ??
      optionTick?.ltp ??
      greek?.last_traded_price ??
      greek?.ltp ??
      row.last_traded_price ??
      row.ltp
    );
    return {
      bid: firstPriceLevel(book?.bids) ?? fallbackPrice,
      ask: firstPriceLevel(book?.asks) ?? fallbackPrice,
      iv: liveIv(greek) ?? liveIv(optionTick) ?? liveIv(row),
      hasBook: Boolean(book)
    };
  }

  function updateRollLiveSnapshot(receivedAtMs = Date.now()) {
    if (!rollLiveContext || !rollChart) return;
    const { strikes, rowByKey, optionByRef, step, spot } = rollLiveContext;
    if (!spot || spot <= 0) return;

    const atm = nearestStrike(spot, strikes, step);
    let best = null;
    for (const strike of rollCandidateStrikes(atm, strikes, step)) {
      const ceRow = rowByKey.get(`${strike}|CE`);
      const peRow = rowByKey.get(`${strike}|PE`);
      if (!ceRow || !peRow) continue;

      const ce = readLiveLeg(optionByRef.get(ceRow.refId) || ceRow);
      const pe = readLiveLeg(optionByRef.get(peRow.refId) || peRow);
      if (!ce || !pe || !ce.bid || !pe.bid || !ce.ask || !pe.ask) continue;

      const bid = ce.bid + pe.bid;
      const ask = ce.ask + pe.ask;
      const mid = (bid + ask) / 2;
      const ivValues = [ce.iv, pe.iv].filter((value) => Number.isFinite(value) && value > 0);
      const ivMid = ivValues.length ? ivValues.reduce((sum, value) => sum + value, 0) / ivValues.length : null;
      const hasBook = ce.hasBook && pe.hasBook;
      if (!best || mid < best.mid) best = { strike, bid, ask, mid, ivMid, hasBook };
    }
    if (!best) {
      setRollStatus("Live waiting for bid/ask");
      return;
    }

    checkStraddleAlerts(best.mid, best.ivMid);

    const time = tvTime(receivedAtMs);
    animateRollChartSnapshot(time, best, () => {
      setRollChartLines(
        [...rollChartLines.bid, { time, value: best.bid }],
        [...rollChartLines.ask, { time, value: best.ask }],
        best.ivMid != null ? [...rollChartLines.iv, { time, value: best.ivMid }] : rollChartLines.iv,
        false
      );
      setRollChartWindow();

      const nextRow = {
        ts: receivedAtMs,
        spot,
        strike: best.strike,
        bid: best.bid,
        ask: best.ask,
        mid: best.mid,
        ivMid: best.ivMid
      };
      rollLiveContext.points += 1;
      rollExportBuffer.push(nextRow);
      setRollStats((prev) => ({
        ...prev,
        spot: rupee.format(spot),
        strike: number.format(best.strike),
        bid: rupee.format(best.bid),
        ask: rupee.format(best.ask),
        iv: best.ivMid != null ? `${best.ivMid.toFixed(1)}%` : prev.iv,
        points: String((Number(prev.points) || 0) + 1),
        meta: `${rollSymbol().trim().toUpperCase()} ${rollExpiry()} | live tick ${best.hasBook ? "bid/ask" : "LTP fallback"} | ${rollExchange()}`
      }));
      setRollStatus(best.hasBook ? "Live tick" : "Live tick LTP");
    });
  }

  function scheduleRollLiveUpdate(receivedAtMs) {
    if (!isMarketHours(rollExchange())) { stopRollLive(); setRollStatus("Market closed"); return; }
    rollThrottlePending = receivedAtMs || Date.now();
    if (!rollThrottleTimer) {
      rollThrottleTimer = setTimeout(() => {
        rollThrottleTimer = null;
        const ts = rollThrottlePending;
        rollThrottlePending = null;
        updateRollLiveSnapshot(ts);
      }, 250);
    }
  }

  function handleRollLiveChain(chain, receivedAtMs) {
    if (!rollLiveContext || !chain) return;
    const spot = toRupees(chain.current_price);
    if (spot && spot > 0) rollLiveContext.spot = spot;
    const saveOption = (option, side) => {
      const refId = liveRefId(option);
      if (!refId) return;
      const previous = rollLiveContext.optionByRef.get(refId) || {};
      rollLiveContext.optionByRef.set(refId, { ...previous, ...option, side, refId });
    };
    for (const option of Array.isArray(chain.ce) ? chain.ce : []) saveOption(option, "CE");
    for (const option of Array.isArray(chain.pe) ? chain.pe : []) saveOption(option, "PE");
    scheduleRollLiveUpdate(receivedAtMs);
  }

  function handleRollLiveOrderbook(book, receivedAtMs) {
    if (!rollLiveContext || !book) return;
    eachLivePayload(book, (item) => {
      const refId = liveRefId(item);
      if (refId) rollLiveContext.orderbookByRef.set(refId, item);
    });
    scheduleRollLiveUpdate(receivedAtMs);
  }

  function handleRollLiveGreeks(greek, receivedAtMs) {
    if (!rollLiveContext || !greek) return;
    let foundIv = false;
    eachLivePayload(greek, (item) => {
      const refId = liveRefId(item);
      if (!refId) return;
      const previous = rollLiveContext.greeksByRef.get(refId) || {};
      rollLiveContext.greeksByRef.set(refId, { ...previous, ...item });
      if (liveIv(item) != null) foundIv = true;
    });
    if (!foundIv) setRollStatus("Live Greeks received, IV field missing");
    scheduleRollLiveUpdate(receivedAtMs);
  }

  function startRollLive() {
    resetMonitorState();
    if (rollCutoffTimer) { clearTimeout(rollCutoffTimer); rollCutoffTimer = null; }
    if (rollLiveSocket) { rollLiveSocket.close(); rollLiveSocket = null; }
    const _rollExch = rollExchange();
    if (!isMarketHours(_rollExch)) { setRollStatus("Market closed"); return; }
    const cutoffMs = msUntilMarketClose(_rollExch);
    if (cutoffMs > 0) rollCutoffTimer = setTimeout(() => { stopRollLive(); setRollStatus("Market closed"); }, cutoffMs);
    const expiry = rollExpiry();
    if (!expiry) { setRollStatus("Select expiry first"); return; }
    if (!token().trim() || !deviceId().trim()) { setRollStatus("Session needed"); return; }
    if (!rollLiveContext?.refIds?.length) { setRollStatus("Plot Rolling first"); return; }
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws/live`);
    rollLiveSocket = ws;
    setRollStatus("Live starting");
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "subscribe",
        environment: environment().includes("uat") ? "uat" : "prod",
        token: token().replace("Bearer ", "").trim(),
        deviceId: deviceId().trim(),
        symbol: rollSymbol().trim().toUpperCase(),
        spotSymbol: rollLiveContext.spotSymbol || rollSymbol().trim().toUpperCase(),
        exchange: rollExchange(),
        interval: "1m",
        expiry,
        refIds: rollLiveContext.refIds
      }));
      setRollLive(true);
      setRollStatus(`Live subscribing ${rollLiveContext.refIds.length} legs`);
    };
    ws.onmessage = (e) => {
      if (!isMarketHours(rollExchange())) { stopRollLive(); setRollStatus("Market closed"); return; }
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.event === "option" && msg.data) handleRollLiveChain(msg.data, msg.received_at_ms);
      if (msg.event === "orderbook" && msg.data) handleRollLiveOrderbook(msg.data, msg.received_at_ms);
      if (msg.event === "greeks" && msg.data) handleRollLiveGreeks(msg.data, msg.received_at_ms);
      if (msg.event === "status" && msg.status === "connected") setRollStatus("Live connected");
      if (msg.event === "status" && msg.status === "subscribed") setRollStatus(`Live ${msg.ref_ids || 0} depth/IV refs`);
      if (msg.event === "status" && msg.status === "bridge-exit") setRollStatus(`Live bridge exited ${msg.code ?? ""}`.trim());
      if (msg.event === "log" && msg.message) setRollStatus(msg.message.slice(0, 90));
      if (msg.event === "error") setRollStatus(msg.message || "Live error");
    };
    ws.onclose = () => {
      if (rollLiveSocket !== ws) return;
      rollLiveSocket = null;
      setRollLive(false);
      setRollStatus("Live stopped");
    };
    ws.onerror = () => setRollStatus("WS error");
  }

  function stopRollLive() {
    if (rollCutoffTimer) { clearTimeout(rollCutoffTimer); rollCutoffTimer = null; }
    if (rollThrottleTimer) { clearTimeout(rollThrottleTimer); rollThrottleTimer = null; rollThrottlePending = null; }
    if (rollLiveContext?.frames) {
      for (const frame of Object.values(rollLiveContext.frames)) {
        if (frame) cancelAnimationFrame(frame);
      }
      rollLiveContext.frames = { bid: null, ask: null, iv: null, live: null };
    }
    if (rollLiveSocket) {
      try { rollLiveSocket.send(JSON.stringify({ type: "stop" })); } catch {}
      rollLiveSocket.close();
      rollLiveSocket = null;
    }
    setRollLive(false);
    setRollStatus("Idle");
  }

  function rollLineColor(target = rollLineTarget()) {
    if (target === "ask") return "#EF4444";
    if (target === "iv") return "#3B82F6";
    return "#10B981";
  }

  function saveRollSelectedStrikes(next) {
    const normalized = [...new Set(next.map(Number).filter(Number.isFinite))]
      .sort((a, b) => a - b);
    setRollSelectedStrikes(normalized);
    localStorage.setItem("nubraRollSelectedStrikes", JSON.stringify(normalized));
  }

  function addRollSelectedStrike(value = rollStrikeInput()) {
    const strike = Number(String(value).replace(/,/g, "").trim());
    if (!Number.isFinite(strike) || strike <= 0) {
      setRollStatus("Enter strike price");
      return;
    }
    saveRollSelectedStrikes([...rollSelectedStrikes(), strike]);
    setRollStrikeInput("");
    setRollStatus(`Strike added ${number.format(strike)}`);
  }

  function removeRollSelectedStrike(strike) {
    saveRollSelectedStrikes(rollSelectedStrikes().filter((item) => Number(item) !== Number(strike)));
  }

  function clearRollSelectedStrikes() {
    saveRollSelectedStrikes([]);
    setRollStatus("Auto ATM +/-2 strikes");
  }

  async function loadRollChainRows() {
    const sym = rollSymbol().trim().toUpperCase();
    if (!sym) throw new Error("Pick a symbol first.");
    setRollStatus("Chain");
    let rows = await rollingOptionRows();
    let expiries = [...new Set(rows.map((row) => row.expiry))].sort();
    if (!expiries.length) throw new Error(`No option expiries for ${sym}.`);
    if (!rollExpiry() || !expiries.includes(rollExpiry())) {
      setRollExpiries(expiries);
      setRollExpiry(expiries[0] || "");
    } else {
      setRollExpiries(expiries);
    }
    rows = rows.filter((row) => row.expiry === rollExpiry());
    const strikes = [...new Set(rows.map((row) => row.strike))].sort((a, b) => a - b);
    if (!strikes.length) throw new Error("No strikes for selected expiry.");
    const step = inferStrikeStep(strikes);
    let atm = null;
    try {
      const exch = rollExchange();
      const priceSym = exch === "MCX" ? mcxMarketSymbol(sym, rollExpiry()) : sym;
      const suffix = exch !== "NSE" ? `?exchange=${encodeURIComponent(exch)}` : "";
      const data = await nubraFetch(`optionchains/${encodeURIComponent(priceSym)}/price${suffix}`);
      const px = toRupees(data.price);
      if (Number.isFinite(px) && px > 0) atm = nearestStrike(px, strikes, step);
    } catch {}
    if (atm == null) atm = strikes[Math.floor(strikes.length / 2)];
    setRollChainRows({ strikes, step, atm });
    setRollStatus(`${strikes.length} strikes · ATM ${number.format(atm)}`);
    return { strikes, step, atm };
  }

  function toggleRollSelectedStrike(strike) {
    const value = Number(strike);
    if (!Number.isFinite(value)) return;
    const exists = rollSelectedStrikes().some((item) => Number(item) === value);
    saveRollSelectedStrikes(exists
      ? rollSelectedStrikes().filter((item) => Number(item) !== value)
      : [...rollSelectedStrikes(), value]);
  }

  function rollCandidateStrikes(atm, strikes, step) {
    const selected = rollSelectedStrikes();
    if (selected.length) {
      return [...new Set(selected.map((strike) => nearestStrike(strike, strikes, step)))];
    }
    const out = [];
    for (let offset = -2; offset <= 2; offset++) {
      out.push(nearestStrike(atm + offset * step, strikes, step));
    }
    return [...new Set(out)];
  }

  function rollLineTitle(name, target) {
    const label = target === "iv" ? "IV" : target === "ask" ? "Ask" : "Bid";
    return `${name || label} ${label}`;
  }

  function toggleRollSeries(key, seriesIndex) {
    const visible = !rollSeriesVisibility()[key];
    setRollSeriesVisibility((current) => ({ ...current, [key]: visible }));
    const storageKey = key === "iv" ? "Iv" : key[0].toUpperCase() + key.slice(1);
    localStorage.setItem(`nubraRollSeries${storageKey}`, visible ? "1" : "0");
    rollChart?.setSeries(seriesIndex, { show: visible });
    rollChart?.redraw();
  }

  function addRollLine() {
    initRollChart();
    const value = Number(rollLineValue());
    if (!rollChart || !Number.isFinite(value)) {
      setRollStatus("Enter line value");
      return;
    }

    const target = rollLineTarget();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const title = rollLineTitle(rollLineName().trim(), target);
    setRollDrawnLines((lines) => [...lines, { id, name: title, value, target }]);
    rebuildRollChart();
    setRollLineName("");
    setRollLineValue("");
    setRollStatus(`Line added: ${title}`);
  }

  function removeRollLine(id) {
    setRollDrawnLines((lines) => lines.filter((line) => line.id !== id));
    rebuildRollChart();
  }

  function initRollChartLegacy() {
    if (rollChart || !rollChartHost) return;
    if (!window.LightweightCharts) {
      window.setTimeout(initRollChart, 100);
      return;
    }
    rollChart = makeChart(rollChartHost, {
      leftPriceScale: {
        visible: true,
        borderColor: "rgba(255,255,255,0.09)",
        scaleMargins: { top: 0.08, bottom: 0.08 },
        minimumWidth: 72
      },
      rightPriceScale: {
        visible: true,
        borderColor: "rgba(255,255,255,0.09)",
        scaleMargins: { top: 0.08, bottom: 0.08 }
      }
    });
    if (!rollChart) {
      window.setTimeout(initRollChart, 100);
      return;
    }

    const addLine = (opts) => rollChart.addLineSeries
      ? rollChart.addLineSeries(opts)
      : rollChart.addSeries(window.LightweightCharts.LineSeries, opts);

    // Bid / Ask on RIGHT axis (₹ price)
    rollBidSeries = addLine({ color: "#10B981", lineWidth: 2, title: "Bid", priceScaleId: "right" });
    rollAskSeries = addLine({ color: "#EF4444", lineWidth: 2, title: "Ask", priceScaleId: "right" });

    // IV on LEFT axis (% value)
    rollIvSeries = addLine({
      color: "#3B82F6",
      lineWidth: 1,
      lineStyle: 0,           // solid
      title: "IV %",
      priceScaleId: "left",
      priceFormat: { type: "custom", formatter: (p) => `${p.toFixed(1)}%`, minMove: 0.01 }
    });

    queueChartResize();
  }

  // Running (cumulative) average of the straddle mid = (bid + ask) / 2.
  // Returns one value per x-point: the mean of every mid seen up to that point.
  function computeRunningAvg(bidArr, askArr) {
    const out = [];
    let sum = 0;
    let count = 0;
    const length = bidArr?.length || 0;
    for (let i = 0; i < length; i += 1) {
      const bid = Number(bidArr[i]);
      const ask = Number(askArr?.[i]);
      if (Number.isFinite(bid) && Number.isFinite(ask)) {
        sum += (bid + ask) / 2;
        count += 1;
      }
      out.push(count ? sum / count : null);
    }
    return out;
  }

  function rollChartSeriesConfig() {
    const base = [
      {},
      { label: "Bid", scale: "price", show: rollSeriesVisibility().bid, stroke: "#10B981", width: 1.6, points: { show: false } },
      { label: "Ask", scale: "price", show: rollSeriesVisibility().ask, stroke: "#EF4444", width: 1.6, points: { show: false } },
      { label: "IV %", scale: "iv", show: rollSeriesVisibility().iv, stroke: "#3B82F6", width: 1.2, points: { show: false } },
      { label: "Avg ₹", scale: "price", show: rollSeriesVisibility().avg, stroke: "#8B5CF6", width: 1.4, dash: [4, 4], points: { show: false } }
    ];
    for (const line of rollDrawnLines()) {
      base.push({
        label: line.name,
        scale: line.target === "iv" ? "iv" : "price",
        stroke: rollLineColor(line.target),
        width: 1,
        dash: [7, 5],
        points: { show: false }
      });
    }
    return base;
  }

  function clampRange(min, max, hardMin, hardMax, minSpan = 5) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return { min: hardMin, max: hardMax };
    let nextMin = min;
    let nextMax = max;
    if (nextMax - nextMin < minSpan) {
      const mid = (nextMin + nextMax) / 2;
      nextMin = mid - minSpan / 2;
      nextMax = mid + minSpan / 2;
    }
    if (Number.isFinite(hardMin) && nextMin < hardMin) {
      nextMax += hardMin - nextMin;
      nextMin = hardMin;
    }
    if (Number.isFinite(hardMax) && nextMax > hardMax) {
      nextMin -= nextMax - hardMax;
      nextMax = hardMax;
    }
    if (Number.isFinite(hardMin)) nextMin = Math.max(hardMin, nextMin);
    if (Number.isFinite(hardMax)) nextMax = Math.min(hardMax, nextMax);
    return { min: nextMin, max: nextMax };
  }

  function rememberRollScale(key, range) {
    if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.max <= range.min) return;
    rollManualScales = { ...rollManualScales, [key]: { min: range.min, max: range.max } };
    if (key === "x") syncRollIndicatorX(range);
  }

  function scaleRangeChanged(current, saved) {
    if (!current || !saved) return false;
    return Math.abs(current.min - saved.min) > 1e-9 || Math.abs(current.max - saved.max) > 1e-9;
  }

  let rollXSyncing = false;
  function syncRollIndicatorX(range) {
    if (rollXSyncing || !range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return;
    rollXSyncing = true;
    try {
      if (rollIndicatorPane() === "premium" && pdChart) pdChart.setScale("x", range);
      if (rollIndicatorPane() === "vega" && vgChart) vgChart.setScale("x", range);
    } finally {
      rollXSyncing = false;
    }
  }

  function syncRollXFromIndicator(type, range) {
    if (rollXSyncing || rollIndicatorPane() !== type || !range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return;
    rollXSyncing = true;
    try {
      rollManualScales = { ...rollManualScales, x: { min: range.min, max: range.max } };
      if (rollChart) rollChart.setScale("x", range);
    } finally {
      rollXSyncing = false;
    }
  }

  function setRollScale(key, range, manual = false) {
    if (!rollChart || !range) return;
    rollChart.setScale(key, range);
    if (manual) rememberRollScale(key, range);
    if (key === "x") syncRollIndicatorX(range);
  }

  function applyRollManualScales() {
    if (!rollChart) return;
    for (const key of ["x", "price", "iv"]) {
      const range = rollManualScales[key];
      if (range) rollChart.setScale(key, range);
    }
    if (rollManualScales.x) syncRollIndicatorX(rollManualScales.x);
  }

  function scheduleApplyRollManualScales() {
    if (rollScaleApplyQueued) return;
    rollScaleApplyQueued = true;
    requestAnimationFrame(() => {
      rollScaleApplyQueued = false;
      applyRollManualScales();
    });
  }

  function clearRollManualScales(keys = ["x", "price", "iv"]) {
    rollManualScales = keys.reduce((next, key) => ({ ...next, [key]: null }), rollManualScales);
  }

  function createRollInteractionPlugin() {
    let over;
    let destroy = () => {};
    const chartXBounds = () => {
      const x = rollChartData[0] || [];
      const dataMin = x[0];
      const dataMax = x[x.length - 1];
      const pad = Math.max(30, (dataMax - dataMin) * 0.02);
      return { min: dataMin - pad, max: dataMax + pad };
    };
    const zoomAxis = (u, key, pct, factor, hardMin, hardMax, minSpan) => {
      const scale = u.scales[key];
      if (!scale || !Number.isFinite(scale.min) || !Number.isFinite(scale.max)) return;
      const span = scale.max - scale.min;
      const anchor = scale.min + span * pct;
      const nextSpan = span * factor;
      const range = clampRange(anchor - nextSpan * pct, anchor + nextSpan * (1 - pct), hardMin, hardMax, minSpan);
      rememberRollScale(key, range);
      u.setScale(key, range);
    };
    const panAxis = (u, key, pctDelta, hardMin, hardMax) => {
      const scale = u.scales[key];
      if (!scale || !Number.isFinite(scale.min) || !Number.isFinite(scale.max)) return;
      const span = scale.max - scale.min;
      const shift = span * pctDelta;
      const range = clampRange(scale.min + shift, scale.max + shift, hardMin, hardMax, span);
      rememberRollScale(key, range);
      u.setScale(key, range);
    };

    return {
      hooks: {
        ready: [
          (u) => {
            over = u.over;
            const axisEls = [...u.root.querySelectorAll(".u-axis")];
            let dragStart = null;
            let axisDragStart = null;
            const wheel = (event) => {
              if (!rollChartData[0]?.length) return;
              event.preventDefault();
              const rect = over.getBoundingClientRect();
              const xPct = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
              const yPct = Math.min(1, Math.max(0, 1 - ((event.clientY - rect.top) / rect.height)));
              const { min: xMin, max: xMax } = chartXBounds();

              if (Math.abs(event.deltaX) > Math.abs(event.deltaY) && !event.ctrlKey && !event.metaKey) {
                panAxis(u, "x", event.deltaX / rect.width, xMin, xMax);
                return;
              }

              const factor = event.deltaY < 0 ? 0.82 : 1.22;
              const zoomY = event.shiftKey || event.altKey || event.ctrlKey || event.metaKey;
              const zoomX = !event.shiftKey || event.ctrlKey || event.metaKey;
              if (zoomX) zoomAxis(u, "x", xPct, factor, xMin, xMax, 10);
              if (zoomY) {
                zoomAxis(u, "price", yPct, factor, -Infinity, Infinity, 0.01);
                zoomAxis(u, "iv", yPct, factor, -Infinity, Infinity, 0.01);
              }
            };
            const axisWheel = (scaleKey) => (event) => {
              if (!rollChartData[0]?.length) return;
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              const factor = event.deltaY < 0 ? 0.86 : 1.16;
              if (scaleKey === "x") {
                const { min, max } = chartXBounds();
                if (!Number.isFinite(min) || !Number.isFinite(max)) return;
                const xPct = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
                zoomAxis(u, "x", xPct, factor, min, max, 10);
                return;
              }
              const yPct = Math.min(1, Math.max(0, 1 - ((event.clientY - rect.top) / Math.max(1, rect.height))));
              zoomAxis(u, scaleKey, yPct, factor, -Infinity, Infinity, 0.01);
            };
            const pointerDown = (event) => {
              if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
              scheduleApplyRollManualScales();
              dragStart = {
                x: event.clientX,
                y: event.clientY,
                xMin: u.scales.x.min,
                xMax: u.scales.x.max,
                priceMin: u.scales.price?.min,
                priceMax: u.scales.price?.max,
                ivMin: u.scales.iv?.min,
                ivMax: u.scales.iv?.max
              };
              over.setPointerCapture?.(event.pointerId);
            };
            const pointerMove = (event) => {
              if (!dragStart || !rollChartData[0]?.length) return;
              event.preventDefault();
              const rect = over.getBoundingClientRect();
              const dx = event.clientX - dragStart.x;
              const dy = event.clientY - dragStart.y;
              const { min: xHardMin, max: xHardMax } = chartXBounds();
              const xSpan = dragStart.xMax - dragStart.xMin;
              const xShift = -(dx / Math.max(1, rect.width)) * xSpan;
              const xRange = clampRange(dragStart.xMin + xShift, dragStart.xMax + xShift, xHardMin, xHardMax, xSpan);
              rememberRollScale("x", xRange);
              u.setScale("x", xRange);

              const panYScale = (scaleKey, min, max) => {
                if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return;
                const span = max - min;
                const shift = (dy / Math.max(1, rect.height)) * span;
                const range = clampRange(min + shift, max + shift, -Infinity, Infinity, span);
                rememberRollScale(scaleKey, range);
                u.setScale(scaleKey, range);
              };
              panYScale("price", dragStart.priceMin, dragStart.priceMax);
              panYScale("iv", dragStart.ivMin, dragStart.ivMax);
            };
            const pointerUp = (event) => {
              dragStart = null;
              over.releasePointerCapture?.(event.pointerId);
              scheduleApplyRollManualScales();
            };
            const axisPointerDown = (scaleKey) => (event) => {
              if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
              const scale = u.scales[scaleKey];
              if (!scale || !Number.isFinite(scale.min) || !Number.isFinite(scale.max)) return;
              scheduleApplyRollManualScales();
              axisDragStart = {
                scaleKey,
                x: event.clientX,
                y: event.clientY,
                min: scale.min,
                max: scale.max
              };
              event.currentTarget.setPointerCapture?.(event.pointerId);
            };
            const axisPointerMove = (event) => {
              if (!axisDragStart || !rollChartData[0]?.length) return;
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              const span = axisDragStart.max - axisDragStart.min;
              if (axisDragStart.scaleKey === "x") {
                const dx = event.clientX - axisDragStart.x;
                const { min, max } = chartXBounds();
                const mid = (axisDragStart.min + axisDragStart.max) / 2;
                const factor = Math.exp(-dx / Math.max(120, rect.width));
                const nextSpan = Math.max(10, span * factor);
                const range = clampRange(mid - nextSpan / 2, mid + nextSpan / 2, min, max, 10);
                rememberRollScale("x", range);
                u.setScale("x", range);
                return;
              }
              const dy = event.clientY - axisDragStart.y;
              const mid = (axisDragStart.min + axisDragStart.max) / 2;
              const factor = Math.exp(dy / Math.max(120, rect.height));
              const nextSpan = Math.max(0.01, span * factor);
              const range = clampRange(mid - nextSpan / 2, mid + nextSpan / 2, -Infinity, Infinity, 0.01);
              rememberRollScale(axisDragStart.scaleKey, range);
              u.setScale(axisDragStart.scaleKey, range);
            };
            const axisPointerUp = (event) => {
              axisDragStart = null;
              event.currentTarget.releasePointerCapture?.(event.pointerId);
              scheduleApplyRollManualScales();
            };
            const keepManualScale = () => {
              scheduleApplyRollManualScales();
            };
            const axisTooltip = document.createElement("div");
            axisTooltip.className = "chart-axis-tooltip";
            axisTooltip.hidden = true;
            const chartWrap = u.root.querySelector(".u-wrap") || u.root;
            chartWrap.appendChild(axisTooltip);
            const axisTitle = (scaleKey) => {
              if (scaleKey === "x") return "Time axis: drag to expand or squeeze time. Double-click to reset.";
              if (scaleKey === "iv") return "IV axis: drag to expand or squeeze IV. Double-click to reset.";
              return "Price axis: drag to expand or squeeze price. Double-click to reset.";
            };
            const axisTooltipText = (scaleKey, value) => {
              if (!Number.isFinite(value)) return "";
              if (scaleKey === "x") return `Time ${formatIstTime(value)} IST`;
              if (scaleKey === "iv") return `IV ${value.toFixed(2)}%`;
              return `Price ${rupee.format(value)}`;
            };
            const nextAxisGuideMode = () => {
              const count = Math.max(0, Number(localStorage.getItem("nubraAxisGuideViews")) || 0);
              if (count < 3) {
                const next = count + 1;
                localStorage.setItem("nubraAxisGuideViews", String(next));
                return { type: "guide", count: next };
              }
              if (localStorage.getItem("nubraAxisHelpPrompted") !== "1") {
                localStorage.setItem("nubraAxisHelpPrompted", "1");
                return { type: "help" };
              }
              return { type: "value" };
            };
            const axisGuidanceText = (item) => {
              if (item.guideMode?.type === "guide") {
                return `${axisTitle(item.scale)} Use the mouse wheel to zoom. · Tip ${item.guideMode.count}/3`;
              }
              if (item.guideMode?.type === "help") {
                return "For all chart controls, click the i button in the main header.";
              }
              return "";
            };
            const showAxisTooltip = (item, event) => {
              const scale = u.scales[item.scale];
              if (!scale || !Number.isFinite(scale.min) || !Number.isFinite(scale.max)) return;
              const rect = item.el.getBoundingClientRect();
              const pct = item.scale === "x"
                ? Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)))
                : Math.min(1, Math.max(0, 1 - ((event.clientY - rect.top) / Math.max(1, rect.height))));
              const value = scale.min + (scale.max - scale.min) * pct;
              axisTooltip.textContent = [axisTooltipText(item.scale, value), axisGuidanceText(item)].filter(Boolean).join("\n");
              const rootRect = u.root.getBoundingClientRect();
              axisTooltip.hidden = false;
              const tipRect = axisTooltip.getBoundingClientRect();
              const left = Math.min(rootRect.width - tipRect.width - 8, Math.max(8, event.clientX - rootRect.left + 10));
              const top = Math.min(rootRect.height - tipRect.height - 8, Math.max(8, event.clientY - rootRect.top - 30));
              axisTooltip.style.left = `${left}px`;
              axisTooltip.style.top = `${top}px`;
            };
            const hideAxisTooltip = (item) => {
              axisTooltip.hidden = true;
              if (item) item.guideMode = null;
            };
            const doubleClick = () => {
              clearRollManualScales();
              setRollChartWindow();
              u.setScale("price", { min: null, max: null });
              u.setScale("iv", { min: null, max: null });
            };
            const axisHandlers = [
              { el: u.axes[0]?._el, scale: "x" },
              { el: u.axes[1]?._el, scale: "iv" },
              { el: u.axes[2]?._el, scale: "price" }
            ].filter((item) => item.el);
            for (const item of axisHandlers) {
              item.el.classList.add(`roll-axis-${item.scale}`);
              item.el.title = axisTitle(item.scale);
              item.wheel = axisWheel(item.scale);
              item.pointerDown = axisPointerDown(item.scale);
              item.pointerMove = (event) => {
                axisPointerMove(event);
                showAxisTooltip(item, event);
              };
              item.pointerEnter = (event) => {
                item.guideMode = nextAxisGuideMode();
                showAxisTooltip(item, event);
              };
              item.pointerLeave = () => hideAxisTooltip(item);
              item.el.addEventListener("wheel", item.wheel, { passive: false });
              item.el.addEventListener("pointerdown", item.pointerDown);
              item.el.addEventListener("pointermove", item.pointerMove);
              item.el.addEventListener("pointerup", axisPointerUp);
              item.el.addEventListener("pointercancel", axisPointerUp);
              item.el.addEventListener("pointerenter", item.pointerEnter);
              item.el.addEventListener("pointerleave", item.pointerLeave);
              item.el.addEventListener("click", keepManualScale);
              item.el.addEventListener("dblclick", doubleClick);
            }
            over.addEventListener("wheel", wheel, { passive: false });
            over.addEventListener("pointerdown", pointerDown);
            over.addEventListener("pointermove", pointerMove);
            over.addEventListener("pointerup", pointerUp);
            over.addEventListener("pointercancel", pointerUp);
            over.addEventListener("click", keepManualScale);
            destroy = () => {
              for (const item of axisHandlers) {
                item.el.removeEventListener("wheel", item.wheel);
                item.el.removeEventListener("pointerdown", item.pointerDown);
                item.el.removeEventListener("pointermove", item.pointerMove);
                item.el.removeEventListener("pointerup", axisPointerUp);
                item.el.removeEventListener("pointercancel", axisPointerUp);
                item.el.removeEventListener("pointerenter", item.pointerEnter);
                item.el.removeEventListener("pointerleave", item.pointerLeave);
                item.el.removeEventListener("click", keepManualScale);
                item.el.removeEventListener("dblclick", doubleClick);
              }
              axisTooltip.remove();
              over.removeEventListener("wheel", wheel);
              over.removeEventListener("pointerdown", pointerDown);
              over.removeEventListener("pointermove", pointerMove);
              over.removeEventListener("pointerup", pointerUp);
              over.removeEventListener("pointercancel", pointerUp);
              over.removeEventListener("click", keepManualScale);
            };
          }
        ],
        setScale: [
          (u, key) => {
            const keys = key ? [key] : ["x", "price", "iv"];
            for (const scaleKey of keys) {
              const saved = rollManualScales[scaleKey];
              if (saved && scaleRangeChanged(u.scales[scaleKey], saved)) {
                requestAnimationFrame(() => {
                  const latest = rollManualScales[scaleKey];
                  if (latest && scaleRangeChanged(u.scales[scaleKey], latest)) u.setScale(scaleKey, latest);
                });
              }
            }
          }
        ],
        destroy: [() => destroy()]
      }
    };
  }

  function paddedRollRange(_u, dataMin, dataMax) {
    if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) return [dataMin, dataMax];
    const span = Math.max(Math.abs(dataMax - dataMin), Math.abs(dataMax) * 0.002, 0.25);
    const pad = span * 0.18;
    return [dataMin - pad, dataMax + pad];
  }

  function createRollLastValuePlugin() {
    const labels = [];
    function makeLabel(className) {
      const el = document.createElement("div");
      el.className = `roll-last-label ${className}`;
      el.hidden = true;
      return el;
    }
    return {
      hooks: {
        init: [(u) => {
          const wrap = u.root.querySelector(".u-wrap") || u.root;
          const defs = [
            { cls: "roll-last-bid", key: "bid", color: "#10B981", series: 1, scale: "price", side: "right" },
            { cls: "roll-last-ask", key: "ask", color: "#EF4444", series: 2, scale: "price", side: "right" },
            { cls: "roll-last-avg", key: "avg", color: "#8B5CF6", series: 4, scale: "price", side: "right" },
            { cls: "roll-last-iv", key: "iv", color: "#3B82F6", series: 3, scale: "iv", side: "left" },
            { cls: "roll-last-time", color: "#7b8491", series: 0, scale: "x", side: "bottom" },
          ];
          for (const def of defs) {
            const el = makeLabel(def.cls);
            el.style.borderColor = def.color;
            el.style.color = def.color;
            wrap.appendChild(el);
            labels.push({ el, ...def });
          }
        }],
        setData: [(u) => { updateLastLabels(u); }],
        setSeries: [(u) => { updateLastLabels(u); }],
        setScale: [(u) => { updateLastLabels(u); }],
        setSize: [(u) => { updateLastLabels(u); }],
      }
    };
    function updateLastLabels(u) {
      for (const label of labels) {
        if (label.key && !rollSeriesVisibility()[label.key]) { label.el.hidden = true; continue; }
        const data = rollChartData[label.series];
        if (!data?.length) { label.el.hidden = true; continue; }
        let lastVal = null;
        for (let i = data.length - 1; i >= 0; i--) {
          if (Number.isFinite(data[i])) { lastVal = data[i]; break; }
        }
        if (lastVal == null) { label.el.hidden = true; continue; }
        if (label.side === "bottom") {
          const scale = u.scales.x;
          if (!scale || !Number.isFinite(scale.min) || !Number.isFinite(scale.max)) { label.el.hidden = true; continue; }
          const px = u.valToPos(lastVal, "x", true);
          if (px < 0 || px > u.over.clientWidth) { label.el.hidden = true; continue; }
          label.el.textContent = formatIstTime(lastVal);
          label.el.hidden = false;
          label.el.style.left = `${px}px`;
          label.el.style.bottom = "0px";
          label.el.style.top = "";
          label.el.style.right = "";
          label.el.style.transform = "translateX(-50%)";
        } else {
          const scale = u.scales[label.scale];
          if (!scale || !Number.isFinite(scale.min) || !Number.isFinite(scale.max)) { label.el.hidden = true; continue; }
          const px = u.valToPos(lastVal, label.scale, true);
          if (px < 0 || px > u.over.clientHeight) { label.el.hidden = true; continue; }
          if (label.scale === "price") {
            label.el.textContent = Number(lastVal).toFixed(2);
          } else {
            label.el.textContent = `${Number(lastVal).toFixed(1)}%`;
          }
          label.el.hidden = false;
          label.el.style.top = `${px}px`;
          label.el.style.transform = "translateY(-50%)";
          if (label.side === "right") {
            label.el.style.right = "0px";
            label.el.style.left = "";
          } else {
            label.el.style.left = "0px";
            label.el.style.right = "";
          }
          label.el.style.bottom = "";
        }
      }
    }
  }

  function createRollTooltipPlugin() {
    let tooltip;
    return {
      hooks: {
        init: [(u) => {
          tooltip = document.createElement("div");
          tooltip.className = "roll-chart-tooltip";
          tooltip.hidden = true;
          u.over.appendChild(tooltip);
        }],
        setCursor: [(u) => {
          if (!tooltip) return;
          const idx = u.cursor.idx;
          if (idx == null || idx < 0 || !rollChartData[0]?.length) {
            tooltip.hidden = true;
            return;
          }
          const time = rollChartData[0][idx];
          const bid = rollChartData[1]?.[idx];
          const ask = rollChartData[2]?.[idx];
          const iv = rollChartData[3]?.[idx];
          const avg = rollChartData[4]?.[idx];
          if (!Number.isFinite(time)) { tooltip.hidden = true; return; }
          const parts = [`<span class="roll-tip-time">${formatIstTime(time)}</span>`];
          if (rollSeriesVisibility().bid && Number.isFinite(bid)) parts.push(`<span style="color:#10B981">Bid: ${rupee.format(bid)}</span>`);
          if (rollSeriesVisibility().ask && Number.isFinite(ask)) parts.push(`<span style="color:#EF4444">Ask: ${rupee.format(ask)}</span>`);
          if (rollSeriesVisibility().avg && Number.isFinite(avg)) parts.push(`<span style="color:#8B5CF6">Avg: ${rupee.format(avg)}</span>`);
          if (rollSeriesVisibility().iv && Number.isFinite(iv)) parts.push(`<span style="color:#3B82F6">IV: ${iv.toFixed(2)}%</span>`);
          tooltip.innerHTML = parts.join("");
          tooltip.hidden = false;
          const left = Math.min(u.over.clientWidth - tooltip.offsetWidth - 12, Math.max(8, u.cursor.left + 14));
          const top = Math.max(8, Math.min(u.over.clientHeight - tooltip.offsetHeight - 12, u.cursor.top - 42));
          tooltip.style.left = `${left}px`;
          tooltip.style.top = `${top}px`;
        }]
      }
    };
  }

  function createRollCursorAxisPlugin() {
    let priceLabel, ivLabel;
    function makeAxisLabel(color) {
      const el = document.createElement("div");
      el.className = "roll-cursor-axis-label";
      el.style.borderColor = color;
      el.style.color = color;
      el.hidden = true;
      return el;
    }
    return {
      hooks: {
        init: [(u) => {
          const wrap = u.root.querySelector(".u-wrap") || u.root;
          priceLabel = makeAxisLabel("#c9cdd3");
          ivLabel = makeAxisLabel("#3B82F6");
          wrap.appendChild(priceLabel);
          wrap.appendChild(ivLabel);
        }],
        setCursor: [(u) => {
          if (!priceLabel || !ivLabel) return;
          const top = u.cursor.top;
          if (top == null || top < 0) {
            priceLabel.hidden = true;
            ivLabel.hidden = true;
            return;
          }
          const priceScale = u.scales.price;
          if (priceScale && Number.isFinite(priceScale.min) && Number.isFinite(priceScale.max)) {
            const val = u.posToVal(top, "price");
            priceLabel.textContent = `₹${Number(val).toFixed(2)}`;
            priceLabel.hidden = false;
            priceLabel.style.top = `${top}px`;
            priceLabel.style.right = "0px";
            priceLabel.style.left = "";
            priceLabel.style.transform = "translateY(-50%)";
          } else {
            priceLabel.hidden = true;
          }
          const ivScale = u.scales.iv;
          if (ivScale && Number.isFinite(ivScale.min) && Number.isFinite(ivScale.max)) {
            const val = u.posToVal(top, "iv");
            ivLabel.textContent = `${Number(val).toFixed(2)}%`;
            ivLabel.hidden = false;
            ivLabel.style.top = `${top}px`;
            ivLabel.style.left = "0px";
            ivLabel.style.right = "";
            ivLabel.style.transform = "translateY(-50%)";
          } else {
            ivLabel.hidden = true;
          }
        }]
      }
    };
  }

  function initRollChart() {
    if (rollChart || !rollChartHost) return;
    const rect = rollChartHost.getBoundingClientRect();
    const compositePaneOpen = rollIndicatorPane() !== "none";
    rollReferenceCount = rollDrawnLines().length;
    const series = rollChartSeriesConfig();
    rollChartData = rollChartData.slice(0, series.length);
    while (rollChartData.length < series.length) {
      rollChartData.push((rollChartData[0] || []).map(() => null));
    }
    const axisFont = "12px monospace";
    rollChart = new uPlot({
      width: Math.max(1, Math.floor(rect.width)),
      height: Math.max(280, Math.floor(rect.height)),
      pxAlign: true,
      legend: { show: false },
      cursor: {
        drag: { x: false, y: false },
        points: { show: false },
        focus: { prox: 24 }
      },
      scales: {
        x: { time: true },
        price: { auto: true, range: paddedRollRange },
        iv: { auto: true, range: paddedRollRange }
      },
      axes: [
        {
          show: !compositePaneOpen,
          class: "roll-axis-x",
          size: compositePaneOpen ? 0 : 44,
          gap: compositePaneOpen ? 0 : 6,
          font: axisFont,
          stroke: "#c9cdd3",
          border: { show: true, stroke: "rgba(255,255,255,0.24)", width: 1 },
          grid: { show: true, stroke: "rgba(68,80,94,0.35)", width: 1 },
          ticks: { show: !compositePaneOpen, stroke: "rgba(255,255,255,0.18)", width: 1, size: compositePaneOpen ? 0 : 5 },
          values: (_u, vals) => vals.map((v) => formatIstTime(v)),
          space: 80
        },
        {
          show: true,
          class: "roll-axis-iv",
          scale: "iv",
          side: 3,
          size: 64,
          gap: 8,
          font: axisFont,
          stroke: "#c4b5fd",
          border: { show: true, stroke: "rgba(255,255,255,0.24)", width: 1 },
          grid: { show: false },
          ticks: { show: true, stroke: "rgba(167,139,250,0.3)", width: 1, size: 5 },
          values: (_u, vals) => vals.map((v) => `${Number(v).toFixed(1)}%`),
          space: 40
        },
        {
          show: true,
          class: "roll-axis-price",
          scale: "price",
          side: 1,
          size: 80,
          gap: 8,
          font: axisFont,
          stroke: "#c9cdd3",
          border: { show: true, stroke: "rgba(255,255,255,0.24)", width: 1 },
          grid: { show: true, stroke: "rgba(68,80,94,0.35)", width: 1 },
          ticks: { show: true, stroke: "rgba(255,255,255,0.18)", width: 1, size: 5 },
          values: (_u, vals) => vals.map((v) => Number(v).toFixed(2)),
          space: 40
        }
      ],
      series,
      plugins: [createRollInteractionPlugin(), createRollTooltipPlugin(), createRollLastValuePlugin(), createRollCursorAxisPlugin()]
    }, rollChartData, rollChartHost);
    rollBidSeries = rollAskSeries = rollIvSeries = null;
    queueChartResize();
  }

  function rebuildRollChart() {
    if (rollChart) {
      rollChart.destroy();
      rollChart = null;
    }
    initRollChart();
    setRollChartLines(rollChartLines.bid, rollChartLines.ask, rollChartLines.iv, false);
  }

  function setRollChartWindow(mode = rollWindowMode()) {
    if (!rollChart || !rollChartData[0]?.length) return;
    if (rollManualScales.x) {
      rollChart.setScale("x", rollManualScales.x);
      return;
    }
    const x = rollChartData[0];
    const minAll = x[0];
    const maxAll = x[x.length - 1];
    const spans = { "30m": 30 * 60, "1h": 60 * 60, "3h": 3 * 60 * 60 };
    const visibleSpan = mode === "full" || !spans[mode] ? Math.max(1, maxAll - minAll) : spans[mode];
    const pad = Math.max(30, visibleSpan * 0.018);
    if (mode === "full" || !spans[mode]) {
      setRollScale("x", { min: minAll - pad, max: maxAll + pad });
      return;
    }
    setRollScale("x", { min: Math.max(minAll - pad, maxAll - spans[mode]), max: maxAll + pad });
  }

  function setRollChartWindowMode(mode) {
    clearRollManualScales(["x"]);
    setRollWindowMode(mode);
    setRollChartWindow(mode);
  }

  function setRollChartLines(bidLine, askLine, ivLine, applyWindow = true) {
    rollChartLines = { bid: bidLine || [], ask: askLine || [], iv: ivLine || [] };
    const times = new Set();
    const bidByTime = new Map();
    const askByTime = new Map();
    const ivByTime = new Map();
    for (const point of rollChartLines.bid) {
      times.add(point.time);
      bidByTime.set(point.time, point.value);
    }
    for (const point of rollChartLines.ask) {
      times.add(point.time);
      askByTime.set(point.time, point.value);
    }
    for (const point of rollChartLines.iv) {
      times.add(point.time);
      ivByTime.set(point.time, point.value);
    }
    const x = [...times].sort((a, b) => a - b);
    const bidArr = x.map((time) => bidByTime.get(time) ?? null);
    const askArr = x.map((time) => askByTime.get(time) ?? null);
    const data = [
      x,
      bidArr,
      askArr,
      x.map((time) => ivByTime.get(time) ?? null),
      computeRunningAvg(bidArr, askArr)
    ];
    for (const line of rollDrawnLines()) {
      data.push(x.map(() => line.value));
    }
    rollChartData = data;
    if (rollChart && rollReferenceCount !== rollDrawnLines().length) {
      rebuildRollChart();
      return;
    }
    initRollChart();
    if (!rollChart) return;
    rollChart.setData(rollChartData);
    resizeChart(rollChart, rollChartHost);
    if (applyWindow) setRollChartWindow();
    applyRollManualScales();
  }

  async function loadRollingStraddle() {
    initRollChart();
    const start = fromLocalInput(rollStart());
    const end = fromLocalInput(rollEnd());
    if (!start || !end) throw new Error("Rolling start and end are required.");

    clearRollManualScales();
    setRollStatus("Spot");
    const sym = rollSymbol().trim().toUpperCase();
    setRollStats((prev) => ({
      ...prev,
      spot: "--",
      strike: "--",
      bid: "--",
      ask: "--",
      iv: "--",
      points: "0",
      meta: `${sym} ${rollExpiry() || "Auto"} | loading | ${rollExchange()}`
    }));
    rollExportBuffer = [];
    setRollExportData([]);
    setRollChartLines([], [], []);
    const spotSym = rollExchange() === "MCX" ? await resolveMcxMarketSymbol(sym, rollExpiry()) : sym;
    const spotType = rollExchange() === "MCX" && spotSym.startsWith("FUT_") ? "FUT" : rollType();
    setRollStats((prev) => ({
      ...prev,
      meta: `${sym} ${rollExpiry() || "Auto"} | spot ${spotSym} ${spotType} | ${rollExchange()}`
    }));
    if (rollExchange() === "MCX" && !spotSym.startsWith("FUT_")) {
      throw new Error(`MCX future symbol not found for ${sym}. Refdata did not expose a FUT_* symbol for expiry ${rollExpiry() || "auto"}.`);
    }
    let resolvedInterval = ROLLING_INTERVALS[0];
    let spotPoints = [];
    let spotError = null;
    for (const intervalValue of ROLLING_INTERVALS) {
      try {
        const { data: spotData } = await fetchTimeseriesWithIntervals({
          exchange: rollExchange(),
          type: spotType,
          values: [spotSym],
          fields: ["close"],
          startDate: start,
          endDate: end,
          intraDay: false,
          realTime: false
        }, [intervalValue]);
        const spotSymbolData = extractSymbolData(spotData, spotSym);
        spotPoints = (Array.isArray(spotSymbolData?.close) ? spotSymbolData.close : [])
          .map((p) => ({ ts: pointMs(p), spot: pointNumber(p, true) }))
          .filter((p) => Number.isFinite(p.ts) && p.spot > 0)
          .sort((a, b) => a.ts - b.ts);
        if (spotPoints.length) {
          resolvedInterval = intervalValue;
          break;
        }
      } catch (error) {
        spotError = error;
      }
    }
    if (!spotPoints.length) {
      throw new Error(spotError?.message || `No spot data returned for ${rollExchange()} ${spotType} ${spotSym}.`);
    }

    setRollStatus("Refdata");
    let rows = await rollingOptionRows();
    let expiries = [...new Set(rows.map((row) => row.expiry))].sort();
    if (!expiries.length) throw new Error(`No option expiries found for ${rollExchange()} ${sym}.`);
    if (!rollExpiry() || !expiries.includes(rollExpiry())) {
      setRollExpiries(expiries);
      setRollExpiry(expiries[0] || "");
      rows = await rollingOptionRows();
      expiries = [...new Set(rows.map((row) => row.expiry))].sort();
    } else {
      setRollExpiries(expiries);
    }
    rows = rows.filter((row) => row.expiry === rollExpiry());
    if (!rows.length) throw new Error("No option rows found for selected expiry.");

    const strikes = [...new Set(rows.map((row) => row.strike))].sort((a, b) => a - b);
    const step = inferStrikeStep(strikes);
    const rowByKey = new Map(rows.map((row) => [`${row.strike}|${row.side}`, row]));
    const requiredStrikes = new Set();
    for (const point of spotPoints) {
      const atm = nearestStrike(point.spot, strikes, step);
      for (const strike of rollCandidateStrikes(atm, strikes, step)) requiredStrikes.add(strike);
    }

    const optionNames = [];
    const aliasToCanonical = new Map();
    const liveRefIds = new Set();
    const addOptionAliases = (row) => {
      const aliases = row.aliases?.length ? row.aliases : [row.name];
      for (const alias of aliases) {
        const key = String(alias || "").toUpperCase();
        if (!key) continue;
        optionNames.push(key);
        aliasToCanonical.set(key, row.name);
      }
    };
    for (const strike of requiredStrikes) {
      const ce = rowByKey.get(`${strike}|CE`);
      const pe = rowByKey.get(`${strike}|PE`);
      if (ce) {
        addOptionAliases(ce);
        if (ce.refId) liveRefIds.add(ce.refId);
      }
      if (pe) {
        addOptionAliases(pe);
        if (pe.refId) liveRefIds.add(pe.refId);
      }
    }
    if (!optionNames.length) throw new Error(rollSelectedStrikes().length ? "No CE/PE symbols found for selected strikes." : "No CE/PE symbols found around ATM +/-2.");

    const latestSpot = spotPoints[spotPoints.length - 1]?.spot;
    rollLiveContext = {
      strikes,
      step,
      rowByKey,
      optionByRef: new Map(),
      orderbookByRef: new Map(),
      greeksByRef: new Map(),
      refIds: [...liveRefIds],
      spotSymbol: spotSym,
      spot: latestSpot,
      points: 0,
      lastValues: {
        bid: NaN,
        ask: NaN,
        iv: NaN
      },
      frames: {
        bid: null,
        ask: null,
        iv: null,
        live: null
      }
    };
    if (!rollLiveSocket) startRollLive();

    let seriesByName = await fetchRollingSeries([...new Set(optionNames)], start, end, aliasToCanonical, resolvedInterval);
    if (!seriesByName.size && resolvedInterval !== "1m") {
      const fallbackSeries = await fetchRollingSeries([...new Set(optionNames)], start, end, aliasToCanonical, "1m");
      if (fallbackSeries.size) {
        seriesByName = fallbackSeries;
        resolvedInterval = "1m";
      }
    }
    if (!seriesByName.size) {
      throw new Error(`No option chart series returned for ${rollExchange()} ${sym} ${rollExpiry()} using refdata symbols.`);
    }
    const cursorByName = new Map();
    const bidLine = [];
    const askLine = [];
    const ivLine = [];
    const selected = [];

    for (const point of spotPoints) {
      const atm = nearestStrike(point.spot, strikes, step);
      let best = null;
      for (const strike of rollCandidateStrikes(atm, strikes, step)) {
        const ce = rowByKey.get(`${strike}|CE`);
        const pe = rowByKey.get(`${strike}|PE`);
        if (!ce || !pe) continue;
        const ceQuote = advanceQuote(ce.name, seriesByName, cursorByName, point.ts);
        const peQuote = advanceQuote(pe.name, seriesByName, cursorByName, point.ts);
        const bid = ceQuote.bid + peQuote.bid;
        const ask = ceQuote.ask + peQuote.ask;
        if (bid <= 0 || ask <= 0) continue;
        const mid = (bid + ask) / 2;
        // average IV mid across CE+PE (multiply by 100 for percentage display)
        const ceIvMid = ceQuote.ivMid != null
          ? ceQuote.ivMid
          : (ceQuote.ivBid != null && ceQuote.ivAsk != null) ? (ceQuote.ivBid + ceQuote.ivAsk) / 2 : null;
        const peIvMid = peQuote.ivMid != null
          ? peQuote.ivMid
          : (peQuote.ivBid != null && peQuote.ivAsk != null) ? (peQuote.ivBid + peQuote.ivAsk) / 2 : null;
        let ivMid = null;
        if (ceIvMid != null && peIvMid != null) ivMid = ((ceIvMid + peIvMid) / 2) * 100;
        else if (ceIvMid != null) ivMid = ceIvMid * 100;
        else if (peIvMid != null) ivMid = peIvMid * 100;
        if (!best || mid < best.mid) best = { strike, bid, ask, mid, ivMid };
      }
      if (!best) continue;
      bidLine.push({ time: tvTime(point.ts), value: best.bid });
      askLine.push({ time: tvTime(point.ts), value: best.ask });
      if (best.ivMid != null && best.ivMid > 0) ivLine.push({ time: tvTime(point.ts), value: best.ivMid });
      selected.push({ ...point, ...best });
    }
    if (!selected.length) throw new Error("No complete bid/ask straddle points found.");

    setRollChartLines(bidLine, askLine, ivLine);

    const last = selected[selected.length - 1];
    const lastIv = ivLine.length ? ivLine[ivLine.length - 1].value : null;
    if (rollLiveContext) {
      rollLiveContext.strikes = strikes;
      rollLiveContext.step = step;
      rollLiveContext.rowByKey = rowByKey;
      rollLiveContext.refIds = [...liveRefIds];
      rollLiveContext.spotSymbol = spotSym;
      rollLiveContext.spot = last.spot;
      rollLiveContext.points = selected.length;
      rollLiveContext.lastValues = {
        bid: last.bid,
        ask: last.ask,
        iv: lastIv
      };
    }
    setRollStats({
      spot: rupee.format(last.spot),
      strike: number.format(last.strike),
      bid: rupee.format(last.bid),
      ask: rupee.format(last.ask),
      iv: lastIv != null ? `${lastIv.toFixed(1)}%` : "--",
      points: String(selected.length),
      meta: `${sym} ${rollExpiry()} | ${resolvedInterval} quotes | ${requiredStrikes.size} ${rollSelectedStrikes().length ? "selected" : "ATM"} strikes checked | ${rollExchange()}`
    });
    setRollExportData(selected);
    setRollStatus("Ready");
    if (!rollLiveSocket) startRollLive();
  }

  // ═══════════════════════════════════════════════════════════════
  // Multi Spread — grid of rolling OTM strangle charts
  //
  // OTM N = CE at (ATM + N steps) + PE at (ATM − N steps), combined exactly the
  // way the rolling straddle combines legs. Each offset gets its own uPlot mini
  // chart plotting Bid + Ask (right ₹ axis) and IV % (left axis). The whole grid
  // shares one spot series + one option-series fetch + one live WebSocket; only
  // the leg selection differs per chart.
  // ═══════════════════════════════════════════════════════════════

  const MS_MAX_OTM = 10;

  // How many chart slots the current layout shows. Capped at 10 because only
  // OTM 1..10 exist and each slot must hold a unique OTM.
  function msSlotCount() {
    switch (msLayout()) {
      case "3x3": return 9;
      case "4x4": return MS_MAX_OTM;   // 16 cells but only 10 unique OTMs exist
      case "side": return MS_MAX_OTM;
      case "2x2":
      default: return 4;
    }
  }

  // The OTM offset shown in each slot (slotIndex -> offset). Each slot's pick is
  // user-selectable via a dropdown; offsets are unique across slots.
  function msVisibleOffsets() {
    return msSlots().slice(0, msSlotCount()).filter((o) => o != null);
  }

  // Default slot assignment for a given count: OTM 1,2,3,… preserving any picks
  // the user already made for slots that still exist.
  function defaultMsSlots(count) {
    const prev = msSlots();
    const used = new Set();
    const out = [];
    for (let i = 0; i < count; i++) {
      let pick = prev[i];
      if (pick == null || pick < 1 || pick > MS_MAX_OTM || used.has(pick)) {
        // first free OTM
        pick = 1;
        while (used.has(pick) && pick <= MS_MAX_OTM) pick++;
      }
      used.add(pick);
      out.push(pick);
    }
    return out;
  }

  // ── per-chart manual-scale helpers (mirrors the straddle chart, scoped per offset) ──
  function msGetScales(offset) {
    let s = msManualScales.get(offset);
    if (!s) { s = { x: null, price: null, iv: null }; msManualScales.set(offset, s); }
    return s;
  }
  function msRememberScale(offset, key, range) {
    if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.max <= range.min) return;
    msGetScales(offset)[key] = { min: range.min, max: range.max };
  }
  function msClearScales(offset, keys = ["x", "price", "iv"]) {
    const s = msGetScales(offset);
    for (const k of keys) s[k] = null;
  }
  function msApplyScales(offset) {
    const chart = msCharts.get(offset);
    if (!chart) return;
    const s = msGetScales(offset);
    for (const key of ["x", "price", "iv"]) {
      const saved = s[key];
      if (saved && scaleRangeChanged(chart.scales[key], saved)) chart.setScale(key, saved);
    }
  }

  // Fit the x-axis to the data (used on first plot and on double-click reset).
  function msFitWindow(offset) {
    const chart = msCharts.get(offset);
    const data = msChartData.get(offset);
    if (!chart || !data?.[0]?.length) return;
    const x = data[0];
    const minAll = x[0];
    const maxAll = x[x.length - 1];
    const pad = Math.max(30, (maxAll - minAll) * 0.02);
    chart.setScale("x", { min: minAll - pad, max: maxAll + pad });
  }

  // Self-contained pan/zoom/drag interaction for one mini chart. Same gestures
  // as the straddle chart: wheel = zoom (shift/ctrl for Y), horizontal wheel =
  // pan, drag plot = pan X+Y, drag an axis = stretch/squeeze it, dblclick = reset.
  function createMsInteractionPlugin(offset) {
    let over;
    let destroy = () => {};
    const xBounds = () => {
      const x = msChartData.get(offset)?.[0] || [];
      const dataMin = x[0];
      const dataMax = x[x.length - 1];
      const pad = Math.max(30, (dataMax - dataMin) * 0.02);
      return { min: dataMin - pad, max: dataMax + pad };
    };
    const hasData = () => (msChartData.get(offset)?.[0]?.length || 0) > 0;
    const zoomAxis = (u, key, pct, factor, hardMin, hardMax, minSpan) => {
      const scale = u.scales[key];
      if (!scale || !Number.isFinite(scale.min) || !Number.isFinite(scale.max)) return;
      const span = scale.max - scale.min;
      const anchor = scale.min + span * pct;
      const nextSpan = span * factor;
      const range = clampRange(anchor - nextSpan * pct, anchor + nextSpan * (1 - pct), hardMin, hardMax, minSpan);
      msRememberScale(offset, key, range);
      u.setScale(key, range);
    };
    return {
      hooks: {
        ready: [(u) => {
          over = u.over;
          let dragStart = null;
          let axisDragStart = null;
          const wheel = (event) => {
            if (!hasData()) return;
            event.preventDefault();
            const rect = over.getBoundingClientRect();
            const xPct = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
            const yPct = Math.min(1, Math.max(0, 1 - ((event.clientY - rect.top) / rect.height)));
            const { min: xMin, max: xMax } = xBounds();
            if (Math.abs(event.deltaX) > Math.abs(event.deltaY) && !event.ctrlKey && !event.metaKey) {
              const scale = u.scales.x;
              const span = scale.max - scale.min;
              const shift = (event.deltaX / rect.width) * span;
              const range = clampRange(scale.min + shift, scale.max + shift, xMin, xMax, span);
              msRememberScale(offset, "x", range);
              u.setScale("x", range);
              return;
            }
            const factor = event.deltaY < 0 ? 0.82 : 1.22;
            const zoomY = event.shiftKey || event.altKey || event.ctrlKey || event.metaKey;
            const zoomX = !event.shiftKey || event.ctrlKey || event.metaKey;
            if (zoomX) zoomAxis(u, "x", xPct, factor, xMin, xMax, 10);
            if (zoomY) {
              zoomAxis(u, "price", yPct, factor, -Infinity, Infinity, 0.01);
              zoomAxis(u, "iv", yPct, factor, -Infinity, Infinity, 0.01);
            }
          };
          const axisWheel = (scaleKey) => (event) => {
            if (!hasData()) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const factor = event.deltaY < 0 ? 0.86 : 1.16;
            if (scaleKey === "x") {
              const { min, max } = xBounds();
              const xPct = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
              zoomAxis(u, "x", xPct, factor, min, max, 10);
              return;
            }
            const yPct = Math.min(1, Math.max(0, 1 - ((event.clientY - rect.top) / Math.max(1, rect.height))));
            zoomAxis(u, scaleKey, yPct, factor, -Infinity, Infinity, 0.01);
          };
          const pointerDown = (event) => {
            if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
            dragStart = {
              x: event.clientX, y: event.clientY,
              xMin: u.scales.x.min, xMax: u.scales.x.max,
              priceMin: u.scales.price?.min, priceMax: u.scales.price?.max,
              ivMin: u.scales.iv?.min, ivMax: u.scales.iv?.max
            };
            over.setPointerCapture?.(event.pointerId);
          };
          const pointerMove = (event) => {
            if (!dragStart || !hasData()) return;
            event.preventDefault();
            const rect = over.getBoundingClientRect();
            const dx = event.clientX - dragStart.x;
            const dy = event.clientY - dragStart.y;
            const { min: xHardMin, max: xHardMax } = xBounds();
            const xSpan = dragStart.xMax - dragStart.xMin;
            const xShift = -(dx / Math.max(1, rect.width)) * xSpan;
            const xRange = clampRange(dragStart.xMin + xShift, dragStart.xMax + xShift, xHardMin, xHardMax, xSpan);
            msRememberScale(offset, "x", xRange);
            u.setScale("x", xRange);
            const panY = (key, min, max) => {
              if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return;
              const span = max - min;
              const shift = (dy / Math.max(1, rect.height)) * span;
              const range = clampRange(min + shift, max + shift, -Infinity, Infinity, span);
              msRememberScale(offset, key, range);
              u.setScale(key, range);
            };
            panY("price", dragStart.priceMin, dragStart.priceMax);
            panY("iv", dragStart.ivMin, dragStart.ivMax);
          };
          const pointerUp = (event) => {
            dragStart = null;
            over.releasePointerCapture?.(event.pointerId);
          };
          const axisPointerDown = (scaleKey) => (event) => {
            if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
            const scale = u.scales[scaleKey];
            if (!scale || !Number.isFinite(scale.min) || !Number.isFinite(scale.max)) return;
            axisDragStart = { scaleKey, x: event.clientX, y: event.clientY, min: scale.min, max: scale.max };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          };
          const axisPointerMove = (event) => {
            if (!axisDragStart || !hasData()) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const span = axisDragStart.max - axisDragStart.min;
            const mid = (axisDragStart.min + axisDragStart.max) / 2;
            if (axisDragStart.scaleKey === "x") {
              const dx = event.clientX - axisDragStart.x;
              const { min, max } = xBounds();
              const factor = Math.exp(-dx / Math.max(120, rect.width));
              const nextSpan = Math.max(10, span * factor);
              const range = clampRange(mid - nextSpan / 2, mid + nextSpan / 2, min, max, 10);
              msRememberScale(offset, "x", range);
              u.setScale("x", range);
              return;
            }
            const dy = event.clientY - axisDragStart.y;
            const factor = Math.exp(dy / Math.max(120, rect.height));
            const nextSpan = Math.max(0.01, span * factor);
            const range = clampRange(mid - nextSpan / 2, mid + nextSpan / 2, -Infinity, Infinity, 0.01);
            msRememberScale(offset, axisDragStart.scaleKey, range);
            u.setScale(axisDragStart.scaleKey, range);
          };
          const axisPointerUp = (event) => {
            axisDragStart = null;
            event.currentTarget.releasePointerCapture?.(event.pointerId);
          };
          const doubleClick = () => {
            msClearScales(offset);
            u.setScale("price", { min: null, max: null });
            u.setScale("iv", { min: null, max: null });
            msFitWindow(offset);
          };
          const axisHandlers = [
            { el: u.axes[0]?._el, scale: "x" },
            { el: u.axes[1]?._el, scale: "iv" },
            { el: u.axes[2]?._el, scale: "price" }
          ].filter((item) => item.el);
          for (const item of axisHandlers) {
            item.el.style.cursor = item.scale === "x" ? "ew-resize" : "ns-resize";
            item.wheel = axisWheel(item.scale);
            item.pointerDown = axisPointerDown(item.scale);
            item.el.addEventListener("wheel", item.wheel, { passive: false });
            item.el.addEventListener("pointerdown", item.pointerDown);
            item.el.addEventListener("pointermove", axisPointerMove);
            item.el.addEventListener("pointerup", axisPointerUp);
            item.el.addEventListener("pointercancel", axisPointerUp);
            item.el.addEventListener("dblclick", doubleClick);
          }
          over.addEventListener("wheel", wheel, { passive: false });
          over.addEventListener("pointerdown", pointerDown);
          over.addEventListener("pointermove", pointerMove);
          over.addEventListener("pointerup", pointerUp);
          over.addEventListener("pointercancel", pointerUp);
          over.addEventListener("dblclick", doubleClick);
          destroy = () => {
            for (const item of axisHandlers) {
              item.el.removeEventListener("wheel", item.wheel);
              item.el.removeEventListener("pointerdown", item.pointerDown);
              item.el.removeEventListener("pointermove", axisPointerMove);
              item.el.removeEventListener("pointerup", axisPointerUp);
              item.el.removeEventListener("pointercancel", axisPointerUp);
              item.el.removeEventListener("dblclick", doubleClick);
            }
            over.removeEventListener("wheel", wheel);
            over.removeEventListener("pointerdown", pointerDown);
            over.removeEventListener("pointermove", pointerMove);
            over.removeEventListener("pointerup", pointerUp);
            over.removeEventListener("pointercancel", pointerUp);
            over.removeEventListener("dblclick", doubleClick);
          };
        }],
        // Re-assert the user's manual zoom whenever live data appends new points.
        setData: [(u) => {
          const s = msGetScales(offset);
          for (const key of ["x", "price", "iv"]) {
            const saved = s[key];
            if (saved && scaleRangeChanged(u.scales[key], saved)) {
              requestAnimationFrame(() => {
                const latest = msGetScales(offset)[key];
                if (latest && scaleRangeChanged(u.scales[key], latest)) u.setScale(key, latest);
              });
            }
          }
        }],
        destroy: [() => destroy()]
      }
    };
  }

  // Crosshair tooltip for one mini chart.
  function createMsTooltipPlugin(offset) {
    let tooltip;
    return {
      hooks: {
        init: [(u) => {
          tooltip = document.createElement("div");
          tooltip.className = "roll-chart-tooltip";
          tooltip.hidden = true;
          u.over.appendChild(tooltip);
        }],
        setCursor: [(u) => {
          if (!tooltip) return;
          const data = msChartData.get(offset);
          const idx = u.cursor.idx;
          if (idx == null || idx < 0 || !data?.[0]?.length) { tooltip.hidden = true; return; }
          const time = data[0][idx];
          const bid = data[1]?.[idx];
          const ask = data[2]?.[idx];
          const iv = data[3]?.[idx];
          if (!Number.isFinite(time)) { tooltip.hidden = true; return; }
          const parts = [`<span class="roll-tip-time">${formatIstTime(time)}</span>`];
          if (msSeriesVisibility().bid && Number.isFinite(bid)) parts.push(`<span style="color:#10B981">Bid: ${rupee.format(bid)}</span>`);
          if (msSeriesVisibility().ask && Number.isFinite(ask)) parts.push(`<span style="color:#EF4444">Ask: ${rupee.format(ask)}</span>`);
          if (msSeriesVisibility().iv && Number.isFinite(iv)) parts.push(`<span style="color:#3B82F6">IV: ${iv.toFixed(2)}%</span>`);
          tooltip.innerHTML = parts.join("");
          tooltip.hidden = false;
          const left = Math.min(u.over.clientWidth - tooltip.offsetWidth - 10, Math.max(6, u.cursor.left + 12));
          const top = Math.max(6, Math.min(u.over.clientHeight - tooltip.offsetHeight - 10, u.cursor.top - 38));
          tooltip.style.left = `${left}px`;
          tooltip.style.top = `${top}px`;
        }]
      }
    };
  }

  function initMsChart(offset) {
    if (msCharts.has(offset)) return;
    const host = msChartHosts.get(offset);
    if (!host || typeof uPlot === "undefined") return;
    const rect = host.getBoundingClientRect();
    let data = msChartData.get(offset);
    if (!data) { data = [[], [], [], []]; msChartData.set(offset, data); }
    const axisFont = "10px monospace";
    const series = [
      {},
      { label: "Bid", scale: "price", show: msSeriesVisibility().bid, stroke: "#10B981", width: 1.4, points: { show: false } },
      { label: "Ask", scale: "price", show: msSeriesVisibility().ask, stroke: "#EF4444", width: 1.4, points: { show: false } },
      { label: "IV %", scale: "iv", show: msSeriesVisibility().iv, stroke: "#3B82F6", width: 1.1, points: { show: false } }
    ];
    const chart = new uPlot({
      width: Math.max(1, Math.floor(rect.width)),
      height: Math.max(140, Math.floor(rect.height)),
      pxAlign: true,
      legend: { show: false },
      cursor: {
        drag: { x: false, y: false },
        points: { show: false },
        focus: { prox: 20 },
        x: true,
        y: true
      },
      scales: {
        x: { time: true },
        price: { auto: true, range: paddedRollRange },
        iv: { auto: true, range: paddedRollRange }
      },
      axes: [
        {
          show: true, size: 30, gap: 4, font: axisFont, stroke: "#9aa1aa",
          border: { show: true, stroke: "rgba(255,255,255,0.18)", width: 1 },
          grid: { show: true, stroke: "rgba(68,80,94,0.32)", width: 1 },
          ticks: { show: true, stroke: "rgba(255,255,255,0.14)", width: 1, size: 4 },
          values: (_u, vals) => vals.map((v) => formatIstTime(v)),
          space: 64
        },
        {
          show: true, scale: "iv", side: 3, size: 42, gap: 4, font: axisFont, stroke: "#67e8f9",
          border: { show: true, stroke: "rgba(255,255,255,0.18)", width: 1 },
          grid: { show: false },
          ticks: { show: true, stroke: "rgba(103,232,249,0.25)", width: 1, size: 4 },
          values: (_u, vals) => vals.map((v) => `${Number(v).toFixed(0)}%`),
          space: 32
        },
        {
          show: true, scale: "price", side: 1, size: 48, gap: 4, font: axisFont, stroke: "#9aa1aa",
          border: { show: true, stroke: "rgba(255,255,255,0.18)", width: 1 },
          grid: { show: true, stroke: "rgba(68,80,94,0.32)", width: 1 },
          ticks: { show: true, stroke: "rgba(255,255,255,0.14)", width: 1, size: 4 },
          values: (_u, vals) => vals.map((v) => Number(v).toFixed(1)),
          space: 32
        }
      ],
      series,
      plugins: [
        createMsInteractionPlugin(offset),
        createMsTooltipPlugin(offset),
        createMsLastValuePlugin(offset)
      ]
    }, data, host);
    msCharts.set(offset, chart);
    requestAnimationFrame(() => resizeChart(chart, host));
  }

  // Compact last-value labels for a mini chart (price right, IV left).
  function createMsLastValuePlugin(offset) {
    const labels = [];
    function makeLabel(color) {
      const el = document.createElement("div");
      el.className = "ms-last-label";
      el.hidden = true;
      el.style.borderColor = color;
      el.style.color = color;
      return el;
    }
    return {
      hooks: {
        init: [(u) => {
          const wrap = u.root.querySelector(".u-wrap") || u.root;
          const defs = [
            { key: "bid", color: "#10B981", series: 1, scale: "price", side: "right" },
            { key: "ask", color: "#EF4444", series: 2, scale: "price", side: "right" },
            { key: "iv", color: "#3B82F6", series: 3, scale: "iv", side: "left" }
          ];
          for (const def of defs) {
            const el = makeLabel(def.color);
            wrap.appendChild(el);
            labels.push({ el, ...def });
          }
        }],
        setData: [(u) => updateMsLabels(u)],
        setScale: [(u) => updateMsLabels(u)],
        setSize: [(u) => updateMsLabels(u)]
      }
    };
    function updateMsLabels(u) {
      const data = msChartData.get(offset);
      for (const label of labels) {
        if (!msSeriesVisibility()[label.key]) { label.el.hidden = true; continue; }
        const arr = data?.[label.series];
        if (!arr?.length) { label.el.hidden = true; continue; }
        let lastVal = null;
        for (let i = arr.length - 1; i >= 0; i--) {
          if (Number.isFinite(arr[i])) { lastVal = arr[i]; break; }
        }
        if (lastVal == null) { label.el.hidden = true; continue; }
        const scale = u.scales[label.scale];
        if (!scale || !Number.isFinite(scale.min) || !Number.isFinite(scale.max)) { label.el.hidden = true; continue; }
        const px = u.valToPos(lastVal, label.scale, true);
        if (px < 0 || px > u.over.clientHeight) { label.el.hidden = true; continue; }
        label.el.textContent = label.scale === "iv" ? `${Number(lastVal).toFixed(1)}%` : Number(lastVal).toFixed(2);
        label.el.hidden = false;
        label.el.style.top = `${px}px`;
        label.el.style.transform = "translateY(-50%)";
        if (label.side === "right") { label.el.style.right = "0px"; label.el.style.left = ""; }
        else { label.el.style.left = "0px"; label.el.style.right = ""; }
      }
    }
  }

  function destroyMsChart(offset) {
    const chart = msCharts.get(offset);
    if (chart) { chart.destroy(); msCharts.delete(offset); }
  }

  function setMsChartLines(offset, bid, ask, iv) {
    msLines.set(offset, { bid: bid || [], ask: ask || [], iv: iv || [] });
    const times = new Set();
    const bidByTime = new Map();
    const askByTime = new Map();
    const ivByTime = new Map();
    for (const p of bid || []) { times.add(p.time); bidByTime.set(p.time, p.value); }
    for (const p of ask || []) { times.add(p.time); askByTime.set(p.time, p.value); }
    for (const p of iv || []) { times.add(p.time); ivByTime.set(p.time, p.value); }
    const x = [...times].sort((a, b) => a - b);
    const data = [
      x,
      x.map((t) => bidByTime.get(t) ?? null),
      x.map((t) => askByTime.get(t) ?? null),
      x.map((t) => ivByTime.get(t) ?? null)
    ];
    msChartData.set(offset, data);
    initMsChart(offset);
    const chart = msCharts.get(offset);
    if (!chart) return;
    chart.setData(data);
    const host = msChartHosts.get(offset);
    if (host) resizeChart(chart, host);
    // Keep the user's zoom/pan if they set one; otherwise fit to the data window.
    if (msGetScales(offset).x) msApplyScales(offset);
    else msFitWindow(offset);
  }

  // Rebuild every visible chart, re-applying any line data we already computed.
  function refreshMsCharts() {
    for (const offset of msVisibleOffsets()) {
      initMsChart(offset);
      const lines = msLines.get(offset);
      if (lines) setMsChartLines(offset, lines.bid, lines.ask, lines.iv);
    }
  }

  function registerMsChartHost(offset, el) {
    if (!el) { msChartHosts.delete(offset); destroyMsChart(offset); return; }
    msChartHosts.set(offset, el);
    initMsChart(offset);
    const lines = msLines.get(offset);
    if (lines) setMsChartLines(offset, lines.bid, lines.ask, lines.iv);
  }

  function setMsLayoutAndRefresh(layout) {
    setMsLayout(layout);
    localStorage.setItem("nubraMsLayout", layout);
    // Re-fit the slot list to the new layout's slot count, keeping existing picks.
    // SlotCard mount/cleanup handles creating/destroying the per-offset charts;
    // any newly-shown OTM without data gets fetched on the next plot.
    const slots = defaultMsSlots(msSlotCount());
    setMsSlots(slots);
    localStorage.setItem("nubraMsSlots", JSON.stringify(slots));
    const needsData = slots.filter((o) => o != null).some((o) => !msLines.has(o));
    if (needsData && msLiveContext && !busy()) run(loadMultiSpread);
    else requestAnimationFrame(refreshMsCharts);
  }

  // Change which OTM a slot shows. Enforces uniqueness by swapping with whatever
  // slot currently holds the requested OTM. Re-plots the affected charts if data
  // for the newly-shown OTM hasn't been loaded yet (only-load-selected mode).
  function setMsSlot(slotIndex, nextOffset) {
    nextOffset = Number(nextOffset);
    if (!Number.isFinite(nextOffset) || nextOffset < 1 || nextOffset > MS_MAX_OTM) return;
    const slots = [...msSlots()];
    const prevOffset = slots[slotIndex];
    if (prevOffset === nextOffset) return;
    const dupeIndex = slots.findIndex((o, i) => i !== slotIndex && o === nextOffset);
    if (dupeIndex !== -1) slots[dupeIndex] = prevOffset; // swap to keep uniqueness
    slots[slotIndex] = nextOffset;
    setMsSlots(slots);
    localStorage.setItem("nubraMsSlots", JSON.stringify(slots));
    // Auto-plot whenever the pick brings in an OTM we don't have data for yet.
    // SlotCard effects re-register the chart hosts; loadMultiSpread fetches and
    // computes the new OTM's series. A pure swap (both OTMs already loaded) just
    // refreshes from cached lines — no refetch.
    const needsData = slots.slice(0, msSlotCount()).filter((o) => o != null).some((o) => !msLines.has(o));
    if (needsData && !busy()) run(loadMultiSpread);
    else requestAnimationFrame(refreshMsCharts);
  }

  function toggleMsSeries(key, seriesIndex) {
    const visible = !msSeriesVisibility()[key];
    setMsSeriesVisibility((current) => ({ ...current, [key]: visible }));
    const storageKey = key === "iv" ? "Iv" : key[0].toUpperCase() + key.slice(1);
    localStorage.setItem(`nubraMsSeries${storageKey}`, visible ? "1" : "0");
    for (const chart of msCharts.values()) {
      chart.setSeries(seriesIndex, { show: visible });
      chart.redraw();
    }
  }

  // Combine a CE leg + a PE leg into a strangle quote (bid/ask/iv mid %).
  function combineStrangle(ce, pe) {
    if (!ce || !pe) return null;
    const bid = ce.bid + pe.bid;
    const ask = ce.ask + pe.ask;
    if (bid <= 0 || ask <= 0) return null;
    const ceIvMid = ce.ivMid != null ? ce.ivMid
      : (ce.ivBid != null && ce.ivAsk != null) ? (ce.ivBid + ce.ivAsk) / 2 : null;
    const peIvMid = pe.ivMid != null ? pe.ivMid
      : (pe.ivBid != null && pe.ivAsk != null) ? (pe.ivBid + pe.ivAsk) / 2 : null;
    let ivMid = null;
    if (ceIvMid != null && peIvMid != null) ivMid = ((ceIvMid + peIvMid) / 2) * 100;
    else if (ceIvMid != null) ivMid = ceIvMid * 100;
    else if (peIvMid != null) ivMid = peIvMid * 100;
    return { bid, ask, mid: (bid + ask) / 2, ivMid };
  }

  async function loadMultiSpread() {
    const offsets = msVisibleOffsets();
    for (const offset of offsets) initMsChart(offset);
    const start = fromLocalInput(rollStart());
    const end = fromLocalInput(rollEnd());
    if (!start || !end) throw new Error("Start and end are required.");

    const sym = rollSymbol().trim().toUpperCase();
    setMsStatus("Spot");
    setMsCells({});
    msLines.clear();

    const spotSym = rollExchange() === "MCX" ? await resolveMcxMarketSymbol(sym, rollExpiry()) : sym;
    const spotType = rollExchange() === "MCX" && spotSym.startsWith("FUT_") ? "FUT" : rollType();
    if (rollExchange() === "MCX" && !spotSym.startsWith("FUT_")) {
      throw new Error(`MCX future symbol not found for ${sym}.`);
    }

    let resolvedInterval = ROLLING_INTERVALS[0];
    let spotPoints = [];
    let spotError = null;
    for (const intervalValue of ROLLING_INTERVALS) {
      try {
        const { data: spotData } = await fetchTimeseriesWithIntervals({
          exchange: rollExchange(), type: spotType, values: [spotSym], fields: ["close"],
          startDate: start, endDate: end, intraDay: false, realTime: false
        }, [intervalValue]);
        const spotSymbolData = extractSymbolData(spotData, spotSym);
        spotPoints = (Array.isArray(spotSymbolData?.close) ? spotSymbolData.close : [])
          .map((p) => ({ ts: pointMs(p), spot: pointNumber(p, true) }))
          .filter((p) => Number.isFinite(p.ts) && p.spot > 0)
          .sort((a, b) => a.ts - b.ts);
        if (spotPoints.length) { resolvedInterval = intervalValue; break; }
      } catch (error) { spotError = error; }
    }
    if (!spotPoints.length) throw new Error(spotError?.message || `No spot data for ${spotSym}.`);

    setMsStatus("Refdata");
    let rows = await rollingOptionRows();
    let expiries = [...new Set(rows.map((r) => r.expiry))].sort();
    if (!expiries.length) throw new Error(`No option expiries for ${sym}.`);
    if (!rollExpiry() || !expiries.includes(rollExpiry())) {
      setRollExpiries(expiries);
      setRollExpiry(expiries[0] || "");
      rows = await rollingOptionRows();
    }
    rows = rows.filter((r) => r.expiry === rollExpiry());
    if (!rows.length) throw new Error("No option rows for selected expiry.");

    const strikes = [...new Set(rows.map((r) => r.strike))].sort((a, b) => a - b);
    const step = inferStrikeStep(strikes);
    const rowByKey = new Map(rows.map((r) => [`${r.strike}|${r.side}`, r]));

    // Only the CE/PE strikes the selected offsets need across the whole session.
    const requiredStrikes = new Set();
    for (const point of spotPoints) {
      const atm = nearestStrike(point.spot, strikes, step);
      for (const n of offsets) {
        requiredStrikes.add(nearestStrike(atm + n * step, strikes, step));
        requiredStrikes.add(nearestStrike(atm - n * step, strikes, step));
      }
    }

    const optionNames = [];
    const aliasToCanonical = new Map();
    const liveRefIds = new Set();
    const addAliases = (row) => {
      const aliases = row.aliases?.length ? row.aliases : [row.name];
      for (const alias of aliases) {
        const key = String(alias || "").toUpperCase();
        if (!key) continue;
        optionNames.push(key);
        aliasToCanonical.set(key, row.name);
      }
    };
    for (const strike of requiredStrikes) {
      const ce = rowByKey.get(`${strike}|CE`);
      const pe = rowByKey.get(`${strike}|PE`);
      if (ce) { addAliases(ce); if (ce.refId) liveRefIds.add(ce.refId); }
      if (pe) { addAliases(pe); if (pe.refId) liveRefIds.add(pe.refId); }
    }
    if (!optionNames.length) throw new Error("No CE/PE symbols found around ATM.");

    setMsStatus("Quotes");
    let seriesByName = await fetchRollingSeries([...new Set(optionNames)], start, end, aliasToCanonical, resolvedInterval);
    if (!seriesByName.size && resolvedInterval !== "1m") {
      const fallback = await fetchRollingSeries([...new Set(optionNames)], start, end, aliasToCanonical, "1m");
      if (fallback.size) { seriesByName = fallback; resolvedInterval = "1m"; }
    }
    if (!seriesByName.size) throw new Error(`No option series returned for ${sym} ${rollExpiry()}.`);

    // Walk spot points once; each cursor map is private per option name. A fresh
    // cursor per offset keeps the forward-only quote walk correct.
    const cursorByName = new Map();
    const lines = new Map();   // offset -> { bid:[], ask:[], iv:[], last:{...} }
    for (const offset of offsets) lines.set(offset, { bid: [], ask: [], iv: [], last: null });

    for (const point of spotPoints) {
      const atm = nearestStrike(point.spot, strikes, step);
      const t = tvTime(point.ts);
      for (const offset of offsets) {
        const ceStrike = nearestStrike(atm + offset * step, strikes, step);
        const peStrike = nearestStrike(atm - offset * step, strikes, step);
        const ceRow = rowByKey.get(`${ceStrike}|CE`);
        const peRow = rowByKey.get(`${peStrike}|PE`);
        if (!ceRow || !peRow) continue;
        const ce = advanceQuote(ceRow.name, seriesByName, cursorByName, point.ts);
        const pe = advanceQuote(peRow.name, seriesByName, cursorByName, point.ts);
        const combined = combineStrangle(ce, pe);
        if (!combined) continue;
        const bucket = lines.get(offset);
        bucket.bid.push({ time: t, value: combined.bid });
        bucket.ask.push({ time: t, value: combined.ask });
        if (combined.ivMid != null && combined.ivMid > 0) bucket.iv.push({ time: t, value: combined.ivMid });
        bucket.last = { ceStrike, peStrike, bid: combined.bid, ask: combined.ask, ivMid: combined.ivMid };
      }
    }

    const cells = {};
    for (const offset of offsets) {
      const bucket = lines.get(offset);
      setMsChartLines(offset, bucket.bid, bucket.ask, bucket.iv);
      const last = bucket.last;
      cells[offset] = last ? {
        ceStrike: number.format(last.ceStrike),
        peStrike: number.format(last.peStrike),
        bid: last.bid != null ? last.bid.toFixed(2) : null,
        ask: last.ask != null ? last.ask.toFixed(2) : null,
        iv: last.ivMid != null ? last.ivMid.toFixed(1) : null,
        hasData: bucket.bid.length > 0
      } : { hasData: false };
    }
    setMsCells(cells);

    // Build a live context shared across all charts (union of all refIds).
    msLiveContext = {
      strikes, step, rowByKey,
      optionByRef: new Map(), orderbookByRef: new Map(), greeksByRef: new Map(),
      refIds: [...liveRefIds],
      spotSymbol: spotSym,
      spot: spotPoints[spotPoints.length - 1]?.spot
    };

    setMsStatus(`Ready · ${resolvedInterval} · ${offsets.length} charts`);
    if (!msLiveSocket) startMsLive();
  }

  // ── Multi Spread live ──
  function handleMsLiveChain(chain, receivedAtMs) {
    if (!msLiveContext || !chain) return;
    const spot = toRupees(chain.current_price);
    if (spot && spot > 0) msLiveContext.spot = spot;
    const save = (option, side) => {
      const refId = liveRefId(option);
      if (!refId) return;
      const prev = msLiveContext.optionByRef.get(refId) || {};
      msLiveContext.optionByRef.set(refId, { ...prev, ...option, side, refId });
    };
    for (const o of Array.isArray(chain.ce) ? chain.ce : []) save(o, "CE");
    for (const o of Array.isArray(chain.pe) ? chain.pe : []) save(o, "PE");
    scheduleMsLiveUpdate(receivedAtMs);
  }

  function handleMsLiveOrderbook(book, receivedAtMs) {
    if (!msLiveContext || !book) return;
    eachLivePayload(book, (item) => {
      const refId = liveRefId(item);
      if (refId) msLiveContext.orderbookByRef.set(refId, item);
    });
    scheduleMsLiveUpdate(receivedAtMs);
  }

  function handleMsLiveGreeks(greek, receivedAtMs) {
    if (!msLiveContext || !greek) return;
    eachLivePayload(greek, (item) => {
      const refId = liveRefId(item);
      if (!refId) return;
      const prev = msLiveContext.greeksByRef.get(refId) || {};
      msLiveContext.greeksByRef.set(refId, { ...prev, ...item });
    });
    scheduleMsLiveUpdate(receivedAtMs);
  }

  function readMsLiveLeg(row) {
    if (!msLiveContext || !row) return null;
    const refId = liveRefId(row);
    const book = refId ? msLiveContext.orderbookByRef.get(refId) : null;
    const greek = refId ? msLiveContext.greeksByRef.get(refId) : null;
    const tick = refId ? msLiveContext.optionByRef.get(refId) : null;
    const fallbackPrice = toRupees(
      book?.last_traded_price ?? book?.ltp ?? tick?.last_traded_price ?? tick?.ltp ??
      greek?.last_traded_price ?? greek?.ltp ?? row.last_traded_price ?? row.ltp
    );
    const iv = liveIv(greek) ?? liveIv(tick) ?? liveIv(row);
    return {
      bid: firstPriceLevel(book?.bids) ?? fallbackPrice,
      ask: firstPriceLevel(book?.asks) ?? fallbackPrice,
      ivMid: iv != null ? iv / 100 : null   // combineStrangle multiplies by 100
    };
  }

  function scheduleMsLiveUpdate(receivedAtMs) {
    if (!isMarketHours(rollExchange())) { stopMsLive(); setMsStatus("Market closed"); return; }
    msThrottlePending = receivedAtMs || Date.now();
    if (!msThrottleTimer) {
      msThrottleTimer = setTimeout(() => {
        msThrottleTimer = null;
        const ts = msThrottlePending;
        msThrottlePending = null;
        updateMsLiveSnapshot(ts);
      }, 400);
    }
  }

  function updateMsLiveSnapshot(receivedAtMs = Date.now()) {
    if (!msLiveContext) return;
    const { strikes, rowByKey, optionByRef, step, spot } = msLiveContext;
    if (!spot || spot <= 0) return;
    const atm = nearestStrike(spot, strikes, step);
    const time = tvTime(receivedAtMs);
    const cells = { ...msCells() };
    for (const offset of msVisibleOffsets()) {
      if (!msLines.has(offset)) continue; // only update charts whose data is loaded
      const ceStrike = nearestStrike(atm + offset * step, strikes, step);
      const peStrike = nearestStrike(atm - offset * step, strikes, step);
      const ceRow = rowByKey.get(`${ceStrike}|CE`);
      const peRow = rowByKey.get(`${peStrike}|PE`);
      if (!ceRow || !peRow) continue;
      const ce = readMsLiveLeg(optionByRef.get(ceRow.refId) || ceRow);
      const pe = readMsLiveLeg(optionByRef.get(peRow.refId) || peRow);
      if (!ce || !pe || !ce.bid || !pe.bid || !ce.ask || !pe.ask) continue;
      const combined = combineStrangle(ce, pe);
      if (!combined) continue;
      const lines = msLines.get(offset) || { bid: [], ask: [], iv: [] };
      const nextBid = [...lines.bid, { time, value: combined.bid }];
      const nextAsk = [...lines.ask, { time, value: combined.ask }];
      const nextIv = combined.ivMid != null && combined.ivMid > 0
        ? [...lines.iv, { time, value: combined.ivMid }] : lines.iv;
      setMsChartLines(offset, nextBid, nextAsk, nextIv);
      cells[offset] = {
        ceStrike: number.format(ceStrike),
        peStrike: number.format(peStrike),
        bid: combined.bid.toFixed(2),
        ask: combined.ask.toFixed(2),
        iv: combined.ivMid != null ? combined.ivMid.toFixed(1) : null,
        hasData: true
      };
    }
    setMsCells(cells);
    setMsStatus("Live tick");
  }

  function startMsLive() {
    if (msCutoffTimer) { clearTimeout(msCutoffTimer); msCutoffTimer = null; }
    if (msLiveSocket) { msLiveSocket.close(); msLiveSocket = null; }
    const exch = rollExchange();
    if (!isMarketHours(exch)) { setMsStatus("Market closed"); return; }
    const cutoffMs = msUntilMarketClose(exch);
    if (cutoffMs > 0) msCutoffTimer = setTimeout(() => { stopMsLive(); setMsStatus("Market closed"); }, cutoffMs);
    const expiry = rollExpiry();
    if (!expiry) { setMsStatus("Select expiry first"); return; }
    if (!token().trim() || !deviceId().trim()) { setMsStatus("Session needed"); return; }
    if (!msLiveContext?.refIds?.length) { setMsStatus("Plot first"); return; }
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws/live`);
    msLiveSocket = ws;
    setMsStatus("Live starting");
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "subscribe",
        environment: environment().includes("uat") ? "uat" : "prod",
        token: token().replace("Bearer ", "").trim(),
        deviceId: deviceId().trim(),
        symbol: rollSymbol().trim().toUpperCase(),
        spotSymbol: msLiveContext.spotSymbol || rollSymbol().trim().toUpperCase(),
        exchange: rollExchange(),
        interval: "1m",
        expiry,
        refIds: msLiveContext.refIds
      }));
      setMsLiveOn(true);
      setMsStatus(`Live · ${msLiveContext.refIds.length} legs`);
    };
    ws.onmessage = (e) => {
      if (!isMarketHours(rollExchange())) { stopMsLive(); setMsStatus("Market closed"); return; }
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.event === "option" && msg.data) handleMsLiveChain(msg.data, msg.received_at_ms);
      if (msg.event === "orderbook" && msg.data) handleMsLiveOrderbook(msg.data, msg.received_at_ms);
      if (msg.event === "greeks" && msg.data) handleMsLiveGreeks(msg.data, msg.received_at_ms);
      if (msg.event === "error") setMsStatus(msg.message || "Live error");
    };
    ws.onclose = () => {
      if (msLiveSocket !== ws) return;
      msLiveSocket = null;
      setMsLiveOn(false);
      setMsStatus("Live stopped");
    };
    ws.onerror = () => setMsStatus("WS error");
  }

  function stopMsLive() {
    if (msCutoffTimer) { clearTimeout(msCutoffTimer); msCutoffTimer = null; }
    if (msThrottleTimer) { clearTimeout(msThrottleTimer); msThrottleTimer = null; msThrottlePending = null; }
    if (msLiveSocket) {
      try { msLiveSocket.send(JSON.stringify({ type: "stop" })); } catch {}
      msLiveSocket.close();
      msLiveSocket = null;
    }
    setMsLiveOn(false);
    setMsStatus("Idle");
  }

  // ═══════════════════════════════════════════════════════════════
  // Premium Decay — per-leg decay vs 9:15 open
  //
  // Each plotted line is ONE option leg ({strike, side}): its LTP as % of its own
  // 9:15 open. Below 0 = that leg's premium decayed; above 0 = it gained. Plotting
  // CE and PE legs separately (instead of a combined strangle) lets you compare
  // whether the ATM / OTM2 / OTM4… leg — on the call or put side — is bleeding
  // faster. Legs come from one of three pick modes (rolling ATM±N, fixed center±N,
  // or a custom hand-picked list). Spot overlays on a separate right axis.
  // Series layout: [x, leg0, leg1, …, spot] — built dynamically from the leg set.
  // ═══════════════════════════════════════════════════════════════

  // Distinct color per leg, by index. CE legs lean warm/green, PE legs warm/red
  // is applied at build time; this palette just keeps adjacent lines distinct.
  const PD_CE_COLORS = ["#10B981", "#10B981", "#10B981", "#10B981", "#10B981", "#10B981", "#10B981", "#10B981"];
  const PD_PE_COLORS = ["#EF4444", "#EF4444", "#EF4444", "#EF4444", "#EF4444", "#EF4444", "#EF4444", "#EF4444"];
  const pdLegKey = (leg) => `${leg.strike}|${leg.side}`;
  const pdLegColor = (leg, ceIdx, peIdx) =>
    leg.side === "CE" ? PD_CE_COLORS[ceIdx % PD_CE_COLORS.length] : PD_PE_COLORS[peIdx % PD_PE_COLORS.length];

  // The current leg set (array of {strike, side, key, color}) drives series + data
  // layout. Rebuilt whenever pdLines is built so chart/series/tooltip stay aligned.
  let pdLegs = [];
  const pdSpotIndex = () => 1 + pdLegs.length;

  // ── Strike-selection model → final leg list ──────────────────────────────
  // Builds the {strike, side} legs to plot from the active pick mode. For ATM/fixed
  // we pair a CE and a PE at each chosen strike; custom uses the explicit list.
  const pdSelectedLegs = createMemo(() => {
    const { strikes, step, atm } = pdChainRows();
    const mode = pdPickMode();
    if (mode === "custom") {
      return pdCustomLegs()
        .filter((l) => Number.isFinite(l?.strike) && (l.side === "CE" || l.side === "PE"))
        .map((l) => ({ strike: Number(l.strike), side: l.side }));
    }
    if (!strikes.length || !step) return [];
    const legs = [];
    const addPair = (strike) => {
      if (!Number.isFinite(strike)) return;
      legs.push({ strike, side: "CE" });
      legs.push({ strike, side: "PE" });
    };
    if (mode === "fixed") {
      const center = Number(pdFixedCenter());
      const base = Number.isFinite(center) && center > 0 ? nearestStrike(center, strikes, step) : atm;
      if (base == null) return [];
      const n = Math.max(0, Math.round(pdFixedRange()));
      for (let i = -n; i <= n; i++) addPair(nearestStrike(base + i * step, strikes, step));
    } else { // atm
      if (atm == null) return [];
      const n = Math.max(0, Math.round(pdAtmRange()));
      for (let i = -n; i <= n; i++) addPair(nearestStrike(atm + i * step, strikes, step));
    }
    // de-dup (nearestStrike can collapse to the same strike at the edges)
    const seen = new Set();
    return legs.filter((l) => { const k = pdLegKey(l); if (seen.has(k)) return false; seen.add(k); return true; });
  });

  // Legend rows = selected legs decorated with their chart color + live summary.
  // Colors are assigned by per-side index, identical to loadPremiumDecay.
  const pdLegendLegs = createMemo(() => {
    const summary = pdCells()?.summary || {};
    let ceI = 0, peI = 0;
    return pdSelectedLegs().map((leg) => {
      const key = pdLegKey(leg);
      const color = pdLegColor(leg, leg.side === "CE" ? ceI++ : ceI, leg.side === "PE" ? peI++ : peI);
      return { strike: leg.strike, side: leg.side, key, color, ...(summary[key] || {}) };
    });
  });

  // Build the chain-table rows (strikes around ATM) for the sidebar from refdata.
  async function loadPdChainRows() {
    const sym = rollSymbol().trim().toUpperCase();
    if (!sym) throw new Error("Pick a symbol first.");
    setPdStatus("Chain");
    let rows = await rollingOptionRows();
    let expiries = [...new Set(rows.map((r) => r.expiry))].sort();
    if (!expiries.length) throw new Error(`No option expiries for ${sym}.`);
    if (!rollExpiry() || !expiries.includes(rollExpiry())) {
      setRollExpiries(expiries);
      setRollExpiry(expiries[0] || "");
    }
    rows = rows.filter((r) => r.expiry === rollExpiry());
    const strikes = [...new Set(rows.map((r) => r.strike))].sort((a, b) => a - b);
    if (!strikes.length) throw new Error("No strikes for selected expiry.");
    const step = inferStrikeStep(strikes);
    let atm = pdLiveContext?.spot ? nearestStrike(pdLiveContext.spot, strikes, step) : null;
    if (atm == null) {
      try {
        const exch = rollExchange();
        const priceSym = exch === "MCX" ? mcxMarketSymbol(sym, rollExpiry()) : sym;
        const suffix = exch !== "NSE" ? `?exchange=${encodeURIComponent(exch)}` : "";
        const data = await nubraFetch(`optionchains/${encodeURIComponent(priceSym)}/price${suffix}`);
        const px = toRupees(data.price);
        if (Number.isFinite(px) && px > 0) atm = nearestStrike(px, strikes, step);
      } catch {}
    }
    if (atm == null) atm = strikes[Math.floor(strikes.length / 2)];
    setPdChainRows({ strikes, step, atm });
    if (!pdFixedCenter()) setPdFixedCenter(String(atm));
    setPdStatus(`${strikes.length} strikes · ATM ${atm}`);
    return { strikes, step, atm };
  }

  function pdToggleCustomLeg(strike, side) {
    const key = `${strike}|${side}`;
    setPdCustomLegs((legs) => {
      const exists = legs.some((l) => `${l.strike}|${l.side}` === key);
      const next = exists ? legs.filter((l) => `${l.strike}|${l.side}` !== key)
                          : [...legs, { strike: Number(strike), side }];
      localStorage.setItem("nubraPdCustomLegs", JSON.stringify(next));
      return next;
    });
  }
  function pdRemoveCustomLeg(strike, side) {
    setPdCustomLegs((legs) => {
      const next = legs.filter((l) => `${l.strike}|${l.side}` !== `${strike}|${side}`);
      localStorage.setItem("nubraPdCustomLegs", JSON.stringify(next));
      return next;
    });
  }
  function pdClearCustomLegs() {
    setPdCustomLegs([]);
    localStorage.setItem("nubraPdCustomLegs", "[]");
  }
  // Add every visible strike as legs. side: "both" | "CE" | "PE".
  function pdSelectAllCustom(side = "both") {
    const { strikes } = pdChainRows();
    if (!strikes?.length) return;
    const wantCE = side === "both" || side === "CE";
    const wantPE = side === "both" || side === "PE";
    const next = [];
    for (const strike of strikes) {
      if (wantCE) next.push({ strike: Number(strike), side: "CE" });
      if (wantPE) next.push({ strike: Number(strike), side: "PE" });
    }
    setPdCustomLegs(next);
    localStorage.setItem("nubraPdCustomLegs", JSON.stringify(next));
  }
  function setPdPickModeP(mode) { setPdPickMode(mode); localStorage.setItem("nubraPdMode", mode); }
  function setPdAtmRangeP(n) { setPdAtmRange(n); localStorage.setItem("nubraPdAtmRange", String(n)); }
  function setPdFixedRangeP(n) { setPdFixedRange(n); localStorage.setItem("nubraPdFixedRange", String(n)); }
  function setPdFixedCenterP(v) { setPdFixedCenter(v); }

  function pdRememberScale(key, range) {
    if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.max <= range.min) return;
    pdManualScales = { ...pdManualScales, [key]: { min: range.min, max: range.max } };
    if (key === "x") syncRollXFromIndicator("premium", range);
  }
  function pdClearScales(keys = ["x", "decay", "spot"]) {
    for (const k of keys) pdManualScales[k] = null;
  }
  function pdApplyScales() {
    if (!pdChart) return;
    for (const key of ["x", "decay", "spot"]) {
      const saved = pdManualScales[key];
      if (saved && scaleRangeChanged(pdChart.scales[key], saved)) pdChart.setScale(key, saved);
    }
  }
  function pdFitWindow() {
    if (!pdChart || !pdChartData?.[0]?.length) return;
    const x = pdChartData[0];
    const pad = Math.max(30, (x[x.length - 1] - x[0]) * 0.02);
    pdChart.setScale("x", { min: x[0] - pad, max: x[x.length - 1] + pad });
  }

  // Decay (%) axis kept symmetric around 0 so the zero baseline reads clearly.
  function pdDecayRange(_u, dataMin, dataMax) {
    if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) return [-1, 1];
    const mag = Math.max(Math.abs(dataMin), Math.abs(dataMax), 1);
    const pad = mag * 0.1;
    return [-(mag + pad), mag + pad];
  }

  function pdIsLegVisible(leg) { return pdLegVisibility()[leg.key] !== false; }
  function pdIsSeriesVisible(idx) {
    if (idx === pdSpotIndex()) return pdSpotVisible();
    const leg = pdLegs[idx - 1];
    return leg ? pdIsLegVisible(leg) : true;
  }

  function pdBuildSeries() {
    const series = [{}];
    for (const leg of pdLegs) {
      series.push({
        label: `${leg.strike} ${leg.side}`, scale: "decay", stroke: leg.color, width: 1.6,
        dash: leg.side === "PE" ? [4, 3] : undefined,
        show: pdIsLegVisible(leg), points: { show: false }
      });
    }
    series.push({ label: "Spot", scale: "spot", stroke: "#9aa1aa", width: 1, dash: [2, 3], show: pdSpotVisible(), points: { show: false } });
    return series;
  }

  function initPdChart() {
    if (pdChart || !pdChartHost || typeof uPlot === "undefined") return;
    const rect = pdChartHost.getBoundingClientRect();
    if (!pdChartData) pdChartData = [[], ...pdLegs.map(() => []), []];
    const axisFont = "11px monospace";
    pdChart = new uPlot({
      width: Math.max(1, Math.floor(rect.width)),
      height: Math.max(220, Math.floor(rect.height)),
      pxAlign: true,
      legend: { show: false },
      cursor: { drag: { x: false, y: false }, points: { show: false }, focus: { prox: 24 }, x: true, y: true },
      scales: {
        x: { time: true },
        decay: { auto: true, range: pdDecayRange },
        spot: { auto: true, range: paddedRollRange }
      },
      axes: [
        {
          show: true, size: 40, gap: 6, font: axisFont, stroke: "#c9cdd3",
          border: { show: true, stroke: "rgba(255,255,255,0.24)", width: 1 },
          grid: { show: true, stroke: "rgba(68,80,94,0.35)", width: 1 },
          ticks: { show: true, stroke: "rgba(255,255,255,0.18)", width: 1, size: 5 },
          values: (_u, vals) => vals.map((v) => formatIstTime(v)),
          space: 80
        },
        {
          show: true, scale: "decay", side: 3, size: 56, gap: 8, font: axisFont, stroke: "#c9cdd3",
          border: { show: true, stroke: "rgba(255,255,255,0.24)", width: 1 },
          grid: { show: true, stroke: "rgba(68,80,94,0.35)", width: 1 },
          ticks: { show: true, stroke: "rgba(255,255,255,0.18)", width: 1, size: 5 },
          values: (_u, vals) => vals.map((v) => `${v > 0 ? "+" : ""}${Number(v).toFixed(0)}`),
          space: 36
        },
        {
          show: true, scale: "spot", side: 1, size: 64, gap: 8, font: axisFont, stroke: "#9aa1aa",
          border: { show: true, stroke: "rgba(255,255,255,0.24)", width: 1 },
          grid: { show: false },
          ticks: { show: true, stroke: "rgba(255,255,255,0.18)", width: 1, size: 5 },
          values: (_u, vals) => vals.map((v) => Number(v).toFixed(0)),
          space: 40
        }
      ],
      series: pdBuildSeries(),
      plugins: [createPdZeroLinePlugin(), createPdInteractionPlugin(), createPdTooltipPlugin()]
    }, pdChartData, pdChartHost);
    queueChartResize();
  }

  function createPdZeroLinePlugin() {
    return {
      hooks: {
        draw: [(u) => {
          const scale = u.scales.decay;
          if (!scale || !Number.isFinite(scale.min) || !Number.isFinite(scale.max)) return;
          if (scale.min > 0 || scale.max < 0) return;
          const y = Math.round(u.valToPos(0, "decay", true));
          const ctx = u.ctx;
          ctx.save();
          ctx.beginPath();
          ctx.strokeStyle = "rgba(255,255,255,0.42)";
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.moveTo(u.bbox.left, y);
          ctx.lineTo(u.bbox.left + u.bbox.width, y);
          ctx.stroke();
          ctx.restore();
        }]
      }
    };
  }

  function createPdInteractionPlugin() {
    let over;
    let destroy = () => {};
    const xBounds = () => {
      const x = pdChartData?.[0] || [];
      const pad = Math.max(30, (x[x.length - 1] - x[0]) * 0.02);
      return { min: x[0] - pad, max: x[x.length - 1] + pad };
    };
    const hasData = () => (pdChartData?.[0]?.length || 0) > 0;
    const zoomAxis = (u, key, pct, factor, hardMin, hardMax, minSpan) => {
      const scale = u.scales[key];
      if (!scale || !Number.isFinite(scale.min) || !Number.isFinite(scale.max)) return;
      const span = scale.max - scale.min;
      const anchor = scale.min + span * pct;
      const nextSpan = span * factor;
      const range = clampRange(anchor - nextSpan * pct, anchor + nextSpan * (1 - pct), hardMin, hardMax, minSpan);
      pdRememberScale(key, range);
      u.setScale(key, range);
    };
    return {
      hooks: {
        ready: [(u) => {
          over = u.over;
          let dragStart = null;
          let axisDragStart = null;
          const wheel = (event) => {
            if (!hasData()) return;
            event.preventDefault();
            const rect = over.getBoundingClientRect();
            const xPct = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
            const yPct = Math.min(1, Math.max(0, 1 - ((event.clientY - rect.top) / rect.height)));
            const { min: xMin, max: xMax } = xBounds();
            if (Math.abs(event.deltaX) > Math.abs(event.deltaY) && !event.ctrlKey && !event.metaKey) {
              const scale = u.scales.x;
              const span = scale.max - scale.min;
              const shift = (event.deltaX / rect.width) * span;
              const range = clampRange(scale.min + shift, scale.max + shift, xMin, xMax, span);
              pdRememberScale("x", range);
              u.setScale("x", range);
              return;
            }
            const factor = event.deltaY < 0 ? 0.82 : 1.22;
            const zoomY = event.shiftKey || event.altKey || event.ctrlKey || event.metaKey;
            const zoomX = !event.shiftKey || event.ctrlKey || event.metaKey;
            if (zoomX) zoomAxis(u, "x", xPct, factor, xMin, xMax, 10);
            if (zoomY) {
              zoomAxis(u, "decay", yPct, factor, -Infinity, Infinity, 0.5);
              zoomAxis(u, "spot", yPct, factor, -Infinity, Infinity, 0.5);
            }
          };
          const axisWheel = (scaleKey) => (event) => {
            if (!hasData()) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const factor = event.deltaY < 0 ? 0.86 : 1.16;
            if (scaleKey === "x") {
              const { min, max } = xBounds();
              const xPct = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
              zoomAxis(u, "x", xPct, factor, min, max, 10);
              return;
            }
            const yPct = Math.min(1, Math.max(0, 1 - ((event.clientY - rect.top) / Math.max(1, rect.height))));
            zoomAxis(u, scaleKey, yPct, factor, -Infinity, Infinity, 0.5);
          };
          const pointerDown = (event) => {
            if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
            dragStart = {
              x: event.clientX, y: event.clientY,
              xMin: u.scales.x.min, xMax: u.scales.x.max,
              decayMin: u.scales.decay?.min, decayMax: u.scales.decay?.max,
              spotMin: u.scales.spot?.min, spotMax: u.scales.spot?.max
            };
            over.setPointerCapture?.(event.pointerId);
          };
          const pointerMove = (event) => {
            if (!dragStart || !hasData()) return;
            event.preventDefault();
            const rect = over.getBoundingClientRect();
            const dx = event.clientX - dragStart.x;
            const dy = event.clientY - dragStart.y;
            const { min: xHardMin, max: xHardMax } = xBounds();
            const xSpan = dragStart.xMax - dragStart.xMin;
            const xShift = -(dx / Math.max(1, rect.width)) * xSpan;
            const xRange = clampRange(dragStart.xMin + xShift, dragStart.xMax + xShift, xHardMin, xHardMax, xSpan);
            pdRememberScale("x", xRange);
            u.setScale("x", xRange);
            const panY = (key, min, max) => {
              if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return;
              const span = max - min;
              const shift = (dy / Math.max(1, rect.height)) * span;
              const range = clampRange(min + shift, max + shift, -Infinity, Infinity, span);
              pdRememberScale(key, range);
              u.setScale(key, range);
            };
            panY("decay", dragStart.decayMin, dragStart.decayMax);
            panY("spot", dragStart.spotMin, dragStart.spotMax);
          };
          const pointerUp = (event) => {
            dragStart = null;
            over.releasePointerCapture?.(event.pointerId);
          };
          const axisPointerDown = (scaleKey) => (event) => {
            if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
            const scale = u.scales[scaleKey];
            if (!scale || !Number.isFinite(scale.min) || !Number.isFinite(scale.max)) return;
            axisDragStart = { scaleKey, x: event.clientX, y: event.clientY, min: scale.min, max: scale.max };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          };
          const axisPointerMove = (event) => {
            if (!axisDragStart || !hasData()) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const span = axisDragStart.max - axisDragStart.min;
            const mid = (axisDragStart.min + axisDragStart.max) / 2;
            if (axisDragStart.scaleKey === "x") {
              const dx = event.clientX - axisDragStart.x;
              const { min, max } = xBounds();
              const factor = Math.exp(-dx / Math.max(120, rect.width));
              const nextSpan = Math.max(10, span * factor);
              const range = clampRange(mid - nextSpan / 2, mid + nextSpan / 2, min, max, 10);
              pdRememberScale("x", range);
              u.setScale("x", range);
              return;
            }
            const dy = event.clientY - axisDragStart.y;
            const factor = Math.exp(dy / Math.max(120, rect.height));
            const nextSpan = Math.max(0.5, span * factor);
            const range = clampRange(mid - nextSpan / 2, mid + nextSpan / 2, -Infinity, Infinity, 0.5);
            pdRememberScale(axisDragStart.scaleKey, range);
            u.setScale(axisDragStart.scaleKey, range);
          };
          const axisPointerUp = (event) => {
            axisDragStart = null;
            event.currentTarget.releasePointerCapture?.(event.pointerId);
          };
          const doubleClick = () => {
            pdClearScales();
            u.setScale("decay", { min: null, max: null });
            u.setScale("spot", { min: null, max: null });
            pdFitWindow();
          };
          const axisHandlers = [
            { el: u.axes[0]?._el, scale: "x" },
            { el: u.axes[1]?._el, scale: "decay" },
            { el: u.axes[2]?._el, scale: "spot" }
          ].filter((item) => item.el);
          for (const item of axisHandlers) {
            item.el.style.cursor = item.scale === "x" ? "ew-resize" : "ns-resize";
            item.wheel = axisWheel(item.scale);
            item.pointerDown = axisPointerDown(item.scale);
            item.el.addEventListener("wheel", item.wheel, { passive: false });
            item.el.addEventListener("pointerdown", item.pointerDown);
            item.el.addEventListener("pointermove", axisPointerMove);
            item.el.addEventListener("pointerup", axisPointerUp);
            item.el.addEventListener("pointercancel", axisPointerUp);
            item.el.addEventListener("dblclick", doubleClick);
          }
          over.addEventListener("wheel", wheel, { passive: false });
          over.addEventListener("pointerdown", pointerDown);
          over.addEventListener("pointermove", pointerMove);
          over.addEventListener("pointerup", pointerUp);
          over.addEventListener("pointercancel", pointerUp);
          over.addEventListener("dblclick", doubleClick);
          destroy = () => {
            for (const item of axisHandlers) {
              item.el.removeEventListener("wheel", item.wheel);
              item.el.removeEventListener("pointerdown", item.pointerDown);
              item.el.removeEventListener("pointermove", axisPointerMove);
              item.el.removeEventListener("pointerup", axisPointerUp);
              item.el.removeEventListener("pointercancel", axisPointerUp);
              item.el.removeEventListener("dblclick", doubleClick);
            }
            over.removeEventListener("wheel", wheel);
            over.removeEventListener("pointerdown", pointerDown);
            over.removeEventListener("pointermove", pointerMove);
            over.removeEventListener("pointerup", pointerUp);
            over.removeEventListener("pointercancel", pointerUp);
            over.removeEventListener("dblclick", doubleClick);
          };
        }],
        setData: [(u) => {
          for (const key of ["x", "decay", "spot"]) {
            const saved = pdManualScales[key];
            if (saved && scaleRangeChanged(u.scales[key], saved)) {
              requestAnimationFrame(() => {
                const latest = pdManualScales[key];
                if (latest && scaleRangeChanged(u.scales[key], latest)) u.setScale(key, latest);
              });
            }
          }
        }],
        destroy: [() => destroy()]
      }
    };
  }

  function createPdTooltipPlugin() {
    let tooltip;
    return {
      hooks: {
        init: [(u) => {
          tooltip = document.createElement("div");
          tooltip.className = "roll-chart-tooltip";
          tooltip.hidden = true;
          u.over.appendChild(tooltip);
        }],
        setCursor: [(u) => {
          if (!tooltip || !pdChartData) return;
          const idx = u.cursor.idx;
          if (idx == null || idx < 0 || !pdChartData[0]?.length) { tooltip.hidden = true; return; }
          const time = pdChartData[0][idx];
          if (!Number.isFinite(time)) { tooltip.hidden = true; return; }
          const pct = (v) => (v > 0 ? "+" : "") + Number(v).toFixed(1) + "%";
          const parts = [`<span class="roll-tip-time">${formatIstTime(time)}</span>`];
          pdLegs.forEach((leg, i) => {
            const sIdx = 1 + i;
            const v = pdChartData[sIdx]?.[idx];
            if (!pdIsLegVisible(leg) || !Number.isFinite(v)) return;
            const meta = pdMeta?.[leg.key];
            const rup = meta?.ltp?.[idx];
            const iv = meta?.iv?.[idx];
            const state = meta?.state?.[idx];
            const rTxt = Number.isFinite(rup) ? ` ₹${number.format(Math.round(rup))}` : "";
            const ivTxt = Number.isFinite(iv) ? ` · IV ${iv.toFixed(1)}` : "";
            const flag = state === 2 ? " ⚠⚠ rising" : state === 1 ? " ⚠ stalled" : "";
            parts.push(`<span style="color:${leg.color}">${leg.strike} ${leg.side}: ${pct(v)}${rTxt}${ivTxt}${flag}</span>`);
          });
          const spot = pdChartData[pdSpotIndex()]?.[idx];
          if (pdSpotVisible() && Number.isFinite(spot)) parts.push(`<span style="color:#9aa1aa">Spot: ${number.format(spot)}</span>`);
          tooltip.innerHTML = parts.join("");
          tooltip.hidden = false;
          const left = Math.min(u.over.clientWidth - tooltip.offsetWidth - 12, Math.max(8, u.cursor.left + 14));
          const top = Math.max(8, Math.min(u.over.clientHeight - tooltip.offsetHeight - 12, u.cursor.top - 20));
          tooltip.style.left = `${left}px`;
          tooltip.style.top = `${top}px`;
        }]
      }
    };
  }

  // Apply built line data (pdLineData) to the chart. pdLineData.pct is keyed by
  // leg key, parallel to the current pdLegs order.
  function pdRenderLines() {
    if (!pdLineData) return;
    const x = pdLineData.times;
    pdChartData = [x, ...pdLegs.map((l) => pdLineData.pct[l.key] || []), pdLineData.spot];
    // The series array is leg-shaped; recreate the chart when the leg set changes.
    if (pdChart && pdChart.series.length !== pdLegs.length + 2) { pdChart.destroy(); pdChart = null; }
    initPdChart();
    if (!pdChart) return;
    pdChart.setData(pdChartData);
    if (pdChartHost) resizeChart(pdChart, pdChartHost);
    if (pdManualScales.x) pdApplyScales();
    else pdFitWindow();
  }

  function registerPdChartHost(el) {
    if (!el) {
      if (pdChart) { pdChart.destroy(); pdChart = null; }
      pdChartHost = null;
      return;
    }
    pdChartHost = el;
    initPdChart();
    pdRenderLines();
  }

  function togglePdLeg(key) {
    setPdLegVisibility((v) => ({ ...v, [key]: v[key] === false }));
    localStorage.setItem("nubraPdLegVis", JSON.stringify(pdLegVisibility()));
    pdApplyVisibility();
  }
  function togglePdSpot() {
    setPdSpotVisible((v) => !v);
    localStorage.setItem("nubraPdSpot", pdSpotVisible() ? "1" : "0");
    pdApplyVisibility();
  }
  function pdApplyVisibility() {
    if (!pdChart) return;
    pdLegs.forEach((leg, i) => pdChart.setSeries(1 + i, { show: pdIsLegVisible(leg) }));
    pdChart.setSeries(pdSpotIndex(), { show: pdSpotVisible() });
    pdChart.redraw();
  }

  // Forward-only LTP walk for a leg (private cursor per option name). LTP per
  // interval = candle close; clean single traded value, no bid/ask spike risk.
  function legLtp(name, seriesByName, ltpCursorByName, ts) {
    const keyName = String(name || "").toUpperCase();
    const series = seriesByName.get(keyName);
    const ltp = series?.ltp;
    if (!ltp?.length) return null;
    const cursor = ltpCursorByName.get(keyName) || { i: 0, v: null };
    while (cursor.i < ltp.length && ltp[cursor.i].ts <= ts) {
      cursor.v = ltp[cursor.i].v;
      cursor.i += 1;
    }
    ltpCursorByName.set(keyName, cursor);
    return cursor.v != null && cursor.v > 0 ? cursor.v : null;
  }

  async function loadPremiumDecay() {
    initPdChart();
    const start = fromLocalInput(rollStart());
    const end = fromLocalInput(rollEnd());
    if (!start || !end) throw new Error("Start and end are required.");

    const sym = rollSymbol().trim().toUpperCase();
    setPdStatus("Spot");
    setPdCells({});

    const spotSym = rollExchange() === "MCX" ? await resolveMcxMarketSymbol(sym, rollExpiry()) : sym;
    const spotType = rollExchange() === "MCX" && spotSym.startsWith("FUT_") ? "FUT" : rollType();
    if (rollExchange() === "MCX" && !spotSym.startsWith("FUT_")) {
      throw new Error(`MCX future symbol not found for ${sym}.`);
    }

    let resolvedInterval = ROLLING_INTERVALS[0];
    let spotPoints = [];
    let spotError = null;
    for (const intervalValue of ROLLING_INTERVALS) {
      try {
        const { data: spotData } = await fetchTimeseriesWithIntervals({
          exchange: rollExchange(), type: spotType, values: [spotSym], fields: ["close"],
          startDate: start, endDate: end, intraDay: false, realTime: false
        }, [intervalValue]);
        const spotSymbolData = extractSymbolData(spotData, spotSym);
        spotPoints = (Array.isArray(spotSymbolData?.close) ? spotSymbolData.close : [])
          .map((p) => ({ ts: pointMs(p), spot: pointNumber(p, true) }))
          .filter((p) => Number.isFinite(p.ts) && p.spot > 0)
          .sort((a, b) => a.ts - b.ts);
        if (spotPoints.length) { resolvedInterval = intervalValue; break; }
      } catch (error) { spotError = error; }
    }
    if (!spotPoints.length) throw new Error(spotError?.message || `No spot data for ${spotSym}.`);

    setPdStatus("Refdata");
    let rows = await rollingOptionRows();
    let expiries = [...new Set(rows.map((r) => r.expiry))].sort();
    if (!expiries.length) throw new Error(`No option expiries for ${sym}.`);
    if (!rollExpiry() || !expiries.includes(rollExpiry())) {
      setRollExpiries(expiries);
      setRollExpiry(expiries[0] || "");
      rows = await rollingOptionRows();
    }
    rows = rows.filter((r) => r.expiry === rollExpiry());
    if (!rows.length) throw new Error("No option rows for selected expiry.");

    const strikes = [...new Set(rows.map((r) => r.strike))].sort((a, b) => a - b);
    const step = inferStrikeStep(strikes);
    const rowByKey = new Map(rows.map((r) => [`${r.strike}|${r.side}`, r]));

    // Refresh the sidebar chain table with this expiry's strikes + ATM.
    const lastSpot = spotPoints[spotPoints.length - 1]?.spot;
    const atmNow = lastSpot ? nearestStrike(lastSpot, strikes, step) : strikes[Math.floor(strikes.length / 2)];
    setPdChainRows({ strikes, step, atm: atmNow });
    if (!pdFixedCenter()) setPdFixedCenter(String(atmNow));

    // Resolve the legs to plot from the active pick mode. For ATM mode the legs
    // are anchored to the FINAL ATM (the sidebar reflects the same), so the line
    // set is fixed for the session — each line is one strike's clean decay.
    const legs = pdSelectedLegs();
    if (!legs.length) throw new Error("Select at least one strike/leg in the sidebar.");

    // Build the working leg set with stable colors (CE green-ish, PE red-ish).
    let ceI = 0, peI = 0;
    pdLegs = legs.map((leg) => {
      const color = pdLegColor(leg, leg.side === "CE" ? ceI++ : ceI, leg.side === "PE" ? peI++ : peI);
      return { strike: leg.strike, side: leg.side, key: pdLegKey(leg), color };
    });

    // Fetch only the legs we actually plot.
    const optionNames = [];
    const aliasToCanonical = new Map();
    const liveRefIds = new Set();
    const legRows = new Map(); // key -> row
    const addAliases = (row) => {
      const aliases = row.aliases?.length ? row.aliases : [row.name];
      for (const alias of aliases) {
        const key = String(alias || "").toUpperCase();
        if (!key) continue;
        optionNames.push(key);
        aliasToCanonical.set(key, row.name);
      }
    };
    for (const leg of pdLegs) {
      const row = rowByKey.get(leg.key);
      if (!row) continue;
      legRows.set(leg.key, row);
      addAliases(row);
      if (row.refId) liveRefIds.add(row.refId);
    }
    if (!optionNames.length) throw new Error("None of the selected strikes exist for this expiry.");

    setPdStatus("Quotes");
    let seriesByName = await fetchRollingSeries([...new Set(optionNames)], start, end, aliasToCanonical, resolvedInterval);
    if (!seriesByName.size && resolvedInterval !== "1m") {
      const fallback = await fetchRollingSeries([...new Set(optionNames)], start, end, aliasToCanonical, "1m");
      if (fallback.size) { seriesByName = fallback; resolvedInterval = "1m"; }
    }
    if (!seriesByName.size) throw new Error(`No option series returned for ${sym} ${rollExpiry()}.`);

    // Per-leg 9:15 open LTP from the first positive point of its session series.
    const openLtp = new Map();
    const firstSeriesLtp = (name) => {
      const arr = seriesByName.get(String(name || "").toUpperCase())?.ltp;
      if (!arr?.length) return null;
      for (const p of arr) { if (p.v > 0) return p.v; }
      return null;
    };
    for (const leg of pdLegs) {
      const row = legRows.get(leg.key);
      if (!row) continue;
      const o = firstSeriesLtp(row.name);
      if (o != null) openLtp.set(leg.key, o);
    }

    const ltpCursorByName = new Map();
    const lastGoodLtp = new Map();
    const goodLtp = (name, key, ts) => {
      const ltp = legLtp(name, seriesByName, ltpCursorByName, ts);
      if (ltp != null && ltp > 0) { lastGoodLtp.set(key, ltp); return ltp; }
      return lastGoodLtp.has(key) ? lastGoodLtp.get(key) : null;
    };
    // IV mid (%) for a leg at ts via its iv series cursor.
    const ivCursorByName = new Map();
    const legIvMid = (name, ts) => {
      const s = seriesByName.get(String(name || "").toUpperCase());
      const pick = (arr, cur) => {
        if (!arr?.length) return null;
        const c = cur.get(name) || { i: 0, v: null };
        while (c.i < arr.length && arr[c.i].ts <= ts) { c.v = arr[c.i].v; c.i += 1; }
        cur.set(name, c);
        return c.v;
      };
      const mid = pick(s?.ivMid, ivCursorByName);
      if (mid != null && mid > 0) return mid <= 1 ? mid * 100 : mid;
      return null;
    };

    const times = [];
    const pct = {}; const ltpArr = {}; const ivArr = {}; const stateArr = {};
    for (const leg of pdLegs) { pct[leg.key] = []; ltpArr[leg.key] = []; ivArr[leg.key] = []; stateArr[leg.key] = []; }
    const spotArr = [];

    // % spike guard per leg.
    const lastPct = {};
    const guardPct = (key, p) => {
      const prev = lastPct[key];
      if (p == null) return prev ?? null;
      if (prev != null && Math.abs(p - prev) > 80) return prev;
      lastPct[key] = p;
      return p;
    };

    for (const point of spotPoints) {
      times.push(tvTime(point.ts));
      spotArr.push(point.spot);
      for (const leg of pdLegs) {
        const row = legRows.get(leg.key);
        const ltp = row ? goodLtp(row.name, leg.key, point.ts) : null;
        const open = openLtp.get(leg.key);
        const p = (ltp != null && open > 0) ? ((ltp - open) / open) * 100 : null;
        pct[leg.key].push(guardPct(leg.key, p));
        ltpArr[leg.key].push(ltp);
        ivArr[leg.key].push(row ? legIvMid(row.name, point.ts) : null);
        stateArr[leg.key].push(null); // filled below via slope
      }
    }

    // Recent-window decay state per leg: slope of the % line over ~20 min.
    // <-3 = decaying (0), within ±3 = stalled (1), >3 = rising (2).
    const lookback = Math.min(times.length, resolvedInterval === "1s" ? 1200 : 20);
    for (const leg of pdLegs) {
      const arr = pct[leg.key];
      const st = stateArr[leg.key];
      for (let i = 0; i < arr.length; i++) {
        const j = Math.max(0, i - lookback);
        const a = arr[j]; const b = arr[i];
        if (a == null || b == null) { st[i] = null; continue; }
        const slope = b - a;
        st[i] = slope > 3 ? 2 : slope > -3 ? 1 : 0;
      }
    }

    pdLineData = { times, pct, spot: spotArr };
    pdMeta = {};
    for (const leg of pdLegs) pdMeta[leg.key] = { ltp: ltpArr[leg.key], iv: ivArr[leg.key], state: stateArr[leg.key] };
    pdRenderLines();

    const lastIdx = times.length - 1;
    const summary = {};
    for (const leg of pdLegs) {
      summary[leg.key] = {
        pct: pct[leg.key][lastIdx],
        ltp: ltpArr[leg.key][lastIdx],
        iv: ivArr[leg.key][lastIdx],
        state: stateArr[leg.key][lastIdx]
      };
    }
    setPdCells({ summary, hasData: times.length > 0 });

    pdLiveContext = {
      strikes, step, rowByKey, legRows,
      optionByRef: new Map(), orderbookByRef: new Map(),
      refIds: [...liveRefIds],
      spotSymbol: spotSym,
      spot: lastSpot,
      openLtp,
      lastGoodLtp: new Map(),
      lastPct: { ...lastPct }
    };

    setPdStatus(`Ready · ${resolvedInterval} · ${pdLegs.length} legs`);
    if (!pdLiveSocket) startPdLive();
  }

  // ── Premium Decay live ──
  function handlePdLiveChain(chain, receivedAtMs) {
    if (!pdLiveContext || !chain) return;
    const spot = toRupees(chain.current_price);
    if (spot && spot > 0) pdLiveContext.spot = spot;
    const save = (option, side) => {
      const refId = liveRefId(option);
      if (!refId) return;
      const prev = pdLiveContext.optionByRef.get(refId) || {};
      pdLiveContext.optionByRef.set(refId, { ...prev, ...option, side, refId });
    };
    for (const o of Array.isArray(chain.ce) ? chain.ce : []) save(o, "CE");
    for (const o of Array.isArray(chain.pe) ? chain.pe : []) save(o, "PE");
    schedulePdLiveUpdate(receivedAtMs);
  }

  function handlePdLiveOrderbook(book, receivedAtMs) {
    if (!pdLiveContext || !book) return;
    eachLivePayload(book, (item) => {
      const refId = liveRefId(item);
      if (refId) pdLiveContext.orderbookByRef.set(refId, item);
    });
    schedulePdLiveUpdate(receivedAtMs);
  }

  // Live LTP for a leg (prefer traded price; no bid/ask mid spikes).
  function pdLiveLegLtp(row) {
    if (!pdLiveContext || !row) return null;
    const refId = liveRefId(row);
    const book = refId ? pdLiveContext.orderbookByRef.get(refId) : null;
    const tick = refId ? pdLiveContext.optionByRef.get(refId) : null;
    const ltp = toRupees(
      book?.last_traded_price ?? book?.ltp ?? tick?.last_traded_price ?? tick?.ltp ??
      row.last_traded_price ?? row.ltp
    );
    return ltp > 0 ? ltp : null;
  }
  // Live IV (%) for a leg from the option tick (greeks/iv fields).
  function pdLiveLegIv(row) {
    if (!pdLiveContext || !row) return null;
    const refId = liveRefId(row);
    const tick = refId ? pdLiveContext.optionByRef.get(refId) : null;
    return liveIv(tick) ?? liveIv(row);
  }

  function schedulePdLiveUpdate(receivedAtMs) {
    if (!isMarketHours(rollExchange())) { stopPdLive(); setPdStatus("Market closed"); return; }
    pdThrottlePending = receivedAtMs || Date.now();
    if (!pdThrottleTimer) {
      pdThrottleTimer = setTimeout(() => {
        pdThrottleTimer = null;
        const ts = pdThrottlePending;
        pdThrottlePending = null;
        updatePdLiveSnapshot(ts);
      }, 500);
    }
  }

  function updatePdLiveSnapshot(receivedAtMs = Date.now()) {
    if (!pdLiveContext || !pdLineData || !pdMeta) return;
    const { optionByRef, spot, openLtp, lastGoodLtp, lastPct, legRows } = pdLiveContext;
    if (!spot || spot <= 0) return;
    const liveGood = (row, key) => {
      const ltp = pdLiveLegLtp(optionByRef.get(row.refId) || row);
      if (ltp != null && ltp > 0) { lastGoodLtp.set(key, ltp); return ltp; }
      return lastGoodLtp.has(key) ? lastGoodLtp.get(key) : null;
    };
    const guardPct = (key, p) => {
      const prev = lastPct[key];
      if (p == null) return prev ?? null;
      if (prev != null && Math.abs(p - prev) > 80) return prev;
      lastPct[key] = p;
      return p;
    };
    const time = tvTime(receivedAtMs);
    pdLineData.times.push(time);
    pdLineData.spot.push(spot);
    const summary = {};
    // recent-window lookback in points (live ticks ~ every 0.5s → ~20 min)
    const lookback = 1200;
    for (const leg of pdLegs) {
      const row = legRows?.get(leg.key);
      const ltp = row ? liveGood(row, leg.key) : null;
      // seed open from first live price if there was no historical open
      if (ltp != null && !openLtp.has(leg.key)) openLtp.set(leg.key, ltp);
      const open = openLtp.get(leg.key);
      const pRaw = (ltp != null && open > 0) ? ((ltp - open) / open) * 100 : null;
      const p = guardPct(leg.key, pRaw);
      pdLineData.pct[leg.key].push(p);
      const meta = pdMeta[leg.key];
      meta.ltp.push(ltp);
      meta.iv.push(row ? pdLiveLegIv(row) : null);
      // decay state from slope over the recent window
      const arr = pdLineData.pct[leg.key];
      const j = Math.max(0, arr.length - 1 - lookback);
      const a = arr[j]; const b = arr[arr.length - 1];
      let state = null;
      if (a != null && b != null) { const slope = b - a; state = slope > 3 ? 2 : slope > -3 ? 1 : 0; }
      meta.state.push(state);
      summary[leg.key] = { pct: p, ltp, iv: meta.iv[meta.iv.length - 1], state };
    }
    pdRenderLines();
    setPdCells({ summary, hasData: true });
    setPdStatus("Live tick");
  }

  function startPdLive() {
    if (pdCutoffTimer) { clearTimeout(pdCutoffTimer); pdCutoffTimer = null; }
    if (pdLiveSocket) { pdLiveSocket.close(); pdLiveSocket = null; }
    const exch = rollExchange();
    if (!isMarketHours(exch)) { setPdStatus("Market closed"); return; }
    const cutoffMs = msUntilMarketClose(exch);
    if (cutoffMs > 0) pdCutoffTimer = setTimeout(() => { stopPdLive(); setPdStatus("Market closed"); }, cutoffMs);
    const expiry = rollExpiry();
    if (!expiry) { setPdStatus("Select expiry first"); return; }
    if (!token().trim() || !deviceId().trim()) { setPdStatus("Session needed"); return; }
    if (!pdLiveContext?.refIds?.length) { setPdStatus("Plot first"); return; }
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws/live`);
    pdLiveSocket = ws;
    setPdStatus("Live starting");
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "subscribe",
        environment: environment().includes("uat") ? "uat" : "prod",
        token: token().replace("Bearer ", "").trim(),
        deviceId: deviceId().trim(),
        symbol: rollSymbol().trim().toUpperCase(),
        spotSymbol: pdLiveContext.spotSymbol || rollSymbol().trim().toUpperCase(),
        exchange: rollExchange(),
        interval: "1m",
        expiry,
        refIds: pdLiveContext.refIds
      }));
      setPdLiveOn(true);
      setPdStatus(`Live · ${pdLiveContext.refIds.length} legs`);
    };
    ws.onmessage = (e) => {
      if (!isMarketHours(rollExchange())) { stopPdLive(); setPdStatus("Market closed"); return; }
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.event === "option" && msg.data) handlePdLiveChain(msg.data, msg.received_at_ms);
      if (msg.event === "orderbook" && msg.data) handlePdLiveOrderbook(msg.data, msg.received_at_ms);
      if (msg.event === "error") setPdStatus(msg.message || "Live error");
    };
    ws.onclose = () => {
      if (pdLiveSocket !== ws) return;
      pdLiveSocket = null;
      setPdLiveOn(false);
      setPdStatus("Live stopped");
    };
    ws.onerror = () => setPdStatus("WS error");
  }

  function stopPdLive() {
    if (pdCutoffTimer) { clearTimeout(pdCutoffTimer); pdCutoffTimer = null; }
    if (pdThrottleTimer) { clearTimeout(pdThrottleTimer); pdThrottleTimer = null; pdThrottlePending = null; }
    if (pdLiveSocket) {
      try { pdLiveSocket.send(JSON.stringify({ type: "stop" })); } catch {}
      pdLiveSocket.close();
      pdLiveSocket = null;
    }
    setPdLiveOn(false);
    setPdStatus("Idle");
  }

  // ═══════════════════════════════════════════════════════════════
  // Vega Analysis — per-leg vega vs 9:15 open
  //
  // Each plotted line is ONE option leg ({strike, side}): its vega as % of its
  // own 9:15 open vega. Above 0 = vega BUILT (the strike got more vol-sensitive /
  // vol expanded toward it), below 0 = vega BLED. Mirrors Premium Decay's layout
  // and strike-selection model; only the tracked metric differs (vega, not LTP).
  // Series layout: [x, leg0, leg1, …, spot].
  // ═══════════════════════════════════════════════════════════════
  const VG_CE_COLORS = ["#10B981", "#10B981", "#10B981", "#10B981", "#10B981", "#10B981", "#10B981", "#10B981"];
  const VG_PE_COLORS = ["#EF4444", "#EF4444", "#EF4444", "#EF4444", "#EF4444", "#EF4444", "#EF4444", "#EF4444"];
  const vgLegKey = (leg) => `${leg.strike}|${leg.side}`;
  const vgLegColor = (leg, ceIdx, peIdx) =>
    leg.side === "CE" ? VG_CE_COLORS[ceIdx % VG_CE_COLORS.length] : VG_PE_COLORS[peIdx % VG_PE_COLORS.length];
  const vgSpotIndex = () => 1 + vgLegs.length;

  const vgSelectedLegs = createMemo(() => {
    const { strikes, step, atm } = vgChainRows();
    const mode = vgPickMode();
    if (mode === "custom") {
      return vgCustomLegs()
        .filter((l) => Number.isFinite(l?.strike) && (l.side === "CE" || l.side === "PE"))
        .map((l) => ({ strike: Number(l.strike), side: l.side }));
    }
    if (!strikes.length || !step) return [];
    const legs = [];
    const addPair = (strike) => {
      if (!Number.isFinite(strike)) return;
      legs.push({ strike, side: "CE" });
      legs.push({ strike, side: "PE" });
    };
    if (mode === "fixed") {
      const center = Number(vgFixedCenter());
      const base = Number.isFinite(center) && center > 0 ? nearestStrike(center, strikes, step) : atm;
      if (base == null) return [];
      const n = Math.max(0, Math.round(vgFixedRange()));
      for (let i = -n; i <= n; i++) addPair(nearestStrike(base + i * step, strikes, step));
    } else {
      if (atm == null) return [];
      const n = Math.max(0, Math.round(vgAtmRange()));
      for (let i = -n; i <= n; i++) addPair(nearestStrike(atm + i * step, strikes, step));
    }
    const seen = new Set();
    return legs.filter((l) => { const k = vgLegKey(l); if (seen.has(k)) return false; seen.add(k); return true; });
  });

  const vgLegendLegs = createMemo(() => {
    const summary = vgCells()?.summary || {};
    let ceI = 0, peI = 0;
    return vgSelectedLegs().map((leg) => {
      const key = vgLegKey(leg);
      const color = vgLegColor(leg, leg.side === "CE" ? ceI++ : ceI, leg.side === "PE" ? peI++ : peI);
      return { strike: leg.strike, side: leg.side, key, color, ...(summary[key] || {}) };
    });
  });

  async function loadVgChainRows() {
    const sym = rollSymbol().trim().toUpperCase();
    if (!sym) throw new Error("Pick a symbol first.");
    setVgStatus("Chain");
    let rows = await rollingOptionRows();
    let expiries = [...new Set(rows.map((r) => r.expiry))].sort();
    if (!expiries.length) throw new Error(`No option expiries for ${sym}.`);
    if (!rollExpiry() || !expiries.includes(rollExpiry())) {
      setRollExpiries(expiries);
      setRollExpiry(expiries[0] || "");
    }
    rows = rows.filter((r) => r.expiry === rollExpiry());
    const strikes = [...new Set(rows.map((r) => r.strike))].sort((a, b) => a - b);
    if (!strikes.length) throw new Error("No strikes for selected expiry.");
    const step = inferStrikeStep(strikes);
    let atm = vgLiveContext?.spot ? nearestStrike(vgLiveContext.spot, strikes, step) : null;
    if (atm == null) {
      try {
        const exch = rollExchange();
        const priceSym = exch === "MCX" ? mcxMarketSymbol(sym, rollExpiry()) : sym;
        const suffix = exch !== "NSE" ? `?exchange=${encodeURIComponent(exch)}` : "";
        const data = await nubraFetch(`optionchains/${encodeURIComponent(priceSym)}/price${suffix}`);
        const px = toRupees(data.price);
        if (Number.isFinite(px) && px > 0) atm = nearestStrike(px, strikes, step);
      } catch {}
    }
    if (atm == null) atm = strikes[Math.floor(strikes.length / 2)];
    setVgChainRows({ strikes, step, atm });
    if (!vgFixedCenter()) setVgFixedCenter(String(atm));
    setVgStatus(`${strikes.length} strikes · ATM ${atm}`);
    return { strikes, step, atm };
  }

  function vgToggleCustomLeg(strike, side) {
    const key = `${strike}|${side}`;
    setVgCustomLegs((legs) => {
      const exists = legs.some((l) => `${l.strike}|${l.side}` === key);
      const next = exists ? legs.filter((l) => `${l.strike}|${l.side}` !== key)
                          : [...legs, { strike: Number(strike), side }];
      localStorage.setItem("nubraVgCustomLegs", JSON.stringify(next));
      return next;
    });
  }
  function vgRemoveCustomLeg(strike, side) {
    setVgCustomLegs((legs) => {
      const next = legs.filter((l) => `${l.strike}|${l.side}` !== `${strike}|${side}`);
      localStorage.setItem("nubraVgCustomLegs", JSON.stringify(next));
      return next;
    });
  }
  function vgClearCustomLegs() { setVgCustomLegs([]); localStorage.setItem("nubraVgCustomLegs", "[]"); }
  // Add every visible strike as legs. side: "both" | "CE" | "PE".
  function vgSelectAllCustom(side = "both") {
    const { strikes } = vgChainRows();
    if (!strikes?.length) return;
    const wantCE = side === "both" || side === "CE";
    const wantPE = side === "both" || side === "PE";
    const next = [];
    for (const strike of strikes) {
      if (wantCE) next.push({ strike: Number(strike), side: "CE" });
      if (wantPE) next.push({ strike: Number(strike), side: "PE" });
    }
    setVgCustomLegs(next);
    localStorage.setItem("nubraVgCustomLegs", JSON.stringify(next));
  }
  function setVgPickModeP(mode) { setVgPickMode(mode); localStorage.setItem("nubraVgMode", mode); }
  function setVgAtmRangeP(n) { setVgAtmRange(n); localStorage.setItem("nubraVgAtmRange", String(n)); }
  function setVgFixedRangeP(n) { setVgFixedRange(n); localStorage.setItem("nubraVgFixedRange", String(n)); }
  function setVgFixedCenterP(v) { setVgFixedCenter(v); }
  function setVgDeltaMinP(n) { const v = Math.max(0, Math.min(1, Number(n) || 0)); setVgDeltaMin(v); localStorage.setItem("nubraVgDeltaMin", String(v)); }
  function setVgDeltaMaxP(n) { const v = Math.max(0, Math.min(1, Number(n) || 0)); setVgDeltaMax(v); localStorage.setItem("nubraVgDeltaMax", String(v)); }

  // ── Vega chart ──
  function vgRememberScale(key, range) {
    if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.max <= range.min) return;
    vgManualScales = { ...vgManualScales, [key]: { min: range.min, max: range.max } };
    if (key === "x") syncRollXFromIndicator("vega", range);
  }
  function vgClearScales(keys = ["x", "vega", "spot"]) { for (const k of keys) vgManualScales[k] = null; }
  function vgApplyScales() {
    if (!vgChart) return;
    for (const key of ["x", "vega", "spot"]) {
      const saved = vgManualScales[key];
      if (saved && scaleRangeChanged(vgChart.scales[key], saved)) vgChart.setScale(key, saved);
    }
  }
  function vgFitWindow() {
    if (!vgChart || !vgChartData?.[0]?.length) return;
    const x = vgChartData[0];
    const pad = Math.max(30, (x[x.length - 1] - x[0]) * 0.02);
    vgChart.setScale("x", { min: x[0] - pad, max: x[x.length - 1] + pad });
  }
  function vgVegaRange(_u, dataMin, dataMax) {
    if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) return [-1, 1];
    const mag = Math.max(Math.abs(dataMin), Math.abs(dataMax), 1);
    const pad = mag * 0.1;
    return [-(mag + pad), mag + pad];
  }
  // Fixed three-line model: ΔCall vega (green), ΔPut vega (red), Put−Call diff
  // (grey dotted). Visibility keyed by "call"/"put"/"diff" in vgLegVisibility.
  const VG_SERIES = [
    { key: "call", label: "Call Vega", stroke: "#10B981", dash: undefined },
    { key: "put", label: "Put Vega", stroke: "#EF4444", dash: undefined },
    { key: "diff", label: "Put−Call Diff", stroke: "#9aa1aa", dash: [4, 3] },
  ];
  function vgIsKeyVisible(key) {
    const v = vgLegVisibility()[key];
    return key === "diff" ? v === true : v !== false; // diff off by default
  }
  function vgBuildSeries() {
    const series = [{}];
    for (const s of VG_SERIES) {
      series.push({ label: s.label, scale: "vega", stroke: s.stroke, width: 1.7, dash: s.dash, show: vgIsKeyVisible(s.key), points: { show: false } });
    }
    series.push({ label: "Spot", scale: "spot", stroke: "#60a5fa", width: 1, dash: [2, 3], show: vgSpotVisible(), points: { show: false } });
    return series;
  }
  const VG_SPOT_IDX = 1 + VG_SERIES.length; // 4
  function initVgChart() {
    if (vgChart || !vgChartHost || typeof uPlot === "undefined") return;
    const rect = vgChartHost.getBoundingClientRect();
    if (!vgChartData) vgChartData = [[], [], [], [], []];
    const axisFont = "11px monospace";
    vgChart = new uPlot({
      width: Math.max(1, Math.floor(rect.width)),
      height: Math.max(220, Math.floor(rect.height)),
      pxAlign: true,
      legend: { show: false },
      cursor: { drag: { x: false, y: false }, points: { show: false }, focus: { prox: 24 }, x: true, y: true },
      scales: {
        x: { time: true },
        vega: { auto: true, range: vgVegaRange },
        spot: { auto: true, range: paddedRollRange }
      },
      axes: [
        {
          show: true, size: 40, gap: 6, font: axisFont, stroke: "#c9cdd3",
          border: { show: true, stroke: "rgba(255,255,255,0.24)", width: 1 },
          grid: { show: true, stroke: "rgba(68,80,94,0.35)", width: 1 },
          ticks: { show: true, stroke: "rgba(255,255,255,0.18)", width: 1, size: 5 },
          values: (_u, vals) => vals.map((v) => formatIstTime(v)),
          space: 80
        },
        {
          show: true, scale: "vega", side: 3, size: 56, gap: 8, font: axisFont, stroke: "#c9cdd3",
          border: { show: true, stroke: "rgba(255,255,255,0.24)", width: 1 },
          grid: { show: true, stroke: "rgba(68,80,94,0.35)", width: 1 },
          ticks: { show: true, stroke: "rgba(255,255,255,0.18)", width: 1, size: 5 },
          values: (_u, vals) => vals.map((v) => `${v > 0 ? "+" : ""}${Number(v).toFixed(0)}`),
          space: 36
        },
        {
          show: true, scale: "spot", side: 1, size: 64, gap: 8, font: axisFont, stroke: "#9aa1aa",
          border: { show: true, stroke: "rgba(255,255,255,0.24)", width: 1 },
          grid: { show: false },
          ticks: { show: true, stroke: "rgba(255,255,255,0.18)", width: 1, size: 5 },
          values: (_u, vals) => vals.map((v) => Number(v).toFixed(0)),
          space: 40
        }
      ],
      series: vgBuildSeries(),
      plugins: [createVgZeroLinePlugin(), createVgInteractionPlugin(), createVgTooltipPlugin()]
    }, vgChartData, vgChartHost);
    queueChartResize();
  }
  function createVgZeroLinePlugin() {
    return {
      hooks: {
        draw: [(u) => {
          const scale = u.scales.vega;
          if (!scale || !Number.isFinite(scale.min) || !Number.isFinite(scale.max)) return;
          if (scale.min > 0 || scale.max < 0) return;
          const y = Math.round(u.valToPos(0, "vega", true));
          const ctx = u.ctx;
          ctx.save();
          ctx.beginPath();
          ctx.strokeStyle = "rgba(255,255,255,0.42)";
          ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
          ctx.moveTo(u.bbox.left, y);
          ctx.lineTo(u.bbox.left + u.bbox.width, y);
          ctx.stroke(); ctx.restore();
        }]
      }
    };
  }
  function createVgInteractionPlugin() {
    let over;
    let destroy = () => {};
    const xBounds = () => {
      const x = vgChartData?.[0] || [];
      const pad = Math.max(30, (x[x.length - 1] - x[0]) * 0.02);
      return { min: x[0] - pad, max: x[x.length - 1] + pad };
    };
    const hasData = () => (vgChartData?.[0]?.length || 0) > 0;
    const zoomAxis = (u, key, pct, factor, hardMin, hardMax, minSpan) => {
      const scale = u.scales[key];
      if (!scale || !Number.isFinite(scale.min) || !Number.isFinite(scale.max)) return;
      const span = scale.max - scale.min;
      const anchor = scale.min + span * pct;
      const nextSpan = span * factor;
      const range = clampRange(anchor - nextSpan * pct, anchor + nextSpan * (1 - pct), hardMin, hardMax, minSpan);
      vgRememberScale(key, range);
      u.setScale(key, range);
    };
    return {
      hooks: {
        ready: [(u) => {
          over = u.over;
          let dragStart = null;
          const wheel = (event) => {
            if (!hasData()) return;
            event.preventDefault();
            const rect = over.getBoundingClientRect();
            const xPct = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
            const yPct = Math.min(1, Math.max(0, 1 - ((event.clientY - rect.top) / rect.height)));
            const { min: xMin, max: xMax } = xBounds();
            const factor = event.deltaY < 0 ? 0.82 : 1.22;
            const zoomY = event.shiftKey || event.altKey || event.ctrlKey || event.metaKey;
            const zoomX = !event.shiftKey || event.ctrlKey || event.metaKey;
            if (zoomX) zoomAxis(u, "x", xPct, factor, xMin, xMax, 10);
            if (zoomY) { zoomAxis(u, "vega", yPct, factor, -Infinity, Infinity, 0.5); zoomAxis(u, "spot", yPct, factor, -Infinity, Infinity, 0.5); }
          };
          const pointerDown = (event) => {
            if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
            dragStart = { x: event.clientX, y: event.clientY, xMin: u.scales.x.min, xMax: u.scales.x.max,
              vegaMin: u.scales.vega?.min, vegaMax: u.scales.vega?.max, spotMin: u.scales.spot?.min, spotMax: u.scales.spot?.max };
            over.setPointerCapture?.(event.pointerId);
          };
          const pointerMove = (event) => {
            if (!dragStart || !hasData()) return;
            event.preventDefault();
            const rect = over.getBoundingClientRect();
            const dx = event.clientX - dragStart.x;
            const dy = event.clientY - dragStart.y;
            const { min: xHardMin, max: xHardMax } = xBounds();
            const xSpan = dragStart.xMax - dragStart.xMin;
            const xShift = -(dx / Math.max(1, rect.width)) * xSpan;
            const xRange = clampRange(dragStart.xMin + xShift, dragStart.xMax + xShift, xHardMin, xHardMax, xSpan);
            vgRememberScale("x", xRange); u.setScale("x", xRange);
            const panY = (key, min, max) => {
              if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return;
              const span = max - min;
              const shift = (dy / Math.max(1, rect.height)) * span;
              const range = clampRange(min + shift, max + shift, -Infinity, Infinity, span);
              vgRememberScale(key, range); u.setScale(key, range);
            };
            panY("vega", dragStart.vegaMin, dragStart.vegaMax);
            panY("spot", dragStart.spotMin, dragStart.spotMax);
          };
          const pointerUp = (event) => { dragStart = null; over.releasePointerCapture?.(event.pointerId); };
          const doubleClick = () => {
            vgClearScales();
            u.setScale("vega", { min: null, max: null });
            u.setScale("spot", { min: null, max: null });
            vgFitWindow();
          };
          over.addEventListener("wheel", wheel, { passive: false });
          over.addEventListener("pointerdown", pointerDown);
          over.addEventListener("pointermove", pointerMove);
          over.addEventListener("pointerup", pointerUp);
          over.addEventListener("pointercancel", pointerUp);
          over.addEventListener("dblclick", doubleClick);
          destroy = () => {
            over.removeEventListener("wheel", wheel);
            over.removeEventListener("pointerdown", pointerDown);
            over.removeEventListener("pointermove", pointerMove);
            over.removeEventListener("pointerup", pointerUp);
            over.removeEventListener("pointercancel", pointerUp);
            over.removeEventListener("dblclick", doubleClick);
          };
        }],
        setData: [(u) => {
          for (const key of ["x", "vega", "spot"]) {
            const saved = vgManualScales[key];
            if (saved && scaleRangeChanged(u.scales[key], saved)) {
              requestAnimationFrame(() => {
                const latest = vgManualScales[key];
                if (latest && scaleRangeChanged(u.scales[key], latest)) u.setScale(key, latest);
              });
            }
          }
        }],
        destroy: [() => destroy()]
      }
    };
  }
  function createVgTooltipPlugin() {
    let tooltip;
    return {
      hooks: {
        init: [(u) => { tooltip = document.createElement("div"); tooltip.className = "roll-chart-tooltip"; tooltip.hidden = true; u.over.appendChild(tooltip); }],
        setCursor: [(u) => {
          if (!tooltip || !vgChartData) return;
          const idx = u.cursor.idx;
          if (idx == null || idx < 0 || !vgChartData[0]?.length) { tooltip.hidden = true; return; }
          const time = vgChartData[0][idx];
          if (!Number.isFinite(time)) { tooltip.hidden = true; return; }
          const sgn = (v) => (v > 0 ? "+" : "") + Number(v).toFixed(2);
          const parts = [`<span class="roll-tip-time">${formatIstTime(time)}</span>`];
          VG_SERIES.forEach((s, i) => {
            const v = vgChartData[1 + i]?.[idx];
            if (!vgIsKeyVisible(s.key) || !Number.isFinite(v)) return;
            const arrow = s.key !== "diff" ? (v > 0 ? " ▲" : v < 0 ? " ▼" : "") : "";
            parts.push(`<span style="color:${s.stroke}">${s.label}: ${sgn(v)}${arrow}</span>`);
          });
          // Raw totals for context.
          const ct = vgMeta?.callTot?.[idx]; const ptt = vgMeta?.putTot?.[idx];
          if (Number.isFinite(ct) || Number.isFinite(ptt)) {
            parts.push(`<span style="color:#9aa1aa">Tot CE ${Number.isFinite(ct) ? ct.toFixed(1) : "—"} · PE ${Number.isFinite(ptt) ? ptt.toFixed(1) : "—"}</span>`);
          }
          const spot = vgChartData[VG_SPOT_IDX]?.[idx];
          if (vgSpotVisible() && Number.isFinite(spot)) parts.push(`<span style="color:#60a5fa">Spot: ${number.format(spot)}</span>`);
          tooltip.innerHTML = parts.join("");
          tooltip.hidden = false;
          const left = Math.min(u.over.clientWidth - tooltip.offsetWidth - 12, Math.max(8, u.cursor.left + 14));
          const top = Math.max(8, Math.min(u.over.clientHeight - tooltip.offsetHeight - 12, u.cursor.top - 20));
          tooltip.style.left = `${left}px`; tooltip.style.top = `${top}px`;
        }]
      }
    };
  }
  function vgRenderLines() {
    if (!vgLineData) return;
    const x = vgLineData.times;
    vgChartData = [x, vgLineData.call, vgLineData.put, vgLineData.diff, vgLineData.spot];
    initVgChart();
    if (!vgChart) return;
    vgChart.setData(vgChartData);
    if (vgChartHost) resizeChart(vgChart, vgChartHost);
    if (vgManualScales.x) vgApplyScales();
    else vgFitWindow();
  }
  function registerVgChartHost(el) {
    if (!el) { if (vgChart) { vgChart.destroy(); vgChart = null; } vgChartHost = null; return; }
    vgChartHost = el; initVgChart(); vgRenderLines();
  }
  let rollIndicatorHost = null;
  let rollIndicatorHostType = "none";

  function setRollIndicatorPaneHeight(next) {
    const value = Math.max(180, Math.min(640, Math.round(Number(next) || 280)));
    setRollIndicatorPaneHeightRaw(value);
    localStorage.setItem("nubraRollIndicatorPaneHeight", String(value));
    queueChartResize();
  }

  function rehostRollIndicator(type) {
    if (!rollIndicatorHost || type === "none") return;
    rollIndicatorHostType = type;
    if (type === "premium") {
      if (pdChart) { pdChart.destroy(); pdChart = null; }
      pdChartHost = rollIndicatorHost;
      initPdChart();
      pdRenderLines();
    } else if (type === "vega") {
      if (vgChart) { vgChart.destroy(); vgChart = null; }
      vgChartHost = rollIndicatorHost;
      initVgChart();
      vgRenderLines();
    }
    const range = rollManualScales.x || rollChart?.scales?.x;
    syncRollIndicatorX(range);
    queueChartResize();
  }

  function registerRollIndicatorHost(el, type = rollIndicatorPane()) {
    rollIndicatorHost = el || null;
    if (!el) return;
    rehostRollIndicator(type);
  }

  function closeRollIndicatorPane() {
    setRollIndicatorMenuOpen(false);
    if (rollIndicatorHostType === "premium" && pdChartHost === rollIndicatorHost && pdChart) {
      pdChart.destroy();
      pdChart = null;
      pdChartHost = null;
    }
    if (rollIndicatorHostType === "vega" && vgChartHost === rollIndicatorHost && vgChart) {
      vgChart.destroy();
      vgChart = null;
      vgChartHost = null;
    }
    rollIndicatorHostType = "none";
    setRollIndicatorPane("none");
    rebuildRollChart();
    queueChartResize();
  }

  async function openRollIndicatorPane(type) {
    setRollIndicatorMenuOpen(false);
    setRollIndicatorPane(type);
    rebuildRollChart();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    rehostRollIndicator(type);
    if (type === "premium") await loadPremiumDecay();
    else if (type === "vega") await loadVegaAnalysis();
    rehostRollIndicator(type);
  }

  function toggleVgLeg(key) {
    const next = !vgIsKeyVisible(key); // flip current effective visibility
    setVgLegVisibility((v) => ({ ...v, [key]: next }));
    localStorage.setItem("nubraVgLegVis", JSON.stringify(vgLegVisibility()));
    vgApplyVisibility();
  }
  function toggleVgSpot() {
    setVgSpotVisible((v) => !v);
    localStorage.setItem("nubraVgSpot", vgSpotVisible() ? "1" : "0");
    vgApplyVisibility();
  }
  function vgApplyVisibility() {
    if (!vgChart) return;
    VG_SERIES.forEach((s, i) => vgChart.setSeries(1 + i, { show: vgIsKeyVisible(s.key) }));
    vgChart.setSeries(VG_SPOT_IDX, { show: vgSpotVisible() });
    vgChart.redraw();
  }

  // Forward-only vega walk for a leg (cursor per option name).
  function legVega(name, seriesByName, cursorByName, ts) {
    const keyName = String(name || "").toUpperCase();
    const arr = seriesByName.get(keyName)?.vega;
    if (!arr?.length) return null;
    const cursor = cursorByName.get(keyName) || { i: 0, v: null };
    while (cursor.i < arr.length && arr[cursor.i].ts <= ts) { cursor.v = arr[cursor.i].v; cursor.i += 1; }
    cursorByName.set(keyName, cursor);
    return cursor.v != null ? cursor.v : null;
  }
  // Forward-only signed delta walk, normalized to roughly -1..1.
  function legDelta(name, seriesByName, cursorByName, ts) {
    const keyName = String(name || "").toUpperCase();
    const arr = seriesByName.get(keyName)?.delta;
    if (!arr?.length) return null;
    const cursor = cursorByName.get(keyName) || { i: 0, v: null };
    while (cursor.i < arr.length && arr[cursor.i].ts <= ts) { cursor.v = arr[cursor.i].v; cursor.i += 1; }
    cursorByName.set(keyName, cursor);
    if (cursor.v == null) return null;
    const d = Number(cursor.v);
    if (!Number.isFinite(d)) return null;
    return Math.abs(d) > 1 ? d / 100 : d; // some feeds send delta x 100
  }

  // Fetch per-leg vega (+ iv_mid) series for the historical window.
  async function fetchVegaSeries(names, start, end, aliasToCanonical, intervalValue) {
    const seriesByName = new Map();
    // Load in fixed batches of 8 symbols, paced under the historical rate limit,
    // with a running "batch i/N" status so the user sees progress.
    const BATCH = 8;
    const total = Math.ceil(names.length / BATCH);
    for (let i = 0, b = 0; i < names.length; i += BATCH, b += 1) {
      const batch = names.slice(i, i + BATCH);
      setVgStatus(`Vega+Δ · batch ${b + 1}/${total}`);
      try {
        const { data } = await fetchTimeseriesWithIntervals({
          exchange: rollExchange(), type: "OPT", values: batch,
          fields: ["vega", "delta", "iv_mid", "close"], startDate: start, endDate: end, intraDay: false, realTime: false
        }, [intervalValue]);
        const values = data?.result?.[0]?.values || [];
        for (const entry of values) {
          for (const [name, sd] of Object.entries(entry)) {
            const keyName = String(name || "").toUpperCase();
            const canonical = aliasToCanonical.get(keyName) || keyName;
            const parse = (a, rupee = false) => (Array.isArray(a) ? a : [])
              .map((p) => ({ ts: pointMs(p), v: pointNumber(p, rupee) }))
              .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.v))
              .sort((a, b) => a.ts - b.ts);
            // Keep raw delta; the Vega opening basket normalizes sign by side.
            const series = { vega: parse(sd?.vega), delta: parse(sd?.delta), ivMid: parse(sd?.iv_mid) };
            // Keep if either greek came back (a leg may have delta but sparse vega).
            if (series.vega.length || series.delta.length) {
              if (!seriesByName.has(canonical)) seriesByName.set(canonical, series);
              if (!seriesByName.has(keyName)) seriesByName.set(keyName, series);
            }
          }
        }
      } catch { /* skip a failed batch; partial data is still useful */ }
      // Pace batches (~250ms) to respect the 60 req/min historical limit.
      await new Promise((r) => setTimeout(r, 250));
    }
    return seriesByName;
  }

  async function loadVegaAnalysis() {
    initVgChart();
    const start = fromLocalInput(rollStart());
    const end = fromLocalInput(rollEnd());
    if (!start || !end) throw new Error("Start and end are required.");
    const sym = rollSymbol().trim().toUpperCase();
    setVgStatus("Spot"); setVgCells({});

    const spotSym = rollExchange() === "MCX" ? await resolveMcxMarketSymbol(sym, rollExpiry()) : sym;
    const spotType = rollExchange() === "MCX" && spotSym.startsWith("FUT_") ? "FUT" : rollType();
    if (rollExchange() === "MCX" && !spotSym.startsWith("FUT_")) throw new Error(`MCX future symbol not found for ${sym}.`);

    let resolvedInterval = ROLLING_INTERVALS[0];
    let spotPoints = [];
    let spotError = null;
    for (const intervalValue of ROLLING_INTERVALS) {
      try {
        const { data: spotData } = await fetchTimeseriesWithIntervals({
          exchange: rollExchange(), type: spotType, values: [spotSym], fields: ["close"],
          startDate: start, endDate: end, intraDay: false, realTime: false
        }, [intervalValue]);
        const sd = extractSymbolData(spotData, spotSym);
        spotPoints = (Array.isArray(sd?.close) ? sd.close : [])
          .map((p) => ({ ts: pointMs(p), spot: pointNumber(p, true) }))
          .filter((p) => Number.isFinite(p.ts) && p.spot > 0)
          .sort((a, b) => a.ts - b.ts);
        if (spotPoints.length) { resolvedInterval = intervalValue; break; }
      } catch (error) { spotError = error; }
    }
    if (!spotPoints.length) throw new Error(spotError?.message || `No spot data for ${spotSym}.`);

    setVgStatus("Refdata");
    let rows = await rollingOptionRows();
    let expiries = [...new Set(rows.map((r) => r.expiry))].sort();
    if (!expiries.length) throw new Error(`No option expiries for ${sym}.`);
    if (!rollExpiry() || !expiries.includes(rollExpiry())) {
      setRollExpiries(expiries); setRollExpiry(expiries[0] || ""); rows = await rollingOptionRows();
    }
    rows = rows.filter((r) => r.expiry === rollExpiry());
    if (!rows.length) throw new Error("No option rows for selected expiry.");

    const strikes = [...new Set(rows.map((r) => r.strike))].sort((a, b) => a - b);
    const step = inferStrikeStep(strikes);
    const rowByKey = new Map(rows.map((r) => [`${r.strike}|${r.side}`, r]));

    const lastSpot = spotPoints[spotPoints.length - 1]?.spot;
    const atmNow = lastSpot ? nearestStrike(lastSpot, strikes, step) : strikes[Math.floor(strikes.length / 2)];
    setVgChainRows({ strikes, step, atm: atmNow });

    const dMin = Math.min(vgDeltaMin(), vgDeltaMax());
    const dMax = Math.max(vgDeltaMin(), vgDeltaMax());
    const marketOpen = new Date(start);
    marketOpen.setHours(9, 15, 0, 0);
    const openingPoint = spotPoints.find((point) => point.ts >= marketOpen.getTime()) || spotPoints[0];
    const openingTs = openingPoint.ts;
    const analysisSpotPoints = spotPoints.filter((point) => point.ts >= openingTs);
    const atmPath = analysisSpotPoints
      .map((point) => Number.isFinite(point.spot) ? nearestStrike(point.spot, strikes, step) : null)
      .filter(Number.isFinite);
    const minAtm = atmPath.length ? Math.min(...atmPath) : null;
    const maxAtm = atmPath.length ? Math.max(...atmPath) : null;
    const openingAtm = Number.isFinite(openingPoint.spot)
      ? nearestStrike(openingPoint.spot, strikes, step)
      : atmNow;
    const wingCount = dMin <= 0.05 ? 24 : 16;
    const itmBuffer = 2;
    const candidateRows = rows.filter((r) => {
      if (!Number.isFinite(r.strike) || !step || !Number.isFinite(minAtm) || !Number.isFinite(maxAtm)) return true;
      if (r.side === "CE") return r.strike >= minAtm - itmBuffer * step && r.strike <= maxAtm + wingCount * step;
      if (r.side === "PE") return r.strike <= maxAtm + itmBuffer * step && r.strike >= minAtm - wingCount * step;
      return false;
    });
    const greekRows = candidateRows.length ? candidateRows : rows;

    // Fetch vega + delta for EVERY CE & PE in the expiry — the delta band picks
    // which strikes qualify at each tick, so we need the full chain available.
    const optionNames = [];
    const aliasToCanonical = new Map();
    const liveRefIds = new Set();
    const allLegRows = []; // { name, side, strike, refId }
    const addAliases = (row) => {
      const aliases = row.aliases?.length ? row.aliases : [row.name];
      for (const alias of aliases) {
        const key = String(alias || "").toUpperCase();
        if (!key) continue;
        optionNames.push(key); aliasToCanonical.set(key, row.name);
      }
    };
    for (const r of greekRows) {
      addAliases(r);
      allLegRows.push({ name: r.name, side: r.side, strike: r.strike, refId: r.refId });
      if (r.refId) liveRefIds.add(r.refId);
    }
    if (!optionNames.length) throw new Error("No CE/PE symbols found for this expiry.");

    setVgStatus(`Vega+Δ · ${greekRows.length} ATM-path legs`);
    let seriesByName = await fetchVegaSeries([...new Set(optionNames)], start, end, aliasToCanonical, resolvedInterval);
    if (!seriesByName.size && resolvedInterval !== "1m") {
      const fb = await fetchVegaSeries([...new Set(optionNames)], start, end, aliasToCanonical, "1m");
      if (fb.size) { seriesByName = fb; resolvedInterval = "1m"; }
    }
    if (!seriesByName.size) throw new Error(`No vega/delta series returned for ${sym} ${rollExpiry()}. (Greeks may be unavailable for this window.)`);

    const allCeLegs = allLegRows.filter((l) => l.side === "CE");
    const allPeLegs = allLegRows.filter((l) => l.side === "PE");

    // Cursors carry forward last good vega per option name.
    const vegaCursor = new Map();
    const lastVega = new Map();
    const vegaAt = (name, ts) => {
      let v = legVega(name, seriesByName, vegaCursor, ts);
      if (v == null && lastVega.has(name)) v = lastVega.get(name);
      if (v != null) lastVega.set(name, v);
      return v;
    };

    for (const leg of [...allCeLegs, ...allPeLegs]) vegaAt(leg.name, openingTs);

    const deltaCursor = new Map();
    const inCurrentBand = (leg, ts) => {
      const rawDelta = legDelta(leg.name, seriesByName, deltaCursor, ts);
      if (rawDelta == null) return false;
      const signedDelta = leg.side === "PE" ? -Math.abs(rawDelta) : Math.abs(rawDelta);
      if (leg.side === "CE") return signedDelta >= dMin && signedDelta <= dMax;
      return signedDelta <= -dMin && signedDelta >= -dMax;
    };
    const ceLegs = allCeLegs;
    const peLegs = allPeLegs;
    const callEntryVega = new Map();
    const putEntryVega = new Map();

    // For one side, sum (current vega − own 9:15 open vega) over legs whose |delta|
    // was selected at the opening timestamp. Also returns the raw current total
    // vega of that fixed basket.
    const sideAggregate = (legs, ts, entryVega) => {
      let delta = 0, total = 0, any = false, count = 0;
      for (const leg of legs) {
        if (!inCurrentBand(leg, ts)) {
          entryVega.delete(leg.name);
          continue;
        }
        const v = vegaAt(leg.name, ts);
        if (v == null) continue;
        if (!entryVega.has(leg.name)) entryVega.set(leg.name, v);
        const entry = entryVega.get(leg.name);
        total += v; any = true; count += 1;
        if (entry != null) delta += (v - entry);
      }
      return any ? { delta, total, count } : null;
    };

    const times = [];
    const spotArr = [];
    const callDelta = []; // Σ(CE vega − own open) over CE legs in band
    const putDelta = [];  // Σ(PE vega − own open) over PE legs in band
    const diffArr = [];   // putDelta − callDelta
    const callTot = [];   // raw current total vega of the CE band basket
    const putTot = [];
    const callCnt = [];   // how many strikes qualify each side (band width feedback)
    const putCnt = [];

    for (const point of analysisSpotPoints) {
      const ce = sideAggregate(ceLegs, point.ts, callEntryVega);
      const pe = sideAggregate(peLegs, point.ts, putEntryVega);
      times.push(tvTime(point.ts));
      spotArr.push(point.spot);
      callTot.push(ce ? ce.total : null);
      putTot.push(pe ? pe.total : null);
      callCnt.push(ce ? ce.count : 0);
      putCnt.push(pe ? pe.count : 0);
      const cd = ce ? ce.delta : null;
      const pd = pe ? pe.delta : null;
      callDelta.push(cd);
      putDelta.push(pd);
      diffArr.push((cd != null && pd != null) ? pd - cd : null);
    }
    vgLineData = { times, call: callDelta, put: putDelta, diff: diffArr, spot: spotArr };
    vgMeta = { callTot, putTot, callCnt, putCnt };
    vgRenderLines();

    const lastIdx = times.length - 1;
    setVgCells({
      hasData: times.length > 0,
      band: { min: dMin, max: dMax },
      summary: {
        call: callDelta[lastIdx], put: putDelta[lastIdx], diff: diffArr[lastIdx],
        callTot: callTot[lastIdx], putTot: putTot[lastIdx],
        callCnt: callCnt[lastIdx], putCnt: putCnt[lastIdx]
      },
      // Newest-first rows for the side table (cap to keep the DOM light).
      rows: times.map((t, i) => ({ t, call: callDelta[i], put: putDelta[i], diff: diffArr[i] }))
        .reverse().slice(0, 400)
    });

    vgLiveContext = {
      strikes, step, rowByKey,
      ceLegs, peLegs,                 // full per-side leg lists (name/side/strike/refId)
      dMin, dMax,
      callEntryVega,
      putEntryVega,
      optionByRef: new Map(),
      refIds: [...liveRefIds],
      spotSymbol: spotSym, spot: lastSpot,
      lastVega: new Map()
    };
    setVgStatus(`Ready · ${resolvedInterval} · rolling Δ ${dMin}-${dMax} · ${greekRows.length} legs`);
    if (!vgLiveSocket) startVgLive();
  }

  // ── Vega live ──
  function handleVgLiveChain(chain, receivedAtMs) {
    if (!vgLiveContext || !chain) return;
    const spot = toRupees(chain.current_price);
    if (spot && spot > 0) vgLiveContext.spot = spot;
    const save = (option, side) => {
      const refId = liveRefId(option);
      if (!refId) return;
      const prev = vgLiveContext.optionByRef.get(refId) || {};
      vgLiveContext.optionByRef.set(refId, { ...prev, ...option, side, refId });
    };
    for (const o of Array.isArray(chain.ce) ? chain.ce : []) save(o, "CE");
    for (const o of Array.isArray(chain.pe) ? chain.pe : []) save(o, "PE");
    scheduleVgLiveUpdate(receivedAtMs);
  }
  // Live vega for a leg (by its refId tick), carry-forward last good.
  function vgLiveLegVega(leg) {
    if (!vgLiveContext || !leg) return null;
    const tick = leg.refId ? vgLiveContext.optionByRef.get(leg.refId) : null;
    const v = pickOptionValue(tick, ["vega", "vega_value", "vegaValue"]);
    return Number.isFinite(v) ? v : null;
  }
  // Live |delta| (0..1) for a leg.
  function vgLiveLegDelta(leg) {
    if (!vgLiveContext || !leg) return null;
    const tick = leg.refId ? vgLiveContext.optionByRef.get(leg.refId) : null;
    const raw = pickOptionValue(tick, ["delta", "delta_value", "deltaValue"]);
    if (!Number.isFinite(raw)) return null;
    const d = Math.abs(raw);
    return d > 1 ? d / 100 : d;
  }
  function scheduleVgLiveUpdate(receivedAtMs) {
    if (!isMarketHours(rollExchange())) { stopVgLive(); setVgStatus("Market closed"); return; }
    vgThrottlePending = receivedAtMs || Date.now();
    if (!vgThrottleTimer) {
      vgThrottleTimer = setTimeout(() => {
        vgThrottleTimer = null;
        const ts = vgThrottlePending; vgThrottlePending = null;
        updateVgLiveSnapshot(ts);
      }, 500);
    }
  }
  function updateVgLiveSnapshot(receivedAtMs = Date.now()) {
    if (!vgLiveContext || !vgLineData || !vgMeta) return;
    const { spot, lastVega, callEntryVega, putEntryVega, ceLegs, peLegs, dMin, dMax } = vgLiveContext;
    if (!spot || spot <= 0) return;
    // Aggregate one side over the live rolling delta basket.
    // (current vega − each strike's own open vega). Same rolling-basket model.
    const sideAggregate = (legs, entryVega) => {
      let delta = 0, total = 0, any = false, count = 0;
      for (const leg of legs) {
        const d = vgLiveLegDelta(leg);
        if (d == null || d < dMin || d > dMax) {
          entryVega.delete(leg.name);
          continue;
        }
        let v = vgLiveLegVega(leg);
        if (v == null && lastVega.has(leg.name)) v = lastVega.get(leg.name);
        if (v == null) continue;
        lastVega.set(leg.name, v);
        if (!entryVega.has(leg.name)) entryVega.set(leg.name, v);
        const entry = entryVega.get(leg.name);
        total += v; any = true; count += 1;
        if (entry != null) delta += (v - entry);
      }
      return any ? { delta, total, count } : null;
    };
    const ce = sideAggregate(ceLegs, callEntryVega);
    const pe = sideAggregate(peLegs, putEntryVega);
    const cd = ce ? ce.delta : null;
    const pd = pe ? pe.delta : null;
    const diff = (cd != null && pd != null) ? pd - cd : null;

    const time = tvTime(receivedAtMs);
    vgLineData.times.push(time);
    vgLineData.spot.push(spot);
    vgLineData.call.push(cd);
    vgLineData.put.push(pd);
    vgLineData.diff.push(diff);
    vgMeta.callTot.push(ce ? ce.total : null);
    vgMeta.putTot.push(pe ? pe.total : null);
    vgMeta.callCnt.push(ce ? ce.count : 0);
    vgMeta.putCnt.push(pe ? pe.count : 0);
    vgRenderLines();

    const ceTot = ce ? ce.total : null, peTot = pe ? pe.total : null;
    setVgCells((prev) => ({
      hasData: true,
      band: { min: dMin, max: dMax },
      summary: { call: cd, put: pd, diff, callTot: ceTot, putTot: peTot, callCnt: ce ? ce.count : 0, putCnt: pe ? pe.count : 0 },
      rows: [{ t: time, call: cd, put: pd, diff }, ...((prev?.rows) || [])].slice(0, 400)
    }));
    setVgStatus("Live tick");
  }
  function startVgLive() {
    if (vgCutoffTimer) { clearTimeout(vgCutoffTimer); vgCutoffTimer = null; }
    if (vgLiveSocket) { vgLiveSocket.close(); vgLiveSocket = null; }
    const exch = rollExchange();
    if (!isMarketHours(exch)) { setVgStatus("Market closed"); return; }
    const cutoffMs = msUntilMarketClose(exch);
    if (cutoffMs > 0) vgCutoffTimer = setTimeout(() => { stopVgLive(); setVgStatus("Market closed"); }, cutoffMs);
    const expiry = rollExpiry();
    if (!expiry) { setVgStatus("Select expiry first"); return; }
    if (!token().trim() || !deviceId().trim()) { setVgStatus("Session needed"); return; }
    if (!vgLiveContext?.refIds?.length) { setVgStatus("Plot first"); return; }
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws/live`);
    vgLiveSocket = ws;
    setVgStatus("Live starting");
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "subscribe",
        environment: environment().includes("uat") ? "uat" : "prod",
        token: token().replace("Bearer ", "").trim(),
        deviceId: deviceId().trim(),
        symbol: rollSymbol().trim().toUpperCase(),
        spotSymbol: vgLiveContext.spotSymbol || rollSymbol().trim().toUpperCase(),
        exchange: rollExchange(), interval: "1m", expiry, refIds: vgLiveContext.refIds
      }));
      setVgLiveOn(true);
      setVgStatus(`Live · ${vgLiveContext.refIds.length} legs`);
    };
    ws.onmessage = (e) => {
      if (!isMarketHours(rollExchange())) { stopVgLive(); setVgStatus("Market closed"); return; }
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.event === "option" && msg.data) handleVgLiveChain(msg.data, msg.received_at_ms);
      if (msg.event === "error") setVgStatus(msg.message || "Live error");
    };
    ws.onclose = () => { if (vgLiveSocket !== ws) return; vgLiveSocket = null; setVgLiveOn(false); setVgStatus("Live stopped"); };
    ws.onerror = () => setVgStatus("WS error");
  }
  function stopVgLive() {
    if (vgCutoffTimer) { clearTimeout(vgCutoffTimer); vgCutoffTimer = null; }
    if (vgThrottleTimer) { clearTimeout(vgThrottleTimer); vgThrottleTimer = null; vgThrottlePending = null; }
    if (vgLiveSocket) { try { vgLiveSocket.send(JSON.stringify({ type: "stop" })); } catch {} vgLiveSocket.close(); vgLiveSocket = null; }
    setVgLiveOn(false);
    setVgStatus("Idle");
  }

  function downloadCSV() {
    const rows = rollExportBuffer.length ? rollExportBuffer : rollExportData();
    if (!rows.length) return;
    const sym = rollSymbol().trim().toUpperCase();
    const expiry = rollExpiry();
    const exchange = rollExchange();

    // Build IST formatter for timestamp column
    const istFmt = new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false
    });

    const headers = [
      "Timestamp_IST",
      "Unix_ms",
      "Symbol",
      "Expiry",
      "Exchange",
      "Spot",
      "ATM_Strike",
      "Bid_Straddle",
      "Ask_Straddle",
      "Mid_Straddle",
      "IV_Mid_Pct"
    ];

    const escape = (v) => {
      const s = String(v ?? "");
      return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const lines = [headers.join(",")];
    for (const r of rows) {
      const ms = r.ts; // ts is already epoch-milliseconds
      const ist = istFmt.format(new Date(ms)).replace(/(\d+)\/(\d+)\/(\d+),/, "$3-$2-$1");
      lines.push([
        escape(ist),
        escape(ms),
        escape(sym),
        escape(expiry),
        escape(exchange),
        escape(r.spot?.toFixed(2) ?? ""),
        escape(r.strike),
        escape(r.bid?.toFixed(2) ?? ""),
        escape(r.ask?.toFixed(2) ?? ""),
        escape(r.mid?.toFixed(2) ?? ""),
        escape(r.ivMid != null ? r.ivMid.toFixed(4) : "")
      ].join(","));
    }

    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `straddle_${sym}_${expiry}_${exchange}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadParquet() {
    const rows = rollExportBuffer.length ? rollExportBuffer : rollExportData();
    if (!rows.length) return;
    const sym = rollSymbol().trim().toUpperCase();
    const expiry = rollExpiry();
    const exchange = rollExchange();

    const istFmt = new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false
    });

    const out = rows.map(r => {
      const ms = r.ts; // ts is already epoch-milliseconds (from pointMs which divides ns by 1e6)
      const ist = istFmt.format(new Date(ms)).replace(/(\d+)\/(\d+)\/(\d+),/, "$3-$2-$1");
      return {
        Timestamp_IST: ist,
        Unix_ms:       ms,
        Symbol:        sym,
        Expiry:        expiry,
        Exchange:      exchange,
        Spot:          r.spot ?? 0,
        ATM_Strike:    r.strike ?? 0,
        Bid_Straddle:  r.bid ?? 0,
        Ask_Straddle:  r.ask ?? 0,
        Mid_Straddle:  r.mid ?? 0,
        IV_Mid_Pct:    r.ivMid ?? 0
      };
    });

    const buf = writeParquet(null, out);
    const blob = new Blob([buf], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `straddle_${sym}_${expiry}_${exchange}.parquet`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    try {
      setBusy(true);
      setToast("");
      const buf = await file.arrayBuffer();
      let rows;

      if (file.name.endsWith(".parquet")) {
        rows = readParquet(buf);
      } else {
        // CSV import
        const text = new TextDecoder("utf-8").decode(buf).replace(/^﻿/, "");
        const lines = text.split(/\r?\n/).filter(Boolean);
        const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
        rows = lines.slice(1).map(line => {
          const vals = line.match(/(".*?"|[^,]+|(?<=,)(?=,)|^(?=,)|(?<=,)$)/g) || line.split(",");
          const row = {};
          headers.forEach((h, i) => { row[h] = (vals[i] || "").replace(/^"|"$/g, "").trim(); });
          return row;
        });
      }

      if (!rows.length) throw new Error("No data rows found in file.");

      // Reconstruct selected[] from rows and replot
      // r.Unix_ms is already epoch-milliseconds; ts field used internally is nanoseconds
      const selected = rows.map(r => {
        const ms = Number(r.Unix_ms); // epoch milliseconds
        return {
          ts:    ms,                        // keep as ms (same unit as live data)
          tvSec: Math.floor(ms / 1000),     // seconds for LightweightCharts
          spot:  Number(r.Spot),
          strike: Number(r.ATM_Strike),
          bid:   Number(r.Bid_Straddle),
          ask:   Number(r.Ask_Straddle),
          mid:   Number(r.Mid_Straddle),
          ivMid: Number(r.IV_Mid_Pct) || null
        };
      }).filter(r => r.tvSec > 0 && r.spot > 0);

      if (!selected.length) throw new Error("No valid rows after parsing.");

      // Keep imported data visible while the form values are updated.
      setImportMode(true);

      const first = rows[0];
      if (first.Symbol) setRollSymbol(String(first.Symbol));
      if (first.Expiry) setRollExpiry(String(first.Expiry));
      if (first.Exchange) setRollExchange(String(first.Exchange));

      rollExportBuffer = [];
      setRollExportData(selected);

      // Plot without fetching
      initRollChart();
      const bidLine = selected.map(r => ({ time: r.tvSec, value: r.bid }));
      const askLine = selected.map(r => ({ time: r.tvSec, value: r.ask }));
      const ivLine  = selected.filter(r => r.ivMid > 0).map(r => ({ time: r.tvSec, value: r.ivMid }));

      setRollChartLines(bidLine, askLine, ivLine);

      const last = selected[selected.length - 1];
      const lastIv = ivLine.length ? ivLine[ivLine.length - 1].value : null;
      setRollStats({
        spot:   rupee.format(last.spot),
        strike: number.format(last.strike),
        bid:    rupee.format(last.bid),
        ask:    rupee.format(last.ask),
        iv:     lastIv != null ? `${lastIv.toFixed(1)}%` : "--",
        points: String(selected.length),
        meta:   `Imported · ${first.Symbol || ""} ${first.Expiry || ""} · ${selected.length.toLocaleString()} rows`
      });
      setRollStatus("Imported");
    } catch (err) {
      setToast(err.message || "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  onMount(() => {
    initPriceChart();
    initRollChart();
    untrack(() => loadIndexMaster().catch(() => {}));
    const closeChainSearch = (event) => {
      if (chainSearchHost && !chainSearchHost.contains(event.target)) setChainSearchOpen(false);
      if (chainExpiryMenuHost && !chainExpiryMenuHost.contains(event.target)) setChainExpiryMenuOpen(false);
      if (chainNavHost && !chainNavHost.contains(event.target)) setChainNavOpen(false);
      if (labNavHost && !labNavHost.contains(event.target)) setLabNavOpen(false);
      if (controlCenterHost && !controlCenterHost.contains(event.target)) setControlCenterOpen(false);
    };
    document.addEventListener("mousedown", closeChainSearch);
    window.addEventListener("resize", resizeVisibleCharts);
    const appResizeObserver = "ResizeObserver" in window
      ? new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.target === appHeaderHost) setHeaderCompact(entry.contentRect.width < 1540);
        }
        queueChartResize();
      })
      : null;
    if (appHeaderHost) appResizeObserver?.observe(appHeaderHost);
    if (appRootHost) appResizeObserver?.observe(appRootHost);
    const removeWidgetStateListener = widgetMode
      ? desktopApi?.onWidgetMaximizedChanged?.(setWidgetMaximized)
      : null;
    queueChartResize();
    onCleanup(() => {
      document.removeEventListener("mousedown", closeChainSearch);
      window.removeEventListener("resize", resizeVisibleCharts);
      appResizeObserver?.disconnect();
      removeWidgetStateListener?.();
      stopMsLive();
      for (const offset of [...msCharts.keys()]) destroyMsChart(offset);
      stopPdLive();
      if (pdChart) { pdChart.destroy(); pdChart = null; }
      stopVgLive();
      if (vgChart) { vgChart.destroy(); vgChart = null; }
    });
  });

  createEffect(() => {
    section();
    queueChartResize();
  });

  createEffect(() => {
    if (!authed()) {
      setMarketStrip(MARKET_STRIP_SYMBOLS.map((item) => ({ ...item, price: null, change: null, ok: false })));
      setMarketStripStatus("Waiting for session");
      return;
    }
    token();
    deviceId();
    environment();
    untrack(() => loadMarketStrip().finally(startMarketStripLive));
    onCleanup(stopMarketStripLive);
  });

  createEffect(() => {
    if (!authed()) {
      setScriptCache({ date: "", exchange: scriptExchange(), rows: [], downloadedAt: "" });
      setScriptStatus("Login to download scripts");
      return;
    }
    const selectedExchange = scriptExchange();
    localStorage.setItem("nubraScriptExchange", selectedExchange);
    token();
    deviceId();
    environment();
    untrack(() => loadCachedScripts(selectedExchange, false).catch((error) => setScriptStatus(error.message || "Script cache unavailable")));
  });

  createEffect(() => {
    if (!authed() || section() !== "chain" || instrumentSwitching()) return;
    const query = chainSearchText().trim().toUpperCase();
    if (query.length >= 2 && !chainSearchRows().length) {
      untrack(() => loadChainSearchRows().catch((error) => setScriptStatus(error.message || "Search scripts unavailable")));
    }
  });

  createEffect(() => {
    if (!authed() || section() !== "chain" || instrumentSwitching()) return;
    if (!chainDerivedStats().atmIv) return;
    const expiry = String(chainData()?.expiry || chainExpiry() || "");
    if (!expiry) return;
    const key = [chainExchange(), chainSymbol().trim().toUpperCase(), expiry].join("|");
    if (chainIvChange().key === key) return;
    setChainIvChange({ key, value: null, baseIv: null, baseDate: "" });
    untrack(async () => {
      try {
        const { baseIv, baseDate } = await fetchChainIvBaseline();
        setChainIvChange((current) => current.key === key ? { key, value: null, baseIv, baseDate } : current);
      } catch {
        setChainIvChange((current) => current.key === key ? { key, value: null, baseIv: null, baseDate: "" } : current);
      }
    });
  });

  createEffect(() => {
    if (section() !== "iv-term" || !ivTermChartHost) return;
    const points = ivTermPoints();
    ivTermChart?.destroy();
    ivTermChart = null;
    if (!points.length) return;
    const categories = points.map((point) => {
      const date = parseExpiryDate(point.expiry);
      return date
        ? date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" })
        : point.expiry;
    });
    ivTermChart = Highcharts.chart(ivTermChartHost, {
      chart: { type: "spline", backgroundColor: "transparent", animation: false, spacing: [18, 18, 12, 12] },
      title: { text: undefined },
      credits: { enabled: false },
      legend: { itemStyle: { color: "#D7DEE8", fontSize: "11px" }, itemHoverStyle: { color: "#D7DEE8" } },
      xAxis: {
        categories,
        lineColor: "rgba(255,255,255,0.12)",
        tickColor: "rgba(255,255,255,0.12)",
        labels: { style: { color: "#9CA8B8", fontSize: "10px" } },
        title: { text: "Expiry", style: { color: "#9CA8B8" } }
      },
      yAxis: {
        title: { text: "Implied Volatility (%)", style: { color: "#9CA8B8" } },
        labels: { format: "{value:.1f}%", style: { color: "#9CA8B8", fontSize: "10px" } },
        gridLineColor: "rgba(68,80,94,0.35)"
      },
      tooltip: {
        shared: true,
        useHTML: true,
        backgroundColor: "rgba(22,22,24,0.98)",
        borderColor: "rgba(255,255,255,0.14)",
        style: { color: "#D7DEE8" },
        formatter: function () {
          const point = points[this.points?.[0]?.point?.index ?? this.point?.index ?? 0];
          const seriesRows = (this.points || []).map((item) => `<div><span style="color:${item.color}">●</span> ${item.series.name}: <b>${Number(item.y).toFixed(2)}%</b></div>`).join("");
          return `<b>${point?.expiry || ""}</b><br/><span style="color:#9CA8B8">DTE ${point?.dte ?? "--"} · ATM ${number.format(point?.strike || 0)}</span>${seriesRows}`;
        }
      },
      plotOptions: {
        series: { animation: false, marker: { enabled: true, radius: 4 }, lineWidth: 2 },
        spline: { states: { hover: { lineWidth: 3 } } }
      },
      series: [
        { name: "ATM IV", data: points.map((point) => point.atmIv), color: "#3B82F6", lineWidth: 3, zIndex: 3 },
        { name: "CE IV", data: points.map((point) => point.ceIv), color: "#10B981", dashStyle: "ShortDash" },
        { name: "PE IV", data: points.map((point) => point.peIv), color: "#EF4444", dashStyle: "ShortDash" }
      ]
    });
    onCleanup(() => {
      ivTermChart?.destroy();
      ivTermChart = null;
    });
  });

  createEffect(() => {
    if (section() !== "iv-term" || !smileChartHost) return;
    const surface = selectedSmile();
    smileChart?.destroy();
    smileChart = null;
    if (!surface?.rows?.length) return;
    smileChart = Highcharts.chart(smileChartHost, {
      chart: { type: "spline", backgroundColor: "transparent", animation: false, spacing: [18, 18, 12, 12] },
      title: { text: undefined },
      credits: { enabled: false },
      legend: { itemStyle: { color: "#D7DEE8", fontSize: "11px" }, itemHoverStyle: { color: "#D7DEE8" } },
      xAxis: {
        type: "linear",
        title: { text: "Strike", style: { color: "#9CA8B8" } },
        labels: { style: { color: "#9CA8B8", fontSize: "10px" } },
        lineColor: "rgba(255,255,255,0.12)",
        tickColor: "rgba(255,255,255,0.12)",
        plotLines: Number.isFinite(surface.atmStrike) ? [{ value: surface.atmStrike, color: "#3B82F6", width: 1, dashStyle: "ShortDash", label: { text: "ATM", style: { color: "#3B82F6", fontSize: "9px" } } }] : []
      },
      yAxis: {
        title: { text: "Implied Volatility (%)", style: { color: "#9CA8B8" } },
        labels: { format: "{value:.1f}%", style: { color: "#9CA8B8", fontSize: "10px" } },
        gridLineColor: "rgba(68,80,94,0.35)"
      },
      tooltip: {
        shared: true,
        valueDecimals: 2,
        valueSuffix: "%",
        backgroundColor: "rgba(22,22,24,0.98)",
        borderColor: "rgba(255,255,255,0.14)",
        style: { color: "#D7DEE8" }
      },
      plotOptions: { series: { animation: false, marker: { enabled: true, radius: 3 }, lineWidth: 2 } },
      series: [
        { name: "Call IV", data: surface.rows.filter((row) => Number.isFinite(row.ceIv)).map((row) => [row.strike, row.ceIv]), color: "#10B981" },
        { name: "Put IV", data: surface.rows.filter((row) => Number.isFinite(row.peIv)).map((row) => [row.strike, row.peIv]), color: "#EF4444" }
      ]
    });
    onCleanup(() => {
      smileChart?.destroy();
      smileChart = null;
    });
  });

  // ── Total GEX over time ──
  // Plots the intraday whole-chain GEX as a line through zero: above zero =
  // dealers net LONG gamma (pinning), below = SHORT gamma (squeeze). A dashed
  // zero line marks the long↔short flip. Re-runs reactively as samples arrive.
  function buildGexTimeChart(host) {
    const hist = gexHistory();
    if (!host || hist.length < 2) return null;
    const sorted = [...hist].sort((a, b) => a.t - b.t);
    const data = sorted.map((p) => [p.t * 1000, p.gex]); // GEX (left axis)
    // Spot + Gamma Flip over time on a separate right (price) axis, so you can
    // see spot crossing the flip and the GEX flipping red at the same instant.
    const spotData = sorted.filter((p) => Number.isFinite(p.spot)).map((p) => [p.t * 1000, p.spot]);
    const flipData = sorted.filter((p) => Number.isFinite(p.flip)).map((p) => [p.t * 1000, p.flip]);
    const hasPrice = spotData.length > 1 || flipData.length > 1;
    // Mark the moments spot crossed the flip (regime change) with a point on spot.
    // Regime-change markers: detect where the GEX SIGN flips (the ground-truth
    // long↔short transition), placed on the spot line at that time.
    const crossPoints = [];
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1], b = sorted[i];
      if (a.gex == null || b.gex == null || !Number.isFinite(b.spot)) continue;
      const wasLong = a.gex >= 0, isLong = b.gex >= 0;
      if (wasLong !== isLong) {
        crossPoints.push({
          x: b.t * 1000, y: b.spot,
          marker: { enabled: true, radius: 4, symbol: "circle", fillColor: isLong ? "#10B981" : "#EF4444", lineColor: "#fff", lineWidth: 1 },
          crossInfo: isLong ? "Flipped LONG gamma (pinning)" : "Flipped SHORT gamma (squeeze)"
        });
      }
    }
    const maxAbs = Math.max(1e-9, ...sorted.map((p) => Math.abs(p.gex)));
    // Build a lookup so the GEX-line tooltip can also show spot/flip at that time.
    const byMs = new Map(sorted.map((p) => [p.t * 1000, p]));

    return Highcharts.chart(host, {
      chart: { type: "area", backgroundColor: "transparent", animation: false, spacing: [16, 16, 10, 10], zoomType: "x" },
      title: { text: undefined },
      credits: { enabled: false },
      legend: {
        enabled: hasPrice, itemStyle: { color: "#D7DEE8", fontSize: "10px" },
        itemHoverStyle: { color: "#D7DEE8" }, align: "right", verticalAlign: "top"
      },
      time: { useUTC: false }, // x labels in local (IST) time
      xAxis: {
        type: "datetime",
        lineColor: "rgba(255,255,255,0.12)", tickColor: "rgba(255,255,255,0.12)",
        labels: { style: { color: "#9CA8B8", fontSize: "10px" } },
        title: { text: "Time", style: { color: "#9CA8B8" } }
      },
      yAxis: [
        {
          min: -maxAbs * 1.1, max: maxAbs * 1.1,
          title: { text: "Total GEX (₹ Cr)", style: { color: "#9CA8B8" } },
          labels: { style: { color: "#9CA8B8", fontSize: "10px" }, formatter: function () { return fmtGEX(this.value); } },
          gridLineColor: "rgba(68,80,94,0.35)",
          plotLines: [{ value: 0, color: "rgba(255,255,255,0.45)", width: 1.5, dashStyle: "Dash", zIndex: 4,
            label: { text: "Long ↑ / Short ↓", style: { color: "#D7DEE8", fontSize: "10px" }, align: "left", x: 6, y: 12 } }]
        },
        {
          // Price axis (right) for Spot + Gamma Flip.
          title: { text: "Price", style: { color: "#9CA8B8" } },
          labels: { style: { color: "#9CA8B8", fontSize: "10px" }, formatter: function () { return number.format(this.value); } },
          gridLineWidth: 0, opposite: true
        }
      ],
      tooltip: {
        shared: true, useHTML: true,
        backgroundColor: "rgba(22,22,24,0.98)", borderColor: "rgba(255,255,255,0.14)",
        style: { color: "#D7DEE8" },
        formatter: function () {
          const t = Highcharts.dateFormat("%H:%M:%S", this.x);
          const p = byMs.get(this.x);
          const gx = p ? p.gex : (this.points && this.points[0] ? this.points[0].y : null);
          const regime = (gx != null && gx >= 0) ? "LONG (pinning)" : "SHORT (squeeze)";
          let html = `<b>${t}</b><br/>GEX: <b>${gx == null ? "--" : (gx >= 0 ? "+" : "") + fmtGEX(gx) + " Cr"}</b> · ${regime}`;
          if (p && Number.isFinite(p.spot)) html += `<br/>Spot: <b>${number.format(Math.round(p.spot))}</b>`;
          if (p && Number.isFinite(p.flip)) {
            // Regime is the ground truth (GEX sign); describe spot vs flip from it
            // so the label can never contradict the GEX color.
            const isLong = gx != null && gx >= 0;
            html += `<br/>Flip: <b style="color:#8B5CF6">${number.format(Math.round(p.flip))}</b> · spot ${isLong ? "above ✓ long γ" : "below ⚠ short γ"}`;
          }
          return html;
        }
      },
      plotOptions: {
        area: {
          animation: false, lineWidth: 2, marker: { enabled: false },
          negativeColor: "#EF4444", color: "#10B981",
          threshold: 0, fillOpacity: 0.18
        },
        line: { animation: false, lineWidth: 1.5, marker: { enabled: false } }
      },
      series: [
        { type: "area", name: "Total GEX", data, yAxis: 0, zIndex: 2 },
        ...(flipData.length > 1 ? [{
          type: "line", name: "Gamma Flip", data: flipData, yAxis: 1, color: "#8B5CF6",
          dashStyle: "ShortDash", zIndex: 3, enableMouseTracking: true
        }] : []),
        ...(spotData.length > 1 ? [{
          type: "line", name: "Spot", data: spotData, yAxis: 1, color: "#60a5fa", zIndex: 4
        }] : []),
        ...(crossPoints.length ? [{
          type: "scatter", name: "Flip cross", data: crossPoints, yAxis: 1, zIndex: 5,
          marker: { enabled: true }, showInLegend: false,
          tooltip: { pointFormatter: function () { return `<span style="color:${this.marker.fillColor}">●</span> ${this.crossInfo}`; } }
        }] : [])
      ]
    });
  }

  // ── Gamma Density charts (Intraday + To Expiry) ──
  // Builds a Highcharts panel: amber Γ×OI density spline (normalized 0..1),
  // green convexity bell (Gaussian on spot, width = 1σ), dashed spot line and a
  // shaded ±1σ expected-move band. Re-runs reactively, so live ticks redraw.
  function buildGammaPanel(host, densityKey, band) {
    const gd = gammaDensity();
    if (!gd.hasData) return null;
    const spot = gd.spot;
    const strikes = gd.chain.map((c) => c.strike);
    if (strikes.length < 2) return null;
    const minK = Math.min(...strikes);
    const maxK = Math.max(...strikes);

    // Density normalized to its own peak so it shares a 0..1 axis with the bell.
    const rawDensity = gd.chain.map((c) => c[densityKey] || 0);
    const maxDensity = Math.max(...rawDensity, 1e-12);
    const densitySeries = gd.chain.map((c) => [c.strike, (c[densityKey] || 0) / maxDensity]);

    // Convexity zone — Gaussian centred on spot, width = 1σ expected move.
    const sigma = band?.sigma_move > 0 ? band.sigma_move : 0;
    const convexity = [];
    if (sigma > 0) {
      const POINTS = 121;
      const step = (maxK - minK) / (POINTS - 1);
      for (let i = 0; i < POINTS; i++) {
        const x = minK + i * step;
        convexity.push([x, Math.exp(-0.5 * ((x - spot) / sigma) ** 2)]);
      }
    }

    const plotBands = band && band.one_sigma_low < band.one_sigma_high
      ? [{ from: band.one_sigma_low, to: band.one_sigma_high, color: "rgba(96,165,250,0.08)" }]
      : [];
    const plotLines = Number.isFinite(spot)
      ? [{
          value: spot, color: "#60a5fa", width: 1.5, dashStyle: "Dash", zIndex: 4,
          label: { text: "Spot", style: { color: "#60a5fa", fontSize: "10px" }, y: 12 }
        }]
      : [];
    // Gamma Flip — the transition ZONE where Net GEX turns from negative
    // (volatile, below) to positive (pinning, above). Shaded band = the two
    // strikes bracketing the crossing; the dashed line = the interpolated point.
    if (Number.isFinite(gd.gammaFlipLow) && Number.isFinite(gd.gammaFlipHigh)) {
      plotBands.push({
        from: gd.gammaFlipLow, to: gd.gammaFlipHigh, color: "rgba(139,92,246,0.14)", zIndex: 0,
        label: { text: `Flip zone`, style: { color: "#8B5CF6", fontSize: "9px" }, y: 14 }
      });
    }
    if (Number.isFinite(gd.gammaFlip) && gd.gammaFlip >= minK && gd.gammaFlip <= maxK) {
      plotLines.push({
        value: gd.gammaFlip, color: "#8B5CF6", width: 1.5, dashStyle: "ShortDash", zIndex: 4,
        label: { text: `Gamma Flip ~${number.format(Math.round(gd.gammaFlip))}`, style: { color: "#8B5CF6", fontSize: "10px" }, y: 28 }
      });
    }

    return Highcharts.chart(host, {
      chart: { type: "spline", backgroundColor: "transparent", animation: false, spacing: [16, 16, 10, 10] },
      title: { text: undefined },
      credits: { enabled: false },
      legend: { itemStyle: { color: "#D7DEE8", fontSize: "11px" }, itemHoverStyle: { color: "#D7DEE8" } },
      xAxis: {
        min: minK, max: maxK,
        plotBands, plotLines,
        lineColor: "rgba(255,255,255,0.12)", tickColor: "rgba(255,255,255,0.12)",
        labels: { style: { color: "#9CA8B8", fontSize: "10px" }, formatter: function () { return number.format(this.value); } },
        title: { text: "Strike / Price", style: { color: "#9CA8B8" } }
      },
      yAxis: {
        min: 0, max: 1.08, title: { text: undefined },
        labels: { style: { color: "#9CA8B8", fontSize: "10px" } },
        gridLineColor: "rgba(68,80,94,0.35)"
      },
      tooltip: {
        shared: true, useHTML: true,
        backgroundColor: "rgba(22,22,24,0.98)", borderColor: "rgba(255,255,255,0.14)",
        style: { color: "#D7DEE8" },
        formatter: function () {
          const rows = (this.points || []).map((p) =>
            `<div><span style="color:${p.color}">●</span> ${p.series.name}: <b>${Number(p.y).toFixed(2)}</b></div>`).join("");
          return `<b>${number.format(this.x)}</b>${rows}`;
        }
      },
      plotOptions: {
        series: { animation: false, marker: { enabled: false }, lineWidth: 2 },
        spline: { states: { hover: { lineWidth: 3 } } }
      },
      series: [
        {
          name: "Convexity Zone", data: convexity, color: "#10B981",
          fillOpacity: 0.14, type: "areaspline", lineWidth: 2, zIndex: 1
        },
        {
          name: "Density (Γ×OI)", data: densitySeries, color: "#8B5CF6",
          lineWidth: 2, zIndex: 3, marker: { enabled: true, radius: 2 }
        }
      ]
    });
  }

  createEffect(() => {
    if (section() !== "gamma" || !gammaIntradayHost) return;
    gammaDensity(); // track for live redraw
    gammaIntradayChart?.destroy();
    gammaIntradayChart = buildGammaPanel(gammaIntradayHost, "density_intraday", gammaDensity().intradayBand);
    onCleanup(() => { gammaIntradayChart?.destroy(); gammaIntradayChart = null; });
  });

  createEffect(() => {
    if (section() !== "gamma" || !gammaExpiryHost) return;
    gammaDensity(); // track for live redraw
    gammaExpiryChart?.destroy();
    gammaExpiryChart = buildGammaPanel(gammaExpiryHost, "density_expiry", gammaDensity().expiryBand);
    onCleanup(() => { gammaExpiryChart?.destroy(); gammaExpiryChart = null; });
  });

  createEffect(() => {
    if (section() !== "gamma" || !gexTimeHost) return;
    gexHistory(); // track: redraw as new GEX samples arrive
    gexTimeChart?.destroy();
    gexTimeChart = buildGexTimeChart(gexTimeHost);
    onCleanup(() => { gexTimeChart?.destroy(); gexTimeChart = null; });
  });

  // ── Shared store for extracted view components (see src/state/AppContext.jsx) ──
  const store = {
    // signals (read)
    section, busy, authed,
    chainData, chainSymbol, chainExchange, chainExpiry, chainStatus, chainLive,
    oiTsStrikes, oiTsHistory, oiTsStartDate, oiTsEndDate, oiTsRange,
    smartOiHistory, smartOiLoaded, smartOiIndicatorEnabled,
    smileSurfaces, ivTermSymbol, ivTermExchange, ivTermStatus,
    ivTermSummary, ivTermPoints, smileExpiry, selectedSmile,
    oiProfileRange, oiProfile, maxPain,
    chainExpiries, gammaRange, chainDerivedStats, gammaDensity, chainSearchRows,
    rollStats, rollStatus, rollDrawnLines, rollWindowMode, rollSeriesVisibility,
    rollLive, rollLineName, rollLineValue, rollLineTarget, rollExportData,
    rollStrikeInput, rollSelectedStrikes, rollChainRows,
    rollIndicatorMenuOpen, rollIndicatorPane, rollIndicatorPaneHeight,
    leftSettingsCollapsed,
    msLayout, msStatus, msCells, msSeriesVisibility, msSlots,
    pdStatus, pdCells, pdSpotVisible, pdLiveOn,
    pdPickMode, pdAtmRange, pdFixedCenter, pdFixedRange, pdCustomLegs,
    pdChainRows, pdSelectedLegs, pdLegendLegs, pdLegVisibility,
    vgStatus, vgCells, vgSpotVisible, vgLiveOn,
    vgDeltaMin, vgDeltaMax,
    vgChainRows, vgLegVisibility,
    rollSymbol, rollExpiry, rollExchange, rollExpiries, rollStart, rollEnd,
    oieTab, oieSymbol, oieExpiry, oieExpiries, oieExpiryLoading,
    oieData, oieAnalytics, oieSignals, oieChain, oieStatus, oieError,
    symbol, instrumentType, exchange, interval, startDate, endDate,
    spot, change, candleCount, chartStatus,
    chainSearchOpen, chainSearchText, chainSearchCategory, chainScriptMatches, groupedChainScriptMatches,
    chainFilterMode, chainAtmRange, chainPremiumMin, chainPremiumMax,
    chainColumnMenuOpen, chainVisibleColumns, chainRefMetrics, chainIvChange, chainIvChangePercent,
    visibleOptionRows, visibleCallColumns, visiblePutColumns,
    // setters
    setOiTsRange, setOiTsHistory, setOiTsStartDate, setOiTsEndDate, setChainSearchOpen,
    setIvTermSymbol, setIvTermExchange, setOiProfileRange, setSmileExpiry,
    setGammaRange, setScriptStatus, setRollChartWindowMode,
    setRollLineName, setRollLineValue, setRollLineTarget,
    setRollStrikeInput,
    setRollIndicatorMenuOpen, setRollIndicatorPaneHeight,
    setOieTab, setOieSymbol, setOieExpiry, setOieExpiries, setOieError,
    setSymbol, setInstrumentType, setExchange, setIntervalValue, setStartDate, setEndDate,
    setChainSymbol, setChainExchange, setChainData, setChainExpiry, setChainExpiries,
    setChainSearchText, setChainSearchQuery, setChainSearchCategory,
    setChainFilterMode, setChainAtmRange, setChainPremiumMin, setChainPremiumMax,
    setChainColumnMenuOpen,
    // derived/helpers
    smileSurfaceForExpiry, selectChainExpiry, rollLineColor,
    chooseChainScript, chainColumnLabel, optionCellProps, showPremiumSide,
    toggleChainColumn, showAllChainColumns, oieTagRow, chainStrikeInRupees,
    // chart-host registration (App owns the chart effects)
    registerIvTermHost: (el) => { ivTermChartHost = el; },
    registerSmileHost: (el) => { smileChartHost = el; },
    registerGammaIntradayHost: (el) => { gammaIntradayHost = el; },
    registerGammaExpiryHost: (el) => { gammaExpiryHost = el; },
    registerGexTimeHost: (el) => { gexTimeHost = el; },
    loadGexHistory, gexHistStatus, gexHistLoading, gexHistDate, setGexHistDate,
    registerRollChartHost: (el) => { rollChartHost = el; initRollChart(); queueChartResize(); },
    registerRollIndicatorHost, openRollIndicatorPane, closeRollIndicatorPane,
    registerMsChartHost,
    setMsLayout: setMsLayoutAndRefresh, toggleMsSeries, setMsSlot, msSlotCount,
    registerPdChartHost,
    togglePdLeg, togglePdSpot,
    setPdPickMode: setPdPickModeP, setPdAtmRange: setPdAtmRangeP,
    setPdFixedCenter: setPdFixedCenterP, setPdFixedRange: setPdFixedRangeP,
    pdToggleCustomLeg, pdRemoveCustomLeg, pdClearCustomLegs, pdSelectAllCustom,
    loadPdChainRows, loadPremiumDecay, startPdLive, stopPdLive,
    registerVgChartHost,
    toggleVgLeg, toggleVgSpot,
    setVgDeltaMin: setVgDeltaMinP, setVgDeltaMax: setVgDeltaMaxP,
    loadVegaAnalysis, startVgLive, stopVgLive,
    loadRollingExpiries, openSymbolSearch,
    toggleSettingsPanel,
    setRollSymbol, setRollExpiry, setRollExchange, setRollStart, setRollEnd,
    registerPriceChartHost: (el) => { priceChartHost = el; initPriceChart(); queueChartResize(); },
    registerChainExpiryMenuHost: (el) => { chainExpiryMenuHost = el; },
    // actions
    run, loadOiTsSeries, loadSmartOiSeries, toggleSmartOiIndicator, startChainLive, stopChainLive, loadIvTermStructure, loadOptionChain,
    loadChainSearchRows, removeRollLine, toggleRollSeries,
    addRollSelectedStrike, removeRollSelectedStrike, clearRollSelectedStrikes, toggleRollSelectedStrike,
    loadRollingStraddle, startRollLive, stopRollLive, addRollLine,
    loadRollChainRows, downloadCSV, downloadParquet, handleImport,
    straddleMonitor, setStraddleMonitor, straddleAlerts, setStraddleAlerts,
    chainMonitor, setChainMonitor, chainAlerts, setChainAlerts,
    spotMonitor, setSpotMonitor, spotAlerts,
    loadOieExpiries, loadOie, loadSpotPrice, loadPriceChart, loadOptionChainExpiries,
  };

  return (
    <AppProvider store={store}>
    <div ref={(el) => { appRootHost = el; }} data-theme={appTheme()} class={`app-root ${widgetMode ? "desktop-widget-mode" : ""}`} style="background:var(--bg-main);color:var(--text-primary)">
      <Show when={widgetMode}>
        <div class="widget-titlebar">
          <div class="widget-drag-zone" onDblClick={async () => setWidgetMaximized(await desktopApi?.toggleMaximizeWidget?.())}>
            <strong>Option Chain Widget</strong>
            <span>{chainSymbol()} · {chainExchange()} · {chainExpiry() || "Auto"}</span>
          </div>
          <button data-ui="button" data-appearance="stealth" onClick={() => setDrawerOpen(true)}>Session</button>
          <button data-ui="button" data-appearance="stealth" onClick={() => desktopApi?.openMain?.()}>Main App</button>
          <div class="widget-window-controls">
            <button data-ui="button" data-appearance="stealth" aria-label="Minimize" title="Minimize" onClick={() => desktopApi?.minimizeWidget?.()}>−</button>
            <button data-ui="button"
              data-appearance="stealth"
              aria-label={widgetMaximized() ? "Restore" : "Maximize"}
              title={widgetMaximized() ? "Restore" : "Maximize"}
              onClick={async () => setWidgetMaximized(await desktopApi?.toggleMaximizeWidget?.())}
            >{widgetMaximized() ? "❐" : "□"}</button>
            <button data-ui="button" data-appearance="stealth" aria-label="Close" title="Close" onClick={() => desktopApi?.closeWidget?.()}>×</button>
          </div>
        </div>
      </Show>

      <Show when={!widgetMode}>
      <header ref={(el) => { appHeaderHost = el; }} class={`app-shell-header ${headerCompact() ? "nav-compact" : ""}`}>
        <div class="app-shell-brand">
          <div class="brand-mark">N</div>
          <div class="brand-text min-w-0">
            <p class="brand-eyebrow">NUBRA</p>
            <h1 class="brand-title truncate">Options Intelligence</h1>
          </div>
        </div>

        <div class="mkt-strip" title={marketStripStatus()}>
          <For each={marketStrip()}>
            {(item) => {
              const changeValue = Number(item.change);
              const isDown = Number.isFinite(changeValue) && changeValue < 0;
              const tone = isDown ? "down" : "up";
              return (
                <div class={`mkt-card ${item.ok ? tone : "muted"}`}>
                  <div class="mkt-top">
                    <span class="mkt-label">{item.label}</span>
                    <span class="mkt-exch">{item.unit ?? item.exchange}</span>
                  </div>
                  <div class="mkt-bottom">
                    <span class="mkt-price">{formatIndexValue(item.price)}</span>
                    <span class={`mkt-change ${item.ok ? tone : ""}`}>
                      <Show when={item.ok}>
                        <span class="mkt-arrow">{isDown ? "▼" : "▲"}</span>
                      </Show>
                      {formatPercent(item.change)}
                    </span>
                  </div>
                  <Show when={item.ok}>
                    <span class={`mkt-pulse ${tone}`} />
                  </Show>
                </div>
              );
            }}
          </For>
          <button
            data-ui="button"
            data-appearance="stealth"
            title="Spot Monitor: Speed, Range-bound, Gap alerts"
            style={`font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid ${spotMonitor() ? "rgba(16,185,129,0.5)" : "rgba(255,255,255,0.1)"};background:${spotMonitor() ? "rgba(16,185,129,0.12)" : "transparent"};color:${spotMonitor() ? "#10B981" : "var(--tx-3)"};white-space:nowrap;cursor:pointer`}
            onClick={() => setSpotMonitor((v) => !v)}
          >{spotMonitor() ? "● Monitor ON" : "Monitor"}</button>
        </div>

        <div data-ui="tabs" class="analysis-nav-tabs shrink-0" data-activeid={section()} aria-label="Analysis views">
          <button data-ui="tab" id="rolling" onClick={() => { setSection("rolling"); setLabNavOpen(false); setChainNavOpen(false); }}>
            Straddle
          </button>
          <div class="chain-nav-dropdown" ref={(el) => { labNavHost = el; }}>
            <button
              data-ui="tab"
              id="optionslab"
              type="button"
              aria-haspopup="menu"
              aria-expanded={labNavOpen()}
              aria-selected={["premiumdecay","vega","multispread"].includes(section())}
              onClick={() => {
                setLabNavOpen((open) => !open);
                setChainNavOpen(false);
              }}
            >
              Options Lab <span class="chain-nav-caret">▾</span>
            </button>
            <Show when={labNavOpen()}>
              <div class="chain-nav-menu options-lab-menu" role="menu" aria-label="Options Lab views">
                <button type="button" role="menuitem" class={section() === "premiumdecay" ? "active" : ""} onClick={() => { setSection("premiumdecay"); setLabNavOpen(false); }}>
                  <span>Premium Decay</span>
                  <small>Track CE/PE premium change from open</small>
                </button>
                <button type="button" role="menuitem" class={section() === "vega" ? "active" : ""} onClick={() => { setSection("vega"); setLabNavOpen(false); }}>
                  <span>Vega Analysis</span>
                  <small>Vega build-up and bleed by delta band</small>
                </button>
                <button type="button" role="menuitem" class={section() === "multispread" ? "active" : ""} onClick={() => { setSection("multispread"); setLabNavOpen(false); }}>
                  <span>Multi Spread</span>
                  <small>Compare rolling OTM spread grids</small>
                </button>
              </div>
            </Show>
          </div>
          <div class="chain-nav-dropdown" ref={(el) => { chainNavHost = el; }}>
            <button
              data-ui="tab"
              id="chain"
              type="button"
              aria-haspopup="menu"
              aria-expanded={chainNavOpen()}
              aria-selected={["chain","iv-term","gamma","oi-profile","max-pain","oi-timeseries","vol-surface"].includes(section())}
              onClick={() => {
                setChainNavOpen((open) => !open);
                setLabNavOpen(false);
              }}
            >
              Option Chain <span class="chain-nav-caret">▾</span>
            </button>
            <Show when={chainNavOpen()}>
              <div class="chain-nav-menu" role="menu" aria-label="Option Chain views">
                <button type="button" role="menuitem" class={section() === "chain" ? "active" : ""} onClick={() => { setSection("chain"); setChainNavOpen(false); }}>
                  <span>Option Chain</span>
                  <small>Strikes, OI and Greeks</small>
                </button>
                <button type="button" role="menuitem" class={section() === "iv-term" ? "active" : ""} onClick={() => {
                  setIvTermSymbol(chainSymbol());
                  setIvTermExchange(chainExchange());
                  setSection("iv-term");
                  setChainNavOpen(false);
                }}>
                  <span>IV Term Structure</span>
                  <small>IV across expiries</small>
                </button>
                <button type="button" role="menuitem" class={section() === "gamma" ? "active" : ""} onClick={() => {
                  setSection("gamma");
                  setChainNavOpen(false);
                }}>
                  <span>Gamma Density</span>
                  <small>Γ×OI hedging pressure</small>
                </button>
                <button type="button" role="menuitem" class={section() === "oi-profile" ? "active" : ""} onClick={() => { setSection("oi-profile"); setChainNavOpen(false); }}>
                  <span>OI Profile</span>
                  <small>Butterfly: CE vs PE open interest</small>
                </button>
                <button type="button" role="menuitem" class={section() === "max-pain" ? "active" : ""} onClick={() => { setSection("max-pain"); setChainNavOpen(false); }}>
                  <span>Max Pain</span>
                  <small>Min-loss expiry strike</small>
                </button>
                <button type="button" role="menuitem" class={section() === "oi-timeseries" ? "active" : ""} onClick={() => { setSection("oi-timeseries"); setChainNavOpen(false); }}>
                  <span>OI Time Series</span>
                  <small>Live OI build-up per strike</small>
                </button>
                <button type="button" role="menuitem" class={smartOiIndicatorEnabled() ? "active" : ""} onClick={() => run(toggleSmartOiIndicator)}>
                  <span>Smart OI</span>
                  <small>Add/remove Smart OI indicator on Chart</small>
                </button>
                <button type="button" role="menuitem" class={section() === "vol-surface" ? "active" : ""} onClick={() => { setSection("vol-surface"); setChainNavOpen(false); }}>
                  <span>Vol Surface</span>
                  <small>IV heatmap across strikes & expiries</small>
                </button>
              </div>
            </Show>
          </div>
          <button data-ui="tab" id="market" onClick={() => { setSection("market"); setLabNavOpen(false); setChainNavOpen(false); }}>
            Chart
          </button>
          <button data-ui="tab" id="gex" onClick={() => { setSection("gex"); setLabNavOpen(false); setChainNavOpen(false); }} class="oie-nav-tab">
            <span class="oie-nav-dot" />
            Intelligence
          </button>
        </div>

        <div class="app-shell-actions">
          <Show when={authed()}>
            <div class="session-greeting" aria-live="polite">
              Welcome, {userLabel()}
            </div>
          </Show>
          <button
            class="header-icon-btn"
            type="button"
            aria-label="Open app and chart guide"
            title="App and chart guide"
            onClick={() => setMainHelpOpen(true)}
          >i</button>
          <Show when={desktopApi?.openWidget}>
            <button data-ui="button" data-appearance="accent" onClick={() => desktopApi.openWidget()}>
              Widget
            </button>
          </Show>
          <div class="control-center" ref={(el) => { controlCenterHost = el; }}>
            <button
              type="button"
              class={`control-trigger ${authed() ? "connected" : "offline"}`}
              aria-haspopup="menu"
              aria-expanded={controlCenterOpen()}
              title="Control center"
              onClick={() => setControlCenterOpen((open) => !open)}
            >
              <span class="control-avatar">{userInitial()}</span>
              <span class="control-meta">
                <span class="control-name">{userLabel()}</span>
                <span class="control-state">{authed() ? "Connected" : "No session"}</span>
              </span>
              <span class="control-chevron">▾</span>
            </button>
            <Show when={controlCenterOpen()}>
              <div class="control-menu" role="menu" aria-label="Control center">
                <div class="control-menu-head">
                  <span class={`control-avatar lg ${authed() ? "connected" : "offline"}`}>{userInitial()}</span>
                  <div>
                    <div class="control-menu-title">{userLabel()}</div>
                    <div class={`control-menu-status ${authed() ? "connected" : "offline"}`}>
                      {authed() ? "Session connected" : "Session required"}
                    </div>
                  </div>
                </div>
                <div class="control-menu-section">
                  <span class="control-menu-label">Theme</span>
                  <div class="theme-toggle" role="group" aria-label="Theme selector">
                    <For each={THEME_OPTIONS}>
                      {(theme) => (
                        <button
                          type="button"
                          class="theme-toggle-option"
                          aria-pressed={appTheme() === theme.key}
                          onClick={() => setAppTheme(theme.key)}
                        >
                          {theme.label.replace(" Blue", "").replace(" Pro", "")}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
                <button
                  type="button"
                  class="control-menu-action"
                  role="menuitem"
                  onClick={() => {
                    setDrawerOpen(true);
                    setControlCenterOpen(false);
                  }}
                >
                  Session Settings
                </button>
              </div>
            </Show>
          </div>
        </div>
      </header>
      </Show>

      <Show when={spotMonitor() && spotAlerts().length}>
        <div style="display:flex;gap:6px;padding:4px 12px;overflow-x:auto;background:rgba(16,185,129,0.04);border-bottom:1px solid rgba(16,185,129,0.12);flex-shrink:0;align-items:center">
          <span style="font-size:9px;color:#10B981;font-weight:700;letter-spacing:.05em;flex-shrink:0;opacity:.7">SPOT</span>
          <For each={spotAlerts().slice(0, 6)}>
            {(a) => (
              <div style="flex-shrink:0;padding:3px 10px;border-radius:4px;background:rgba(16,185,129,0.07);border:1px solid rgba(16,185,129,0.2);font-size:10px;white-space:nowrap">
                <span style="color:#10B981;font-weight:700">{a.title}</span>
                <span style="color:var(--tx-3);margin-left:6px">{a.body}</span>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={!widgetMode && mainHelpOpen()}>
        <div class="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={() => setMainHelpOpen(false)}>
          <div data-ui="card" class="max-h-[90vh] w-11/12 max-w-4xl overflow-y-auto p-0" role="dialog" aria-modal="true" aria-labelledby="main-help-title" onClick={(event) => event.stopPropagation()}>
            <div class="flex items-center justify-between border-b border-gray-800 px-5 py-4">
              <div>
                <span data-ui="badge" data-appearance="accent">Quick guide</span>
                <h2 class="mt-2 text-lg font-bold" id="main-help-title">Using Options Intelligence</h2>
              </div>
              <button data-ui="button" data-appearance="stealth" type="button" aria-label="Close guide" title="Close" onClick={() => setMainHelpOpen(false)}>×</button>
            </div>
            <div class="grid gap-3 p-5 md:grid-cols-2">
              <article class="flex flex-row gap-3 rounded border border-gray-800 bg-[#080808] p-4">
                <span data-ui="badge" data-appearance="accent">1</span>
                <div><h3>Connect your session</h3><p>Open Session, enter your Nubra credentials, and confirm the header shows Connected.</p></div>
              </article>
              <article class="flex flex-row gap-3 rounded border border-gray-800 bg-[#080808] p-4">
                <span data-ui="badge" data-appearance="accent">2</span>
                <div><h3>Load an underlying</h3><p>Click the symbol box, choose an exchange and instrument, select an expiry and time range, then use Plot or Load.</p></div>
              </article>
              <article class="flex flex-row gap-3 rounded border border-gray-800 bg-[#080808] p-4">
                <span data-ui="badge" data-appearance="accent">3</span>
                <div><h3>Read and move the chart</h3><p>Hover an axis for its value. Drag inside the chart to pan. Drag an axis to expand or squeeze its scale, use the wheel to zoom, and double-click an axis to reset.</p></div>
              </article>
              <article class="flex flex-row gap-3 rounded border border-gray-800 bg-[#080808] p-4">
                <span data-ui="badge" data-appearance="accent">4</span>
                <div><h3>Use the analysis tools</h3><p>Switch time windows, compare Bid, Ask and IV, draw reference lines, start live updates, or export loaded data as CSV or Parquet.</p></div>
              </article>
              <article class="flex flex-row gap-3 rounded border border-gray-800 bg-[#080808] p-4">
                <span data-ui="badge" data-appearance="accent">5</span>
                <div><h3>Explore Option Chain</h3><p>Review CE/PE prices, Greeks, OI, volume, PCR and ATM IV. Use ATM distance or premium filters to focus the table.</p></div>
              </article>
              <article class="flex flex-row gap-3 rounded border border-gray-800 bg-[#080808] p-4">
                <span data-ui="badge" data-appearance="accent">6</span>
                <div><h3>Open the desktop widget</h3><p>Use Widget for an always-on-top option chain. Drag its title bar, resize from its edges, or use its window controls.</p></div>
              </article>
            </div>
            <p class="m-5 mt-0 rounded border border-cyan-800 bg-cyan-950/30 p-3 text-xs">Axis onboarding appears three times, then stays out of your way. This guide is always available from the <strong>i</strong> button.</p>
          </div>
        </div>
      </Show>

      <KDialog.Root open={drawerOpen()} onOpenChange={setDrawerOpen} modal={false}>
        <KDialog.Portal>
          <KDialog.Overlay class="kb-drawer-overlay" />
          <KDialog.Content class="kb-drawer-content" aria-label="Session">
            <div class="kb-drawer-header">
              <div>
                <p class="kb-drawer-eyebrow">Connection</p>
                <KDialog.Title class="kb-drawer-title">Nubra Session</KDialog.Title>
              </div>
              <KDialog.CloseButton data-ui="button" data-appearance="stealth" aria-label="Close">✕</KDialog.CloseButton>
            </div>

            <div class="kb-drawer-body">
              <section class="kb-drawer-section">
                <label class="kb-field-label">
                  Environment
                  <select data-ui="select" class="w-full" value={environment()} onChange={(e) => setEnvironment(e.currentTarget.value)}>
                    <option value="https://api.nubra.io">Production</option>
                    <option value="https://uatapi.nubra.io">UAT</option>
                  </select>
                </label>
                <label class="kb-field-label">
                  Session Token
                  <input data-ui="input" class="w-full" type="password" value={token()} onInput={(e) => {
                    setToken(e.currentTarget.value);
                    localStorage.setItem("nubraSessionToken", e.currentTarget.value);
                  }} placeholder="Bearer …" />
                </label>
                <label class="kb-field-label">
                  Device ID
                  <input data-ui="input" class="w-full" value={deviceId()} onInput={(e) => {
                    setDeviceId(e.currentTarget.value);
                    localStorage.setItem("nubraDeviceId", e.currentTarget.value);
                  }} placeholder="Nubra-OSS-…" />
                </label>
              </section>

              <section class="kb-drawer-section kb-drawer-section--bordered">
                <div class="kb-drawer-grid2">
                  <label class="kb-field-label">
                    Method
                    <select data-ui="select" class="w-full" value={authMethod()} onChange={(e) => setAuthMethod(e.currentTarget.value)}>
                      <option value="otp">SMS OTP</option>
                      <option value="totp">TOTP</option>
                    </select>
                  </label>
                  <label class="kb-field-label">
                    Phone
                    <input data-ui="input" class="w-full" value={phone()} onInput={(e) => setPhone(e.currentTarget.value)} placeholder="Mobile number" />
                  </label>
                </div>
                <button data-ui="button" class="w-full" data-appearance="accent" onClick={() => run(startLogin)} disabled={busy()}>Start Login</button>
                <div class="kb-drawer-grid2">
                  <label class="kb-field-label">
                    OTP / TOTP
                    <input data-ui="input" class="w-full" value={otp()} onInput={(e) => setOtp(e.currentTarget.value)} inputmode="numeric" />
                  </label>
                  <label class="kb-field-label">
                    MPIN
                    <input data-ui="input" class="w-full" type="password" value={mpin()} onInput={(e) => setMpin(e.currentTarget.value)} inputmode="numeric" />
                  </label>
                </div>
                <div class="kb-drawer-grid2">
                  <button data-ui="button" data-appearance="outline" onClick={() => run(verifyCode)} disabled={busy()}>Verify Code</button>
                  <button data-ui="button" data-appearance="outline" onClick={() => run(verifyMpin)} disabled={busy()}>Verify MPIN</button>
                </div>
                <p class="kb-drawer-status">{loginStatus()}</p>
              </section>
            </div>
          </KDialog.Content>
        </KDialog.Portal>
      </KDialog.Root>

      <main class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" style="background:var(--bg-0)">
        <Show when={toast()}>
          <div class="flex items-center gap-2.5 px-5 py-2 text-[11px] font-medium" style="background:rgba(239,68,68,0.07);border-bottom:1px solid rgba(239,68,68,0.18);color:#EF4444">
            <span class="shrink-0 opacity-60">⚠</span>
            {toast()}
          </div>
        </Show>

        <Show when={!widgetMode && !["gex","chain","gamma","oi-profile","max-pain","oi-timeseries","vol-surface","premiumdecay","vega","rolling"].includes(section())}>
          <div class="analysis-toolbar" role="toolbar" aria-label="Analysis controls">
            <div class="toolbar-search-wrap">
              <svg class="toolbar-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none">
                <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" stroke-width="1.5"/>
                <path d="M10 10L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
              <input
                class="toolbar-search-input"
                placeholder={scriptUnderlying() || rollSymbol() || "Search symbol…"}
                value={symbolSearchText()}
                disabled={!authed()}
                onFocus={() => {
                  setSymbolSearchOpen(true);
                  if (authed()) {
                    if (!(scriptCache().rows || []).length) {
                      loadCachedScripts(scriptExchange(), false).catch((e) => setScriptStatus(e.message || "Script download failed"));
                    }
                    if (!chainSearchRows().length) {
                      loadChainSearchRows().catch((e) => setScriptStatus(e.message || "Instrument masters unavailable"));
                    }
                    if (!indexMasterRows().length) {
                      loadIndexMaster().catch(() => {});
                    }
                  }
                }}
                onInput={(e) => {
                  setSymbolSearchText(e.currentTarget.value);
                  setSymbolSearchOpen(true);
                }}
              />
              <Show when={scriptUnderlying() || rollSymbol()}>
                <span class="toolbar-search-badge">{scriptExchange()}</span>
              </Show>
            </div>
            <KSelect.Root
              class="tb-field"
              value={rollExpiry() || chainExpiry() || ""}
              onChange={(val) => setUnifiedExpiry(val ?? "")}
              options={["", ...expiriesForUnderlying()]}
              itemComponent={(props) => (
                <KSelect.Item item={props.item} class="kb-select-item">
                  <KSelect.ItemLabel>{props.item.rawValue === "" ? "Auto" : props.item.rawValue}</KSelect.ItemLabel>
                </KSelect.Item>
              )}
            >
              <KSelect.Label class="tb-field-label">Expiry</KSelect.Label>
              <KSelect.Trigger class="kb-select-trigger tb-field-select" aria-label="Expiry">
                <KSelect.Value fallback="Auto">
                  {(state) => state.selectedOption() === "" ? "Auto" : state.selectedOption()}
                </KSelect.Value>
                <KSelect.Icon class="kb-select-icon">▾</KSelect.Icon>
              </KSelect.Trigger>
              <KSelect.Portal>
                <KSelect.Content class="kb-select-content">
                  <KSelect.Listbox class="kb-select-listbox" />
                </KSelect.Content>
              </KSelect.Portal>
            </KSelect.Root>
            <label class="tb-field">
              <span class="tb-field-label">Start</span>
              <input class="tb-field-input" type="datetime-local" value={section() === "market" ? startDate() : rollStart()} onInput={(e) => setUnifiedStart(e.currentTarget.value)} />
            </label>
            <label class="tb-field">
              <span class="tb-field-label">End</span>
              <input class="tb-field-input" type="datetime-local" value={section() === "market" ? endDate() : rollEnd()} onInput={(e) => setUnifiedEnd(e.currentTarget.value)} />
            </label>
            <button data-ui="button" class="shrink-0" data-appearance="stealth" title="Refresh symbols" onClick={() => run(() => loadCachedScripts(scriptExchange(), true))} disabled={busy() || !authed()}>
              Refresh
            </button>
            <Show when={section() === "rolling"}>
              <div class="toolbar-actions" aria-label="Rolling Straddle data controls">
                <button data-ui="button" data-appearance="outline" onClick={() => run(loadRollingExpiries)} disabled={busy()}>Expiries</button>
                <button data-ui="button" data-appearance="accent" onClick={() => { setImportMode(false); run(loadRollingStraddle); }} disabled={busy()}>Plot</button>
                <Show
                  when={rollLive()}
                  fallback={<button data-ui="button" data-appearance="outline" onClick={startRollLive} disabled={busy() || !authed()}>Live</button>}
                >
                  <button data-ui="button" data-appearance="outline" onClick={stopRollLive}>Stop</button>
                </Show>
                <label class="inline-flex cursor-pointer items-center rounded border border-gray-600 px-3 text-xs" title="Import CSV or Parquet file">
                  Import
                  <input type="file" accept=".csv,.parquet" class="sr-only" onChange={handleImport} />
                </label>
                <Show when={rollExportData().length > 0}>
                  <button data-ui="button" data-appearance="stealth" onClick={downloadCSV} title={`Download ${rollExportData().length.toLocaleString()} rows as CSV`}>CSV</button>
                  <button data-ui="button" data-appearance="stealth" onClick={downloadParquet} title={`Download ${rollExportData().length.toLocaleString()} rows as Parquet`}>Parquet</button>
                </Show>
              </div>
              <div class="toolbar-draw" aria-label="Reference line controls">
                <span class="toolbar-group-title">Draw</span>
                <input data-ui="input" class="w-28" value={rollLineName()} onInput={(e) => setRollLineName(e.currentTarget.value)} placeholder="Line name" aria-label="Line name" />
                <input data-ui="input" class="w-24" value={rollLineValue()} onInput={(e) => setRollLineValue(e.currentTarget.value)} placeholder="Value" inputmode="decimal" aria-label="Line value" />
                <select data-ui="select" class="w-24" value={rollLineTarget()} onChange={(e) => setRollLineTarget(e.currentTarget.value)} aria-label="Line target">
                  <option value="bid">Bid</option>
                  <option value="ask">Ask</option>
                  <option value="iv">IV</option>
                </select>
                <button data-ui="button" data-appearance="outline" onClick={addRollLine}>Add line</button>
              </div>
            </Show>
            <Show when={section() === "multispread"}>
              <div class="toolbar-actions" aria-label="Multi Spread data controls">
                <button data-ui="button" data-appearance="outline" onClick={() => run(loadRollingExpiries)} disabled={busy()}>Expiries</button>
                <button data-ui="button" data-appearance="accent" onClick={() => run(loadMultiSpread)} disabled={busy()}>Plot</button>
                <Show
                  when={msLiveOn()}
                  fallback={<button data-ui="button" data-appearance="outline" onClick={startMsLive} disabled={busy() || !authed()}>Live</button>}
                >
                  <button data-ui="button" data-appearance="outline" onClick={stopMsLive}>Stop</button>
                </Show>
              </div>
            </Show>
          </div>
        </Show>

        <Show when={symbolSearchOpen()}>
          <div class="sym-backdrop" onClick={() => setSymbolSearchOpen(false)}>
            <div class="sym-modal" onClick={(e) => e.stopPropagation()}>
              <div class="sym-header">
                <h2 class="sym-title">Symbol Search</h2>
                <button class="sym-close" onClick={() => setSymbolSearchOpen(false)}>✕</button>
              </div>
              <div class="sym-search-row">
                <svg class="sym-search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.5"/>
                  <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
                <input
                  class="sym-search-input"
                  value={symbolSearchText()}
                  placeholder="NIFTY, BANKNIFTY, RELIANCE, CRUDEOIL…"
                  onInput={(e) => {
                    const value = e.currentTarget.value;
                    setSymbolSearchText(value);
                    if (value.trim()) setSymbolSearchCategory("all");
                  }}
                  autofocus
                />
                <Show when={symbolSearchText()}>
                  <button class="sym-clear" onClick={() => setSymbolSearchText("")}>✕</button>
                </Show>
              </div>
              <div class="sym-tabs">
                <For each={SYMBOL_CATEGORIES}>
                  {(category) => (
                    <button
                      class={`sym-tab${symbolSearchCategory() === category.key ? " active" : ""}`}
                      onClick={() => setSymbolSearchCategory(category.key)}
                    >
                      {category.label}
                    </button>
                  )}
                </For>
              </div>
              <div class="sym-result-list">
                <For each={symbolSearchResults()} fallback={
                  <div class="sym-empty">
                    <span>{scriptStatus()}</span>
                    <small>No matching symbols found</small>
                    <button data-ui="button" data-appearance="outline" onClick={() => run(() => loadCachedScripts(scriptExchange(), true))} disabled={busy()}>
                      {busy() ? "Loading…" : "Retry"}
                    </button>
                  </div>
                }>
                  {(item) => (
                    <button
                      class="sym-row"
                      onClick={() => {
                        const script = preferredScriptForSearchItem(item);
                        setSymbolSearchOpen(false);
                        if (script) run(() => applyScript(script));
                      }}
                    >
                      <span class="sym-badge">{item.badge}</span>
                      <span class="sym-code">{item.title}</span>
                      <span class="sym-name">{item.subtitle}</span>
                      <span class="sym-kind">{categoryLabel(item.category)}</span>
                      <span class="sym-exchange">{item.exchange}</span>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </div>
        </Show>

        {/* ── IV Term Structure section (extracted) ── */}
        <IvTermView />

        {/* ── Gamma Density section (extracted) ── */}
        <GammaView />

        {/* ── OI Profile section (extracted) ── */}
        <OiProfileView />

        {/* ── Max Pain section (extracted) ── */}
        <MaxPainView />

        {/* ── OI Time Series section (extracted) ── */}
        <OiTimeSeriesView />

        {/* ── Vol Surface section (extracted) ── */}
        <VolSurfaceView />

        {/* ── Rolling Straddle section (extracted) ── */}
        <RollingView />

        {/* ── Multi Spread section (extracted) ── */}
        <MultiSpreadView />

        {/* ── Premium Decay section (extracted) ── */}
        <PremiumDecayView />

        <VegaAnalysisView />

        {/* ── Option Chain section (extracted) ── */}
        <ChainView />

        {/* ═══════════════════════════════════════════════════
            GEX / OPTIONS INTELLIGENCE ENGINE
            ═══════════════════════════════════════════════════ */}
        {/* ── OIE / GEX section (extracted) ── */}
        <OieView />

        {/* ── Market section (extracted) ── */}
        <MarketView />
      </main>
    </div>
    </AppProvider>
  );
}

export default App;
