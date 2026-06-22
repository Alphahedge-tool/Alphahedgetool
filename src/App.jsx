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
import { makeChart } from "./lib/chart.js";
import { AppProvider } from "./state/AppContext.jsx";
import { OiTimeSeriesView } from "./views/OiTimeSeriesView.jsx";
import { VolSurfaceView } from "./views/VolSurfaceView.jsx";
import { OiProfileView } from "./views/OiProfileView.jsx";
import { MaxPainView } from "./views/MaxPainView.jsx";
import { IvTermView } from "./views/IvTermView.jsx";
import { GammaView } from "./views/GammaView.jsx";
import { RollingView } from "./views/RollingView.jsx";
import { OieView } from "./views/OieView.jsx";
import { MarketView } from "./views/MarketView.jsx";
import { ChainView } from "./views/ChainView.jsx";

import "./styles.css";
import "./utilities.css";
import "./typography.css";
import "./shell.css";
import "./rolling.css";
import "./chain.css";
import "./iv-term.css";
import "./gamma.css";
import "./oie.css";
import "uplot/dist/uPlot.min.css";

function App() {
  const now = new Date();
  const widgetMode = new URLSearchParams(window.location.search).get("view") === "widget";
  const desktopApi = window.nubraDesktop;
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

        // GEX = gamma * OI * 100 * spot (simplified dealer gamma exposure)
        if (spot) {
          totalGex += (ceGamma * ceOi - peGamma * peOi) * 100 * spot;
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

      // Gamma regime
      const gexBn = totalGex / 1e7; // normalise
      const gammaRegime = gexBn > 5 ? "Compressed (Positive GEX)" : gexBn < -5 ? "Amplifying (Negative GEX)" : "Neutral";

      // Expected move (1-sigma, simplified)
      const expectedMovePct = atmIv != null ? +(atmIv / Math.sqrt(252) * 100).toFixed(2) : null;

      // OI momentum — net OI change
      const totalCeOiChg = strikeRows.reduce((s,r)=>s+r.ceOiChange,0);
      const totalPeOiChg = strikeRows.reduce((s,r)=>s+r.peOiChange,0);
      const oiMomentum = totalCeOiChg + totalPeOiChg;

      // Dealer positioning
      const dealerPositioning = gexBn > 2 ? "Stabilising" : gexBn < -2 ? "Amplifying" : "Neutral";

      // Market bias
      let bullScore = 0, bearScore = 0;
      const signals = [];

      // PCR signal
      if (pcr != null) {
        if (pcr > 1.3)      { bullScore += 3; signals.push({ direction:"Bullish", category:"OI",   name:"PCR Bullish (>1.3)",    strength: Math.min(10, Math.round(pcr*2)) }); }
        else if (pcr < 0.7) { bearScore += 3; signals.push({ direction:"Bearish", category:"OI",   name:"PCR Bearish (<0.7)",    strength: Math.min(10, Math.round((1/pcr)*2)) }); }
        else                {                  signals.push({ direction:"Neutral", category:"OI",   name:"PCR Neutral (0.7–1.3)", strength: 3 }); }
      }

      // GEX signal
      if (gexBn > 5)       { bullScore += 2; signals.push({ direction:"Bullish", category:"GEX",  name:"Positive GEX (Pinning)", strength: Math.min(10,Math.round(gexBn)) }); }
      else if (gexBn < -5) { bearScore += 2; signals.push({ direction:"Bearish", category:"GEX",  name:"Negative GEX (Volatile)",strength: Math.min(10,Math.round(-gexBn)) }); }

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
          gex: totalGex != null ? +(totalGex/1e7).toFixed(2) + "Bn" : null,
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
  const [rollSeriesVisibility, setRollSeriesVisibility] = createSignal({
    bid: localStorage.getItem("nubraRollSeriesBid") !== "0",
    ask: localStorage.getItem("nubraRollSeriesAsk") !== "0",
    iv: localStorage.getItem("nubraRollSeriesIv") !== "0"
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

  // ── Chain Monitor Engine ──
  const [chainMonitor, setChainMonitor] = createSignal(false);
  const [chainAlerts, setChainAlerts] = createSignal([]);
  let chainMonitorState = null;

  function resetChainMonitor() {
    chainMonitorState = {
      prevOiByStrike: new Map(),
      prevTotalCeOi: 0,
      prevTotalPeOi: 0,
      tickCount: 0,
      cooldownMs: 45000,
      lastAlertTs: {},
      oiChangeThresholdPct: 10,
      heavyOiThresholdPct: 15,
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

    chainMonitorState.tickCount += 1;
    if (chainMonitorState.tickCount < 3) {
      for (const leg of [...ce, ...pe]) {
        const sp = Number(leg.sp ?? leg.strike_price ?? leg.strike);
        const side = ce.includes(leg) ? "CE" : "PE";
        const oi = Number(leg.oi ?? leg.open_interest ?? 0);
        if (Number.isFinite(sp) && Number.isFinite(oi)) chainMonitorState.prevOiByStrike.set(`${sp}|${side}`, oi);
      }
      chainMonitorState.prevTotalCeOi = ce.reduce((s, l) => s + (Number(l.oi ?? l.open_interest) || 0), 0);
      chainMonitorState.prevTotalPeOi = pe.reduce((s, l) => s + (Number(l.oi ?? l.open_interest) || 0), 0);
      return;
    }

    const fmt = (v) => {
      if (v >= 10000000) return `${(v / 10000000).toFixed(2)}Cr`;
      if (v >= 100000) return `${(v / 100000).toFixed(1)}L`;
      if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
      return String(Math.round(v));
    };
    const fmtStrike = (sp) => chainStrikeInRupees(sp, chain) ?? number.format(sp);

    const totalCeOi = ce.reduce((s, l) => s + (Number(l.oi ?? l.open_interest) || 0), 0);
    const totalPeOi = pe.reduce((s, l) => s + (Number(l.oi ?? l.open_interest) || 0), 0);

    // Per-strike OI change detection
    const bigChanges = [];
    for (const leg of [...ce, ...pe]) {
      const sp = Number(leg.sp ?? leg.strike_price ?? leg.strike);
      const side = ce.includes(leg) ? "CE" : "PE";
      const oi = Number(leg.oi ?? leg.open_interest ?? 0);
      const key = `${sp}|${side}`;
      const prev = chainMonitorState.prevOiByStrike.get(key) || 0;
      if (Number.isFinite(sp) && Number.isFinite(oi)) chainMonitorState.prevOiByStrike.set(key, oi);
      if (prev > 0 && oi > 0) {
        const chgPct = ((oi - prev) / prev) * 100;
        if (Math.abs(chgPct) >= chainMonitorState.oiChangeThresholdPct) {
          bigChanges.push({ sp, side, oi, prev, chgPct });
        }
      }
    }

    // Alert: significant OI addition at a strike
    const additions = bigChanges.filter((c) => c.chgPct > 0).sort((a, b) => b.chgPct - a.chgPct);
    if (additions.length) {
      const top = additions[0];
      sendChainAlert(`oi-add-${top.sp}-${top.side}`,
        `OI Addition: ${fmtStrike(top.sp)} ${top.side}`,
        `+${top.chgPct.toFixed(1)}% OI (${fmt(top.prev)} → ${fmt(top.oi)})`
      );
    }

    // Alert: significant OI unwinding at a strike
    const unwinds = bigChanges.filter((c) => c.chgPct < 0).sort((a, b) => a.chgPct - b.chgPct);
    if (unwinds.length) {
      const top = unwinds[0];
      sendChainAlert(`oi-unwind-${top.sp}-${top.side}`,
        `OI Unwinding: ${fmtStrike(top.sp)} ${top.side}`,
        `${top.chgPct.toFixed(1)}% OI (${fmt(top.prev)} → ${fmt(top.oi)})`
      );
    }

    // Alert: heaviest OI strike (CE and PE separately)
    let maxCe = null, maxPe = null;
    for (const leg of ce) {
      const oi = Number(leg.oi ?? leg.open_interest ?? 0);
      if (!maxCe || oi > maxCe.oi) maxCe = { sp: Number(leg.sp ?? leg.strike_price ?? leg.strike), oi };
    }
    for (const leg of pe) {
      const oi = Number(leg.oi ?? leg.open_interest ?? 0);
      if (!maxPe || oi > maxPe.oi) maxPe = { sp: Number(leg.sp ?? leg.strike_price ?? leg.strike), oi };
    }

    // Alert: PCR shift (total PE OI / total CE OI)
    if (totalCeOi > 0 && chainMonitorState.prevTotalCeOi > 0) {
      const pcr = totalPeOi / totalCeOi;
      const prevPcr = chainMonitorState.prevTotalPeOi / chainMonitorState.prevTotalCeOi;
      const pcrShift = Math.abs(pcr - prevPcr);
      if (pcrShift >= 0.08) {
        const dir = pcr > prevPcr ? "Bullish" : "Bearish";
        sendChainAlert("pcr-shift",
          `PCR Shift: ${dir}`,
          `PCR ${prevPcr.toFixed(2)} → ${pcr.toFixed(2)} (PE OI: ${fmt(totalPeOi)}, CE OI: ${fmt(totalCeOi)})`
        );
      }
    }

    // Alert: heavy OI concentration (one strike has >N% of total OI on that side)
    if (maxCe && totalCeOi > 0) {
      const pct = (maxCe.oi / totalCeOi) * 100;
      if (pct >= chainMonitorState.heavyOiThresholdPct) {
        sendChainAlert(`heavy-ce-${maxCe.sp}`,
          `Heavy CE OI: ${fmtStrike(maxCe.sp)}`,
          `${pct.toFixed(1)}% of total CE OI (${fmt(maxCe.oi)} / ${fmt(totalCeOi)})`
        );
      }
    }
    if (maxPe && totalPeOi > 0) {
      const pct = (maxPe.oi / totalPeOi) * 100;
      if (pct >= chainMonitorState.heavyOiThresholdPct) {
        sendChainAlert(`heavy-pe-${maxPe.sp}`,
          `Heavy PE OI: ${fmtStrike(maxPe.sp)}`,
          `${pct.toFixed(1)}% of total PE OI (${fmt(maxPe.oi)} / ${fmt(totalPeOi)})`
        );
      }
    }

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
  let importFileRef;

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
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const [oiTsStartDate, setOiTsStartDate] = createSignal(todayStr());
  const [oiTsEndDate, setOiTsEndDate] = createSignal(todayStr());

  // ── Vol Surface signals ──
  // uses existing ivTermPoints + smileSurfaces — no extra signals needed

  let priceChartHost;
  let rollChartHost;
  let chainSearchHost;
  let chainExpiryMenuHost;
  let chainNavHost;
  let ivTermChartHost;
  let ivTermChart;
  let smileChartHost;
  let smileChart;
  let gammaIntradayHost;
  let gammaIntradayChart;
  let gammaExpiryHost;
  let gammaExpiryChart;
  let priceChart;
  let candleSeries;
  let rollChart;
  let rollBidSeries;
  let rollAskSeries;
  let rollIvSeries;
  let rollChartLines = { bid: [], ask: [], iv: [] };
  let rollChartData = [[], [], [], []];
  let rollReferenceCount = 0;
  let rollManualScales = { x: null, price: null, iv: null };
  const rollPriceLines = new Map();
  let autoChainSearchKey = "";
  let rollLiveSocket = null;
  let rollLiveContext = null;
  let rollLiveFlushTimer = null;
  let rollCutoffTimer = null;
  let chainLiveSocket = null;
  let chainCutoffTimer = null;
  let marketStripSocket = null;
  let marketStripReconnectTimer = null;
  let marketStripCutoffTimer = null;

  const [rollLive, setRollLive] = createSignal(false);

  const authed = createMemo(() => Boolean(token().trim() && deviceId().trim()));
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
    const optionLot = [
      ...(Array.isArray(chainData()?.ce) ? chainData().ce : []),
      ...(Array.isArray(chainData()?.pe) ? chainData().pe : [])
    ]
      .map((option) => rawNumber(option?.lot_size ?? option?.lotSize ?? option?.market_lot ?? option?.marketLot))
      .find((value) => value != null && value > 0);
    return {
      marketLot: rawNumber(
        chainData()?.market_lot ??
        chainData()?.marketLot ??
        chainData()?.lot_size ??
        chainData()?.lotSize
      ) ?? optionLot ?? refLot ?? null,
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

    // ATM filter — reuse parseChainAtmFilter; "full" shows all strikes
    const rangeFilter = parseChainAtmFilter(gammaRange(), allRows, atmRaw);
    const rows = rangeFilter
      ? allRows.filter((r) => Number(r.strike) >= rangeFilter.min && Number(r.strike) <= rangeFilter.max)
      : allRows;

    const chain = [];
    let maxIntraday = 0, maxExpiry = 0;
    let peakIntradayStrike = null, peakExpiryStrike = null;
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

      if (densityExpiry > maxExpiry) { maxExpiry = densityExpiry; peakExpiryStrike = strike; }
      if (densityIntraday > maxIntraday) { maxIntraday = densityIntraday; peakIntradayStrike = strike; }

      chain.push({ strike, iv, ce_oi: ceOi, pe_oi: peOi, density_intraday: densityIntraday, density_expiry: densityExpiry });
    }

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
      chain,
    };
  });

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
    const changeText = change == null ? "--" : formatCompact(Math.abs(change));
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
        return { value: pickOptionValue(option, ["volume", "vol", "traded_volume", "tradedVolume"]), compact: true };
      case "oi":
        return {
          value: pickOptionValue(option, ["oi", "open_interest", "openInterest"]),
          compact: true,
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
  }

  function queueChartResize() {
    requestAnimationFrame(() => {
      resizeVisibleCharts();
      requestAnimationFrame(resizeVisibleCharts);
    });
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
    if (!authed()) return;
    if (!isMarketHours()) { setMarketStripStatus("Market closed (after 3:30 PM)"); return; }
    const ms = msUntilMarketClose();
    if (ms > 0) marketStripCutoffTimer = setTimeout(() => { stopMarketStripLive(); setMarketStripStatus("Market closed (after 3:30 PM)"); }, ms);
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
          { exchange: "BSE", symbols: ["SENSEX"] }
        ]
      }));
      setMarketStripStatus("Connecting live indices");
    };
    socket.onmessage = (event) => {
      if (!isMarketHours()) { stopMarketStripLive(); setMarketStripStatus("Market closed (after 3:30 PM)"); return; }
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
        setMarketStrip((items) => items.map((item) => {
          const itemName = String(item.instrument || item.label).toUpperCase().replace(/[^A-Z0-9]/g, "");
          if (itemName !== tickName || (tickExchange && item.exchange !== tickExchange)) return item;
          return {
            ...item,
            price: tick.index_value ?? tick.indexValue ?? item.price,
            prevClose: tick.prev_close ?? tick.prevClose ?? item.prevClose,
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
      if (authed() && isMarketHours()) marketStripReconnectTimer = window.setTimeout(startMarketStripLive, 3000);
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
      upColor: "#21d19f",
      downColor: "#ff5d67",
      borderUpColor: "#21d19f",
      borderDownColor: "#ff5d67",
      wickUpColor: "#21d19f",
      wickDownColor: "#ff5d67"
    };
    candleSeries = priceChart.addCandlestickSeries
      ? priceChart.addCandlestickSeries(options)
      : priceChart.addSeries(window.LightweightCharts.CandlestickSeries, options);
    queueChartResize();
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

  function handleChainLiveTick(chain) {
    const next = normalizeLiveChain(chain);
    if (!next) return;
    const rowCount = chainRowCount(next);
    if (!rowCount) return;
    analyzeChainTick(next);
    setChainData(next);
    if (next.expiry) setChainExpiry(String(next.expiry));
    setChainStatus(`Live · ${rowCount} strikes`);
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
      : [{ type: "OPT", fields: ["l1bid", "l1ask", "iv_bid", "iv_ask"] }];
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
      for (let i = 4; i < data.length; i += 1) {
        const line = rollDrawnLines()[i - 4];
        data[i].push(line ? line.value : null);
      }
    }
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
    const start = {
      bid: Number.isFinite(rollLiveContext.lastValues.bid) ? rollLiveContext.lastValues.bid : target.bid,
      ask: Number.isFinite(rollLiveContext.lastValues.ask) ? rollLiveContext.lastValues.ask : target.ask,
      iv: Number.isFinite(rollLiveContext.lastValues.iv) ? rollLiveContext.lastValues.iv : target.ivMid
    };
    const baseData = rollChartData.map((series) => series.slice());
    const started = performance.now();
    const duration = 200;

    if (rollLiveContext.frames.live) cancelAnimationFrame(rollLiveContext.frames.live);

    const step = (now) => {
      if (!rollLiveContext || !rollChart || !isMarketHours(rollExchange())) return;
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const bid = start.bid + (target.bid - start.bid) * eased;
      const ask = start.ask + (target.ask - start.ask) * eased;
      const iv = target.ivMid == null || !Number.isFinite(start.iv)
        ? target.ivMid
        : start.iv + (target.ivMid - start.iv) * eased;
      drawRollPreview(withPreviewPoint(baseData, time, bid, ask, iv));
      if (progress < 1) {
        rollLiveContext.frames.live = requestAnimationFrame(step);
        return;
      }
      rollLiveContext.frames.live = null;
      rollLiveContext.lastValues.bid = target.bid;
      rollLiveContext.lastValues.ask = target.ask;
      if (target.ivMid != null) rollLiveContext.lastValues.iv = target.ivMid;
      commit();
    };

    rollLiveContext.frames.live = requestAnimationFrame(step);
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
    for (let offset = -2; offset <= 2; offset++) {
      const strike = nearestStrike(atm + offset * step, strikes, step);
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
      setRollExportData((rows) => [...rows, nextRow]);
      setRollStats((prev) => ({
        ...prev,
        spot: rupee.format(spot),
        strike: number.format(best.strike),
        bid: rupee.format(best.bid),
        ask: rupee.format(best.ask),
        iv: best.ivMid != null ? `${best.ivMid.toFixed(1)}%` : prev.iv,
        points: String((Number(prev.points) || 0) + 1),
        meta: `${rollSymbol().trim().toUpperCase()} ${rollExpiry()} | live 1-second animated ${best.hasBook ? "bid/ask" : "LTP fallback"} | ${rollExchange()}`
      }));
      setRollStatus(best.hasBook ? "Live animated" : "Live animated LTP");
    });
  }

  function scheduleRollLiveUpdate(receivedAtMs) {
    if (!isMarketHours(rollExchange())) { stopRollLive(); setRollStatus("Market closed"); return; }
    if (rollLiveFlushTimer) return;
    rollLiveFlushTimer = setTimeout(() => {
      rollLiveFlushTimer = null;
      if (!isMarketHours(rollExchange())) { stopRollLive(); setRollStatus("Market closed"); return; }
      updateRollLiveSnapshot(receivedAtMs || Date.now());
    }, 250);
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
    if (rollLiveFlushTimer) {
      clearTimeout(rollLiveFlushTimer);
      rollLiveFlushTimer = null;
    }
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
    if (target === "ask") return "#ffb15c";
    if (target === "iv") return "#22d3ee";
    return "#21d19f";
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
    rollBidSeries = addLine({ color: "#21d19f", lineWidth: 2, title: "Bid", priceScaleId: "right" });
    rollAskSeries = addLine({ color: "#ffb15c", lineWidth: 2, title: "Ask", priceScaleId: "right" });

    // IV on LEFT axis (% value)
    rollIvSeries = addLine({
      color: "#22d3ee",
      lineWidth: 1,
      lineStyle: 0,           // solid
      title: "IV %",
      priceScaleId: "left",
      priceFormat: { type: "custom", formatter: (p) => `${p.toFixed(1)}%`, minMove: 0.01 }
    });

    queueChartResize();
  }

  function rollChartSeriesConfig() {
    const base = [
      {},
      { label: "Bid", scale: "price", show: rollSeriesVisibility().bid, stroke: "#21d19f", width: 1.6, points: { show: false } },
      { label: "Ask", scale: "price", show: rollSeriesVisibility().ask, stroke: "#ffb15c", width: 1.6, points: { show: false } },
      { label: "IV %", scale: "iv", show: rollSeriesVisibility().iv, stroke: "#22d3ee", width: 1.2, points: { show: false } }
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
  }

  function scaleRangeChanged(current, saved) {
    if (!current || !saved) return false;
    return Math.abs(current.min - saved.min) > 1e-9 || Math.abs(current.max - saved.max) > 1e-9;
  }

  function setRollScale(key, range, manual = false) {
    if (!rollChart || !range) return;
    rollChart.setScale(key, range);
    if (manual) rememberRollScale(key, range);
  }

  function applyRollManualScales() {
    if (!rollChart) return;
    for (const key of ["x", "price", "iv"]) {
      const range = rollManualScales[key];
      if (range) rollChart.setScale(key, range);
    }
  }

  function scheduleApplyRollManualScales() {
    requestAnimationFrame(() => {
      applyRollManualScales();
      requestAnimationFrame(applyRollManualScales);
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
            { cls: "roll-last-bid", key: "bid", color: "#21d19f", series: 1, scale: "price", side: "right" },
            { cls: "roll-last-ask", key: "ask", color: "#ffb15c", series: 2, scale: "price", side: "right" },
            { cls: "roll-last-iv", key: "iv", color: "#22d3ee", series: 3, scale: "iv", side: "left" },
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
          if (!Number.isFinite(time)) { tooltip.hidden = true; return; }
          const parts = [`<span class="roll-tip-time">${formatIstTime(time)}</span>`];
          if (rollSeriesVisibility().bid && Number.isFinite(bid)) parts.push(`<span style="color:#21d19f">Bid: ${rupee.format(bid)}</span>`);
          if (rollSeriesVisibility().ask && Number.isFinite(ask)) parts.push(`<span style="color:#ffb15c">Ask: ${rupee.format(ask)}</span>`);
          if (rollSeriesVisibility().iv && Number.isFinite(iv)) parts.push(`<span style="color:#22d3ee">IV: ${iv.toFixed(2)}%</span>`);
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
          ivLabel = makeAxisLabel("#22d3ee");
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
          show: true,
          class: "roll-axis-x",
          size: 44,
          gap: 6,
          font: axisFont,
          stroke: "#c9cdd3",
          border: { show: true, stroke: "rgba(255,255,255,0.24)", width: 1 },
          grid: { show: true, stroke: "rgba(255,255,255,0.06)", width: 1 },
          ticks: { show: true, stroke: "rgba(255,255,255,0.18)", width: 1, size: 5 },
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
          grid: { show: true, stroke: "rgba(255,255,255,0.06)", width: 1 },
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
    const data = [
      x,
      x.map((time) => bidByTime.get(time) ?? null),
      x.map((time) => askByTime.get(time) ?? null),
      x.map((time) => ivByTime.get(time) ?? null)
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
      for (let offset = -2; offset <= 2; offset++) {
        requiredStrikes.add(nearestStrike(atm + offset * step, strikes, step));
      }
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
    if (!optionNames.length) throw new Error("No CE/PE symbols found around ATM +/-2.");

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
      for (let offset = -2; offset <= 2; offset++) {
        const strike = nearestStrike(atm + offset * step, strikes, step);
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
      meta: `${sym} ${rollExpiry()} | ${resolvedInterval} quotes | ${requiredStrikes.size} strikes checked | ${rollExchange()}`
    });
    setRollExportData(selected);
    setRollStatus("Ready");
    if (!rollLiveSocket) startRollLive();
  }

  function downloadCSV() {
    const rows = rollExportData();
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
    const rows = rollExportData();
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
    };
    document.addEventListener("mousedown", closeChainSearch);
    window.addEventListener("resize", resizeVisibleCharts);
    const removeWidgetStateListener = widgetMode
      ? desktopApi?.onWidgetMaximizedChanged?.(setWidgetMaximized)
      : null;
    queueChartResize();
    onCleanup(() => {
      document.removeEventListener("mousedown", closeChainSearch);
      removeWidgetStateListener?.();
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
      legend: { itemStyle: { color: "#b4b4c8", fontSize: "11px" }, itemHoverStyle: { color: "#f0f0f4" } },
      xAxis: {
        categories,
        lineColor: "rgba(255,255,255,0.12)",
        tickColor: "rgba(255,255,255,0.12)",
        labels: { style: { color: "#8c8ca0", fontSize: "10px" } },
        title: { text: "Expiry", style: { color: "#8c8ca0" } }
      },
      yAxis: {
        title: { text: "Implied Volatility (%)", style: { color: "#8c8ca0" } },
        labels: { format: "{value:.1f}%", style: { color: "#8c8ca0", fontSize: "10px" } },
        gridLineColor: "rgba(255,255,255,0.06)"
      },
      tooltip: {
        shared: true,
        useHTML: true,
        backgroundColor: "rgba(22,22,24,0.98)",
        borderColor: "rgba(255,255,255,0.14)",
        style: { color: "#f0f0f4" },
        formatter: function () {
          const point = points[this.points?.[0]?.point?.index ?? this.point?.index ?? 0];
          const seriesRows = (this.points || []).map((item) => `<div><span style="color:${item.color}">●</span> ${item.series.name}: <b>${Number(item.y).toFixed(2)}%</b></div>`).join("");
          return `<b>${point?.expiry || ""}</b><br/><span style="color:#8c8ca0">DTE ${point?.dte ?? "--"} · ATM ${number.format(point?.strike || 0)}</span>${seriesRows}`;
        }
      },
      plotOptions: {
        series: { animation: false, marker: { enabled: true, radius: 4 }, lineWidth: 2 },
        spline: { states: { hover: { lineWidth: 3 } } }
      },
      series: [
        { name: "ATM IV", data: points.map((point) => point.atmIv), color: "#4f7cff", lineWidth: 3, zIndex: 3 },
        { name: "CE IV", data: points.map((point) => point.ceIv), color: "#05b878", dashStyle: "ShortDash" },
        { name: "PE IV", data: points.map((point) => point.peIv), color: "#f04f4f", dashStyle: "ShortDash" }
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
      legend: { itemStyle: { color: "#b4b4c8", fontSize: "11px" }, itemHoverStyle: { color: "#f0f0f4" } },
      xAxis: {
        type: "linear",
        title: { text: "Strike", style: { color: "#8c8ca0" } },
        labels: { style: { color: "#8c8ca0", fontSize: "10px" } },
        lineColor: "rgba(255,255,255,0.12)",
        tickColor: "rgba(255,255,255,0.12)",
        plotLines: Number.isFinite(surface.atmStrike) ? [{ value: surface.atmStrike, color: "#4f7cff", width: 1, dashStyle: "ShortDash", label: { text: "ATM", style: { color: "#93b4ff", fontSize: "9px" } } }] : []
      },
      yAxis: {
        title: { text: "Implied Volatility (%)", style: { color: "#8c8ca0" } },
        labels: { format: "{value:.1f}%", style: { color: "#8c8ca0", fontSize: "10px" } },
        gridLineColor: "rgba(255,255,255,0.06)"
      },
      tooltip: {
        shared: true,
        valueDecimals: 2,
        valueSuffix: "%",
        backgroundColor: "rgba(22,22,24,0.98)",
        borderColor: "rgba(255,255,255,0.14)",
        style: { color: "#f0f0f4" }
      },
      plotOptions: { series: { animation: false, marker: { enabled: true, radius: 3 }, lineWidth: 2 } },
      series: [
        { name: "Call IV", data: surface.rows.filter((row) => Number.isFinite(row.ceIv)).map((row) => [row.strike, row.ceIv]), color: "#05b878" },
        { name: "Put IV", data: surface.rows.filter((row) => Number.isFinite(row.peIv)).map((row) => [row.strike, row.peIv]), color: "#f04f4f" }
      ]
    });
    onCleanup(() => {
      smileChart?.destroy();
      smileChart = null;
    });
  });

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

    return Highcharts.chart(host, {
      chart: { type: "spline", backgroundColor: "transparent", animation: false, spacing: [16, 16, 10, 10] },
      title: { text: undefined },
      credits: { enabled: false },
      legend: { itemStyle: { color: "#b4b4c8", fontSize: "11px" }, itemHoverStyle: { color: "#f0f0f4" } },
      xAxis: {
        min: minK, max: maxK,
        plotBands, plotLines,
        lineColor: "rgba(255,255,255,0.12)", tickColor: "rgba(255,255,255,0.12)",
        labels: { style: { color: "#8c8ca0", fontSize: "10px" }, formatter: function () { return number.format(this.value); } },
        title: { text: "Strike / Price", style: { color: "#8c8ca0" } }
      },
      yAxis: {
        min: 0, max: 1.08, title: { text: undefined },
        labels: { style: { color: "#8c8ca0", fontSize: "10px" } },
        gridLineColor: "rgba(255,255,255,0.06)"
      },
      tooltip: {
        shared: true, useHTML: true,
        backgroundColor: "rgba(22,22,24,0.98)", borderColor: "rgba(255,255,255,0.14)",
        style: { color: "#f0f0f4" },
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
          name: "Convexity Zone", data: convexity, color: "#22c55e",
          fillOpacity: 0.14, type: "areaspline", lineWidth: 2, zIndex: 1
        },
        {
          name: "Density (Γ×OI)", data: densitySeries, color: "#f59e0b",
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

  // ── Shared store for extracted view components (see src/state/AppContext.jsx) ──
  const store = {
    // signals (read)
    section, busy, authed,
    chainData, chainSymbol, chainExchange, chainExpiry, chainStatus, chainLive,
    oiTsStrikes, oiTsHistory, oiTsStartDate, oiTsEndDate, oiTsRange,
    smileSurfaces, ivTermSymbol, ivTermExchange, ivTermStatus,
    ivTermSummary, ivTermPoints, smileExpiry, selectedSmile,
    oiProfileRange, oiProfile, maxPain,
    chainExpiries, gammaRange, chainDerivedStats, gammaDensity, chainSearchRows,
    rollStats, rollStatus, rollDrawnLines, rollWindowMode, rollSeriesVisibility,
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
    registerRollChartHost: (el) => { rollChartHost = el; initRollChart(); queueChartResize(); },
    registerPriceChartHost: (el) => { priceChartHost = el; initPriceChart(); queueChartResize(); },
    registerChainExpiryMenuHost: (el) => { chainExpiryMenuHost = el; },
    // actions
    run, loadOiTsSeries, startChainLive, stopChainLive, loadIvTermStructure, loadOptionChain,
    loadChainSearchRows, removeRollLine, toggleRollSeries,
    straddleMonitor, setStraddleMonitor, straddleAlerts, setStraddleAlerts,
    chainMonitor, setChainMonitor, chainAlerts, setChainAlerts,
    loadOieExpiries, loadOie, loadSpotPrice, loadPriceChart, loadOptionChainExpiries,
  };

  return (
    <AppProvider store={store}>
    <div data-theme="alphahedge" class={`app-root ${widgetMode ? "desktop-widget-mode" : ""}`} style="background:var(--bg-main);color:var(--text-primary)">
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
      <header class="app-shell-header">
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
                    <span class="mkt-exch">{item.exchange}</span>
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
        </div>

        <div data-ui="tabs" class="analysis-nav-tabs shrink-0" data-activeid={section()} aria-label="Analysis views">
          <button data-ui="tab" id="rolling" onClick={() => setSection("rolling")}>
            Straddle
          </button>
          <div class="chain-nav-dropdown" ref={(el) => { chainNavHost = el; }}>
            <button
              data-ui="tab"
              id="chain"
              type="button"
              aria-haspopup="menu"
              aria-expanded={chainNavOpen()}
              aria-selected={["chain","iv-term","gamma","oi-profile","max-pain","oi-timeseries","vol-surface"].includes(section())}
              onClick={() => setChainNavOpen((open) => !open)}
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
                <button type="button" role="menuitem" class={section() === "vol-surface" ? "active" : ""} onClick={() => { setSection("vol-surface"); setChainNavOpen(false); }}>
                  <span>Vol Surface</span>
                  <small>IV heatmap across strikes & expiries</small>
                </button>
              </div>
            </Show>
          </div>
          <button data-ui="tab" id="market" onClick={() => setSection("market")}>
            Chart
          </button>
          <button data-ui="tab" id="gex" onClick={() => setSection("gex")} class="oie-nav-tab">
            <span class="oie-nav-dot" />
            Intelligence
          </button>
        </div>

        <div class="app-shell-actions">
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
          <button data-ui="button" data-appearance="outline" onClick={() => setDrawerOpen(true)}>
            Session
          </button>
          <span data-ui="badge" class="h-8 shrink-0 px-3" data-appearance={authed() ? "accent" : "neutral"}>
            <span class={`h-1.5 w-1.5 rounded-full ${authed() ? "bg-emerald-400" : "bg-amber-400"}`}></span>
            <span>{authed() ? "Connected" : "No session"}</span>
          </span>
        </div>
      </header>
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
          <div class="flex items-center gap-2.5 px-5 py-2 text-[11px] font-medium" style="background:rgba(239,68,68,0.07);border-bottom:1px solid rgba(239,68,68,0.18);color:#fca5a5">
            <span class="shrink-0 opacity-60">⚠</span>
            {toast()}
          </div>
        </Show>

        <Show when={!widgetMode && !["gex","chain","gamma","oi-profile","max-pain","oi-timeseries","vol-surface"].includes(section())}>
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
