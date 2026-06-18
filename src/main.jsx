import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { render } from "solid-js/web";
import "./styles.css";

// Writes rows as a JSON file (saved with .parquet extension).
// Each row is a plain object; field names match the CSV headers.
function writeParquet(_columns, rows) {
  return new TextEncoder().encode(JSON.stringify(rows));
}

// Reads a JSON file written by writeParquet above.
function readParquet(buffer) {
  const text = new TextDecoder().decode(buffer);
  const rows = JSON.parse(text);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("No data rows found in file.");
  return rows;
}

const rupee = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2
});
const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const compactNumber = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 });

function toRupees(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n / 100 : null;
}

function pointMs(point) {
  const ts = Number(point?.ts ?? point?.timestamp);
  return Number.isFinite(ts) ? Math.floor(ts / 1_000_000) : null;
}

function pointNumber(point, rupeeValue = false) {
  const raw = point?.v ?? point?.value;
  const value = rupeeValue ? toRupees(raw) : Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function formatMoney(value) {
  const n = toRupees(value);
  return n == null ? "--" : rupee.format(n);
}

function formatStrike(value) {
  const n = toRupees(value);
  return n == null ? "--" : number.format(n);
}

function formatPlain(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "--";
}

function formatCompact(value) {
  const n = Number(value);
  return Number.isFinite(n) ? compactNumber.format(n) : "--";
}

function formatIndexValue(value) {
  const n = toRupees(value);
  return n == null ? "--" : number.format(n);
}

function formatPercent(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(2)}%` : "--";
}

function pickOptionValue(option, keys) {
  if (!option) return undefined;
  for (const key of keys) {
    if (option[key] != null) return option[key];
  }
  return undefined;
}

const CHAIN_COLUMNS = [
  { key: "ltp", label: "LTP" },
  { key: "iv", label: "IV (%)" },
  { key: "delta", label: "Delta" },
  { key: "gamma", label: "Gamma" },
  { key: "theta", label: "Theta" },
  { key: "vega", label: "Vega" },
  { key: "volume", label: "Volume" },
  { key: "oi", label: "OI" }
];

const CALL_COLUMN_ORDER = ["volume", "oi", "vega", "theta", "gamma", "delta", "iv", "ltp"];
const PUT_COLUMN_ORDER = ["ltp", "iv", "delta", "gamma", "theta", "vega", "volume", "oi"];
const DEFAULT_CHAIN_COLUMNS = Object.fromEntries(CHAIN_COLUMNS.map((column) => [column.key, true]));
const MARKET_STRIP_SYMBOLS = [
  { label: "NIFTY", instrument: "NIFTY", exchange: "NSE" },
  { label: "BANKNIFTY", instrument: "BANKNIFTY", exchange: "NSE" },
  { label: "SENSEX", instrument: "SENSEX", exchange: "BSE" },
  { label: "INDIA VIX", instrument: "INDIA VIX", instruments: ["INDIA VIX", "INDIAVIX", "INDIA_VIX"], exchange: "NSE" }
];

function toLocalInput(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function todayAt(hour, minute) {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date;
}

function fromLocalInput(value) {
  return value ? new Date(value).toISOString() : null;
}

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

function deviceIdForPhone(phone) {
  return `Nubra-OSS-${digits(phone)}`;
}

function tvTime(ms) {
  return Math.floor(ms / 1000);
}

function formatIstTime(time) {
  const seconds = typeof time === "number" ? time : Date.UTC(time.year, time.month - 1, time.day) / 1000;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(seconds * 1000));
}

function extractSymbolData(data, symbol) {
  const result = data?.result?.[0]?.values || [];
  for (const entry of result) {
    if (entry[symbol]) return entry[symbol];
    const firstKey = Object.keys(entry)[0];
    if (firstKey) return entry[firstKey];
  }
  return null;
}

function makeChart(host, options = {}) {
  if (!window.LightweightCharts || !host) return null;
  return window.LightweightCharts.createChart(host, {
    layout: {
      background: { type: "solid", color: "#080b10" },
      textColor: "#9ca3af",
      fontFamily: "Inter, system-ui, sans-serif"
    },
    grid: {
      vertLines: { color: "rgba(255,255,255,0.045)" },
      horzLines: { color: "rgba(255,255,255,0.045)" }
    },
    rightPriceScale: {
      borderColor: "rgba(255,255,255,0.09)",
      scaleMargins: { top: 0.1, bottom: 0.12 }
    },
    timeScale: {
      borderColor: "rgba(255,255,255,0.09)",
      timeVisible: true,
      secondsVisible: true,
      rightOffset: 8,
      barSpacing: 7,
      tickMarkFormatter: formatIstTime
    },
    crosshair: {
      mode: window.LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: "#ff8a3d", style: 2, width: 1 },
      horzLine: { color: "#ff8a3d", style: 2, width: 1 }
    },
    localization: {
      locale: "en-IN",
      timeFormatter: formatIstTime
    },
    ...options
  });
}

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
  const [busy, setBusy] = createSignal(false);
  const [toast, setToast] = createSignal("");
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const [marketStrip, setMarketStrip] = createSignal(MARKET_STRIP_SYMBOLS.map((item) => ({
    ...item,
    price: null,
    change: null,
    ok: false
  })));
  const [marketStripStatus, setMarketStripStatus] = createSignal("Waiting for session");

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
  let importFileRef;

  const [chainSymbol, setChainSymbol] = createSignal("NIFTY");
  const [chainExchange, setChainExchange] = createSignal("NSE");
  const [chainExpiry, setChainExpiry] = createSignal("");
  const [chainExpiries, setChainExpiries] = createSignal([]);
  const [chainStatus, setChainStatus] = createSignal("Idle");
  const [chainData, setChainData] = createSignal(null);
  const [chainFilterMode, setChainFilterMode] = createSignal("atm");
  const [chainAtmRange, setChainAtmRange] = createSignal("");
  const [chainPremiumMin, setChainPremiumMin] = createSignal("");
  const [chainPremiumMax, setChainPremiumMax] = createSignal("");
  const [chainColumnMenuOpen, setChainColumnMenuOpen] = createSignal(false);
  const [chainVisibleColumns, setChainVisibleColumns] = createSignal({ ...DEFAULT_CHAIN_COLUMNS });
  const [chainLive, setChainLive] = createSignal(false);

  let priceChartHost;
  let rollChartHost;
  let priceChart;
  let candleSeries;
  let rollChart;
  let rollBidSeries;
  let rollAskSeries;
  let rollIvSeries;
  const rollPriceLines = new Map();
  let autoRollLoadedKey = "";
  let autoChainLoadedKey = "";
  let rollLiveSocket = null;
  let rollLiveContext = null;
  let rollLiveFlushTimer = null;
  let chainLiveSocket = null;

  const [rollLive, setRollLive] = createSignal(false);

  const authed = createMemo(() => Boolean(token().trim() && deviceId().trim()));
  const optionRows = createMemo(() => {
    const chain = chainData();
    if (!chain) return [];
    const byStrike = new Map();
    for (const ce of Array.isArray(chain.ce) ? chain.ce : []) {
      const strike = Number(ce.sp ?? ce.strike_price);
      if (!Number.isFinite(strike)) continue;
      byStrike.set(strike, { ...(byStrike.get(strike) || { strike }), ce });
    }
    for (const pe of Array.isArray(chain.pe) ? chain.pe : []) {
      const strike = Number(pe.sp ?? pe.strike_price);
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
    const filter = parseChainAtmFilter(chainAtmRange(), optionRows(), chainData()?.atm);
    if (!filter) return optionRows();
    return optionRows().filter((row) => Number(row.strike) >= filter.min && Number(row.strike) <= filter.max);
  });
  const visibleColumnCount = createMemo(() => visibleCallColumns().length);

  function parseChainAtmFilter(rawValue, rows, atmValue) {
    const raw = String(rawValue || "").trim().toLowerCase();
    if (!raw) return null;
    const atm = Number(atmValue);
    if (!Number.isFinite(atm)) return null;
    const match = raw.match(/([+-])?\s*(?:atm)?\s*([+-])?\s*(\d+(?:\.\d+)?)/);
    if (!match) return null;
    const sign = match[2] || match[1] || "";
    const value = Number(match[3]);
    if (!Number.isFinite(value) || value <= 0) return null;
    const strikes = rows.map((row) => Number(row.strike)).filter(Number.isFinite);
    const step = inferStrikeStep(strikes);
    const distance = Number.isFinite(step) && step > 0 && Number.isInteger(value) && value <= 20
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

  function optionCellProps(option, key) {
    switch (key) {
      case "ltp":
        return { value: option?.ltp, money: true, tone: "ltp" };
      case "iv":
        return { value: option?.iv, tone: "iv" };
      case "gamma":
        return { value: option?.gamma, digits: 5 };
      case "volume":
        return { value: option?.volume, compact: true };
      case "oi":
        return { value: option?.oi, compact: true, tone: "oi" };
      default:
        return { value: option?.[key] };
    }
  }

  function resizeChart(chart, host) {
    if (!chart || !host) return;
    const rect = host.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    chart.resize(width, height);
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
      "content-type": "application/json"
    };
  }

  async function nubraFetch(path, options = {}) {
    const target = new URL(path, `${environment()}/`);
    const response = await fetch(`/api/proxy?url=${encodeURIComponent(target.toString())}`, {
      method: options.method || "GET",
      headers: { ...authHeaders(), ...(options.headers || {}) },
      body: options.body
    });
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

  async function loadMarketStrip() {
    if (!authed()) {
      setMarketStripStatus("Waiting for session");
      return;
    }
    const results = await Promise.all(MARKET_STRIP_SYMBOLS.map(async (item) => {
      let lastError = "";
      for (const instrument of item.instruments || [item.instrument]) {
        const path = item.exchange === "BSE"
          ? `optionchains/${encodeURIComponent(instrument)}/price?exchange=BSE`
          : `optionchains/${encodeURIComponent(instrument)}/price`;
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
    const suffix = exchange() === "BSE" ? "?exchange=BSE" : "";
    const data = await nubraFetch(`optionchains/${encodeURIComponent(symbol().trim().toUpperCase())}/price${suffix}`);
    const price = toRupees(data.price);
    setSpot(price == null ? "--" : rupee.format(price));
    setChange(Number.isFinite(data.change) ? `${number.format(data.change)}%` : "--");
    setChartStatus("Ready");
  }

  async function loadPriceChart() {
    initPriceChart();
    if (!candleSeries) throw new Error("Chart engine is still loading. Try Load Chart again in a moment.");
    setChartStatus("Loading");
    const sym = symbol().trim().toUpperCase();
    const data = await nubraFetch("charts/timeseries", {
      method: "POST",
      body: JSON.stringify({
        query: [{
          exchange: exchange(),
          type: instrumentType(),
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

  async function rollingOptionRows() {
    const date = rollStart().slice(0, 10) || new Date().toISOString().slice(0, 10);
    const data = await nubraFetch(`refdata/refdata/${date}?exchange=${rollExchange()}`);
    const refRows = Array.isArray(data.refdata) ? data.refdata : [];
    const sym = rollSymbol().trim().toUpperCase();
    return refRows
      .filter((row) => {
        const asset = String(row.asset || "").toUpperCase();
        const dtype = String(row.derivative_type || "").toUpperCase();
        const side = optionRowSide(row);
        return asset === sym && dtype === "OPT" && (side === "CE" || side === "PE") && row.stock_name;
      })
      .map((row) => ({
        name: row.stock_name,
        refId: liveRefId(row),
        expiry: String(row.expiry || ""),
        side: optionRowSide(row),
        strike: normalizeStrike(row.strike_price)
      }))
      .filter((row) => Number.isFinite(row.strike) && row.expiry && row.refId);
  }

  async function loadRollingExpiries() {
    setRollStatus("Refdata");
    const rows = await rollingOptionRows();
    const expiries = [...new Set(rows.map((row) => row.expiry))].sort();
    if (!expiries.length) throw new Error("No option expiries found.");
    setRollExpiries(expiries);
    setRollExpiry((current) => current || expiries[0]);
    setRollStatus(`${expiries.length} expiries`);
  }

  async function loadOptionChainExpiries() {
    setChainStatus("Expiries");
    const date = new Date().toISOString().slice(0, 10);
    const data = await nubraFetch(`refdata/refdata/${date}?exchange=${chainExchange()}`);
    const refRows = Array.isArray(data.refdata) ? data.refdata : [];
    const sym = chainSymbol().trim().toUpperCase();
    const expiries = [...new Set(refRows
      .filter((row) => {
        const asset = String(row.asset || "").toUpperCase();
        const dtype = String(row.derivative_type || "").toUpperCase();
        const side = optionRowSide(row);
        return asset === sym && dtype === "OPT" && (side === "CE" || side === "PE") && row.expiry;
      })
      .map((row) => String(row.expiry)))]
      .sort();
    if (!expiries.length) throw new Error("No option expiries found for option chain.");
    setChainExpiries(expiries);
    setChainStatus(`${expiries.length} expiries`);
    return expiries;
  }

  async function fetchOptionChainSnapshot(sym, expiry) {
    const data = await nubraFetch(`optionchains/${encodeURIComponent(sym)}?exchange=${chainExchange()}&expiry=${encodeURIComponent(expiry)}`);
    const chain = data?.chain;
    if (!chain) throw new Error("No option chain returned.");
    return chain;
  }

  async function loadOptionChain() {
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
        setChainData(chain);
        setChainExpiry(String(chain.expiry || expiry));
        if (Array.isArray(chain.all_expiries) && chain.all_expiries.length) {
          setChainExpiries(chain.all_expiries.map(String).sort());
        }
        setChainStatus("Ready");
        return;
      } catch (err) {
        lastError = err;
        const message = String(err?.message || "");
        if (!message.toLowerCase().includes("invalid expiry")) throw err;
      }
    }

    setChainStatus("No chain");
    throw new Error(lastError?.message || "No valid option-chain expiry found.");
  }

  function normalizeLiveOption(option) {
    if (!option || typeof option !== "object") return option;
    return {
      ...option,
      sp: option.sp ?? option.strike_price,
      strike_price: option.strike_price ?? option.sp,
      ltp: option.ltp ?? option.last_traded_price,
      oi: option.oi ?? option.open_interest,
      previous_oi: option.previous_oi ?? option.previous_open_interest,
      option_type: option.option_type ?? option.side
    };
  }

  function normalizeLiveChain(chain) {
    if (!chain || typeof chain !== "object") return null;
    const previous = chainData() || {};
    return {
      ...previous,
      ...chain,
      asset: chain.asset ?? previous.asset ?? chainSymbol().trim().toUpperCase(),
      expiry: chain.expiry ?? previous.expiry ?? chainExpiry(),
      exchange: chain.exchange ?? previous.exchange ?? chainExchange(),
      cp: chain.cp ?? chain.current_price ?? previous.cp,
      atm: chain.atm ?? chain.at_the_money_strike ?? previous.atm,
      ce: (Array.isArray(chain.ce) ? chain.ce : previous.ce || []).map(normalizeLiveOption),
      pe: (Array.isArray(chain.pe) ? chain.pe : previous.pe || []).map(normalizeLiveOption),
      all_expiries: previous.all_expiries || chainExpiries()
    };
  }

  function handleChainLiveTick(chain) {
    const next = normalizeLiveChain(chain);
    if (!next) return;
    setChainData(next);
    if (next.expiry) setChainExpiry(String(next.expiry));
    setChainStatus("Live");
  }

  function startChainLive() {
    if (chainLiveSocket) { chainLiveSocket.close(); chainLiveSocket = null; }
    const sym = chainSymbol().trim().toUpperCase();
    const expiry = chainData()?.expiry || chainExpiry();
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
        exchange: chainExchange(),
        interval: "1m",
        expiry
      }));
      setChainLive(true);
      setChainStatus("Live subscribing");
    };
    ws.onmessage = (event) => {
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.event === "option" && msg.data) handleChainLiveTick(msg.data);
      if (msg.event === "status" && msg.status === "connected") setChainStatus("Live connected");
      if (msg.event === "status" && msg.status === "subscribed") setChainStatus("Live");
      if (msg.event === "status" && msg.status === "bridge-exit") setChainStatus(`Live bridge exited ${msg.code ?? ""}`.trim());
      if (msg.event === "log" && msg.message) setChainStatus(msg.message.slice(0, 80));
      if (msg.event === "error") setChainStatus(msg.message || "Live error");
    };
    ws.onclose = () => { chainLiveSocket = null; setChainLive(false); setChainStatus("Live stopped"); };
    ws.onerror = () => setChainStatus("WS error");
  }

  function stopChainLive() {
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

  async function fetchRollingSeries(names, start, end) {
    const seriesByName = new Map();
    const batchSize = 8;
    const total = Math.ceil(names.length / batchSize);
    for (let b = 0; b < total; b++) {
      const batch = names.slice(b * batchSize, (b + 1) * batchSize);
      setRollStatus(`Batch ${b + 1}/${total}`);
      const data = await nubraFetch("charts/timeseries", {
        method: "POST",
        body: JSON.stringify({
          query: [{
            exchange: rollExchange(),
            type: "OPT",
            values: batch,
            fields: ["l1bid", "l1ask", "iv_bid", "iv_ask"],
            startDate: start,
            endDate: end,
            interval: "1s",
            intraDay: false,
            realTime: false
          }]
        })
      });
      for (const entry of data?.result?.[0]?.values || []) {
        for (const [name, symData] of Object.entries(entry)) {
          const parsePoints = (arr, rupee = false) =>
            (Array.isArray(arr) ? arr : [])
              .map((p) => ({ ts: pointMs(p), v: pointNumber(p, rupee) }))
              .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.v))
              .sort((a, b) => a.ts - b.ts);
          seriesByName.set(name, {
            bid:    parsePoints(symData?.l1bid, true),
            ask:    parsePoints(symData?.l1ask, true),
            ivBid:  parsePoints(symData?.iv_bid, false),
            ivAsk:  parsePoints(symData?.iv_ask, false)
          });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return seriesByName;
  }

  function advanceQuote(name, seriesByName, cursorByName, ts) {
    const series = seriesByName.get(name);
    if (!series) return { bid: 0, ask: 0, ivBid: null, ivAsk: null };
    const cursor = cursorByName.get(name) || { bidIndex: 0, askIndex: 0, ivBidIndex: 0, ivAskIndex: 0, bid: 0, ask: 0, ivBid: null, ivAsk: null };
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
    cursorByName.set(name, cursor);
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

  function animateSeriesPoint(series, key, time, value) {
    if (!series || !rollLiveContext || !Number.isFinite(value)) return;
    const from = rollLiveContext.lastValues[key];
    const start = Number.isFinite(from) ? from : value;
    const duration = 420;
    const started = performance.now();

    const step = (now) => {
      if (!rollLiveContext) return;
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      series.update({ time, value: start + (value - start) * eased });
      if (progress < 1) rollLiveContext.frames[key] = requestAnimationFrame(step);
      else {
        series.update({ time, value });
        rollLiveContext.lastValues[key] = value;
        rollLiveContext.frames[key] = null;
      }
    };

    if (rollLiveContext.frames[key]) cancelAnimationFrame(rollLiveContext.frames[key]);
    rollLiveContext.frames[key] = requestAnimationFrame(step);
  }

  function readLiveLeg(row) {
    if (!rollLiveContext || !row) return null;
    const refId = liveRefId(row);
    const book = refId ? rollLiveContext.orderbookByRef.get(refId) : null;
    const greek = refId ? rollLiveContext.greeksByRef.get(refId) : null;
    const optionTick = refId ? rollLiveContext.optionByRef.get(refId) : null;
    const fallbackPrice = toRupees(row.last_traded_price);
    return {
      bid: firstPriceLevel(book?.bids) ?? fallbackPrice,
      ask: firstPriceLevel(book?.asks) ?? fallbackPrice,
      iv: liveIv(greek) ?? liveIv(optionTick) ?? liveIv(row),
      hasBook: Boolean(book)
    };
  }

  function updateRollLiveSnapshot(receivedAtMs = Date.now()) {
    if (!rollLiveContext || !rollBidSeries || !rollAskSeries) return;
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

    const time = tvTime(receivedAtMs);
    animateSeriesPoint(rollBidSeries, "bid", time, best.bid);
    animateSeriesPoint(rollAskSeries, "ask", time, best.ask);
    if (best.ivMid != null && rollIvSeries) animateSeriesPoint(rollIvSeries, "iv", time, best.ivMid);

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
      meta: `${rollSymbol().trim().toUpperCase()} ${rollExpiry()} | live 1-second ${best.hasBook ? "bid/ask" : "LTP fallback"} | ${rollExchange()}`
    }));
    setRollStatus(best.hasBook ? "Live" : "Live LTP fallback");
  }

  function scheduleRollLiveUpdate(receivedAtMs) {
    if (rollLiveFlushTimer) return;
    rollLiveFlushTimer = setTimeout(() => {
      rollLiveFlushTimer = null;
      updateRollLiveSnapshot(receivedAtMs || Date.now());
    }, 1000);
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
    if (rollLiveSocket) { rollLiveSocket.close(); rollLiveSocket = null; }
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
        exchange: rollExchange(),
        interval: "1m",
        expiry,
        refIds: rollLiveContext.refIds
      }));
      setRollLive(true);
      setRollStatus(`Live subscribing ${rollLiveContext.refIds.length} legs`);
    };
    ws.onmessage = (e) => {
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
    ws.onclose = () => { rollLiveSocket = null; setRollLive(false); setRollStatus("Live stopped"); };
    ws.onerror = () => setRollStatus("WS error");
  }

  function stopRollLive() {
    if (rollLiveFlushTimer) {
      clearTimeout(rollLiveFlushTimer);
      rollLiveFlushTimer = null;
    }
    if (rollLiveContext?.frames) {
      for (const frame of Object.values(rollLiveContext.frames)) {
        if (frame) cancelAnimationFrame(frame);
      }
      rollLiveContext.frames = { bid: null, ask: null, iv: null };
    }
    if (rollLiveSocket) {
      try { rollLiveSocket.send(JSON.stringify({ type: "stop" })); } catch {}
      rollLiveSocket.close();
      rollLiveSocket = null;
    }
    setRollLive(false);
    setRollStatus("Idle");
  }

  function rollLineSeries(target = rollLineTarget()) {
    if (target === "ask") return rollAskSeries;
    if (target === "iv") return rollIvSeries;
    return rollBidSeries;
  }

  function rollLineColor(target = rollLineTarget()) {
    if (target === "ask") return "#ffb15c";
    if (target === "iv") return "#a78bfa";
    return "#21d19f";
  }

  function rollLineTitle(name, target) {
    const label = target === "iv" ? "IV" : target === "ask" ? "Ask" : "Bid";
    return `${name || label} ${label}`;
  }

  function addRollLine() {
    initRollChart();
    const series = rollLineSeries();
    const value = Number(rollLineValue());
    if (!series || !Number.isFinite(value)) {
      setRollStatus("Enter line value");
      return;
    }

    const target = rollLineTarget();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const title = rollLineTitle(rollLineName().trim(), target);
    const handle = series.createPriceLine({
      price: value,
      color: rollLineColor(target),
      lineWidth: 2,
      lineStyle: 2,
      axisLabelVisible: true,
      title
    });
    rollPriceLines.set(id, { series, handle });
    setRollDrawnLines((lines) => [...lines, { id, name: title, value, target }]);
    setRollLineName("");
    setRollLineValue("");
    setRollStatus(`Line added: ${title}`);
  }

  function removeRollLine(id) {
    const item = rollPriceLines.get(id);
    if (item) {
      item.series.removePriceLine(item.handle);
      rollPriceLines.delete(id);
    }
    setRollDrawnLines((lines) => lines.filter((line) => line.id !== id));
  }

  function initRollChart() {
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
      color: "#a78bfa",
      lineWidth: 1,
      lineStyle: 2,           // dashed
      title: "IV %",
      priceScaleId: "left",
      priceFormat: { type: "custom", formatter: (p) => `${p.toFixed(1)}%`, minMove: 0.01 }
    });

    queueChartResize();
  }

  async function loadRollingStraddle() {
    initRollChart();
    const start = fromLocalInput(rollStart());
    const end = fromLocalInput(rollEnd());
    if (!start || !end) throw new Error("Rolling start and end are required.");

    setRollStatus("Spot");
    const sym = rollSymbol().trim().toUpperCase();
    const spotData = await nubraFetch("charts/timeseries", {
      method: "POST",
      body: JSON.stringify({
        query: [{
          exchange: rollExchange(),
          type: rollType(),
          values: [sym],
          fields: ["close"],
          startDate: start,
          endDate: end,
          interval: "1s",
          intraDay: false,
          realTime: false
        }]
      })
    });
    const spotSymbolData = extractSymbolData(spotData, sym);
    const spotPoints = (Array.isArray(spotSymbolData?.close) ? spotSymbolData.close : [])
      .map((p) => ({ ts: pointMs(p), spot: pointNumber(p, true) }))
      .filter((p) => Number.isFinite(p.ts) && p.spot > 0)
      .sort((a, b) => a.ts - b.ts);
    if (!spotPoints.length) throw new Error("No 1-second spot data returned.");

    setRollStatus("Refdata");
    let rows = await rollingOptionRows();
    if (!rollExpiry()) {
      const expiries = [...new Set(rows.map((row) => row.expiry))].sort();
      setRollExpiries(expiries);
      setRollExpiry(expiries[0] || "");
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
    const liveRefIds = new Set();
    for (const strike of requiredStrikes) {
      const ce = rowByKey.get(`${strike}|CE`);
      const pe = rowByKey.get(`${strike}|PE`);
      if (ce) {
        optionNames.push(ce.name);
        liveRefIds.add(ce.refId);
      }
      if (pe) {
        optionNames.push(pe.name);
        liveRefIds.add(pe.refId);
      }
    }
    if (!optionNames.length) throw new Error("No CE/PE symbols found around ATM +/-2.");

    const seriesByName = await fetchRollingSeries([...new Set(optionNames)], start, end);
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
        const ceIvMid = (ceQuote.ivBid != null && ceQuote.ivAsk != null) ? (ceQuote.ivBid + ceQuote.ivAsk) / 2 : null;
        const peIvMid = (peQuote.ivBid != null && peQuote.ivAsk != null) ? (peQuote.ivBid + peQuote.ivAsk) / 2 : null;
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

    rollBidSeries.setData(bidLine);
    rollAskSeries.setData(askLine);
    if (ivLine.length && rollIvSeries) {
      rollIvSeries.setData(ivLine);
    }
    resizeChart(rollChart, rollChartHost);
    rollChart.timeScale().fitContent();

    const last = selected[selected.length - 1];
    const lastIv = ivLine.length ? ivLine[ivLine.length - 1].value : null;
    rollLiveContext = {
      strikes,
      step,
      rowByKey,
      optionByRef: new Map(),
      orderbookByRef: new Map(),
      greeksByRef: new Map(),
      refIds: [...liveRefIds],
      spot: last.spot,
      points: selected.length,
      lastValues: {
        bid: last.bid,
        ask: last.ask,
        iv: lastIv
      },
      frames: {
        bid: null,
        ask: null,
        iv: null
      }
    };
    setRollStats({
      spot: rupee.format(last.spot),
      strike: number.format(last.strike),
      bid: rupee.format(last.bid),
      ask: rupee.format(last.ask),
      iv: lastIv != null ? `${lastIv.toFixed(1)}%` : "--",
      points: String(selected.length),
      meta: `${sym} ${rollExpiry()} | 1-second quotes | ${requiredStrikes.size} strikes checked | ${rollExchange()}`
    });
    setRollExportData(selected);
    setRollStatus("Ready");
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

      // Block the auto-fetch effect BEFORE updating symbols (which would trigger it)
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

      rollBidSeries.setData(bidLine);
      rollAskSeries.setData(askLine);
      if (ivLine.length && rollIvSeries) rollIvSeries.setData(ivLine);
      resizeChart(rollChart, rollChartHost);
      rollChart.timeScale().fitContent();

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
    window.addEventListener("resize", resizeVisibleCharts);
    queueChartResize();
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
    untrack(() => loadMarketStrip());
    const timer = window.setInterval(() => untrack(() => loadMarketStrip()), 30000);
    onCleanup(() => window.clearInterval(timer));
  });

  createEffect(() => {
    if (!authed()) return;
    if (importMode()) return; // don't auto-fetch when showing imported data
    const loadKey = [
      token().trim(),
      deviceId().trim(),
      rollSymbol().trim().toUpperCase(),
      rollType(),
      rollExchange(),
      rollStart(),
      rollEnd()
    ].join("|");
    if (autoRollLoadedKey === loadKey) return;
    autoRollLoadedKey = loadKey;
    untrack(() => run(loadRollingStraddle));
  });

  createEffect(() => {
    if (!authed() || section() !== "chain") return;
    const loadKey = [
      token().trim(),
      deviceId().trim(),
      chainSymbol().trim().toUpperCase(),
      chainExchange(),
      chainExpiry()
    ].join("|");
    if (autoChainLoadedKey === loadKey) return;
    autoChainLoadedKey = loadKey;
    untrack(() => run(loadOptionChain));
  });

  const navButtonStyle = (name) => section() === name
    ? "border-color:rgba(5,184,120,.42);background:rgba(5,184,120,.12);color:#ffffff"
    : "";

  return (
    <div class={`min-h-screen ${widgetMode ? "desktop-widget-mode" : ""}`} style="background:var(--bg-main);color:var(--text-primary)">
      <Show when={widgetMode}>
        <div class="widget-titlebar">
          <div class="widget-drag-zone">
            <strong>Option Chain Widget</strong>
            <span>{chainSymbol()} · {chainExchange()} · {chainExpiry() || "Auto"}</span>
          </div>
          <button class="widget-title-button" onClick={() => setDrawerOpen(true)}>Session</button>
          <button class="widget-title-button" onClick={() => desktopApi?.openMain?.()}>Main App</button>
          <button class="widget-title-button close" onClick={() => desktopApi?.closeWidget?.()}>Close</button>
        </div>
      </Show>

      <Show when={!widgetMode}>
      <header class="app-header">
        <div class="app-brand">
          <div class="grid h-7 w-7 shrink-0 place-items-center rounded font-bold text-xs" style="background:var(--accent-cyan);color:#0d1117">N</div>
          <div class="min-w-0">
            <p class="text-[9px] font-semibold" style="color:var(--text-tertiary);letter-spacing:0">Nubra</p>
            <h1 class="truncate text-[13px] font-semibold" style="color:var(--text-primary)">Options Intelligence</h1>
          </div>
        </div>

        <div class="market-nav-strip" title={marketStripStatus()}>
          <For each={marketStrip()}>
            {(item) => {
              const changeValue = Number(item.change);
              const tone = Number.isFinite(changeValue) && changeValue < 0 ? "down" : "up";
              return (
                <div class={`market-nav-item ${item.ok ? tone : "muted"}`}>
                  <div class="market-nav-topline">
                    <span class="market-nav-label">{item.label}</span>
                    <span class="market-nav-exchange">{item.exchange}</span>
                  </div>
                  <strong>{formatIndexValue(item.price)}</strong>
                  <span class="market-nav-change">
                    <Show when={item.ok}>
                      <span class="market-nav-arrow">{tone === "down" ? "↓" : "↑"}</span>
                    </Show>
                    {formatPercent(item.change)}
                  </span>
                </div>
              );
            }}
          </For>
        </div>

        <nav class="flex items-center gap-0.5 rounded-md p-0.5 text-xs" style="background:#0d1117;border:1px solid var(--border-subtle)">
          <button
            class={`rounded border border-transparent px-4 py-1.5 text-xs font-medium transition-all duration-150 ${section() === "rolling" ? "" : "readable-muted hover:text-white"}`}
            style={navButtonStyle("rolling")}
            onClick={() => setSection("rolling")}
          >
            Rolling Straddle
          </button>
          <button
            class={`rounded border border-transparent px-4 py-1.5 text-xs font-medium transition-all duration-150 ${section() === "chain" ? "" : "readable-muted hover:text-white"}`}
            style={navButtonStyle("chain")}
            onClick={() => setSection("chain")}
          >
            Option Chain
          </button>
          <button
            class={`rounded border border-transparent px-4 py-1.5 text-xs font-medium transition-all duration-150 ${section() === "market" ? "" : "readable-muted hover:text-white"}`}
            style={navButtonStyle("market")}
            onClick={() => setSection("market")}
          >
            Market Chart
          </button>
        </nav>

        <div class="flex items-center gap-2.5">
          <Show when={desktopApi?.openWidget}>
            <button class="terminal-button" onClick={() => desktopApi.openWidget()}>
              Widget
            </button>
          </Show>
          <button class="terminal-button-secondary" onClick={() => setDrawerOpen(true)}>
            Session
          </button>
          <div class="flex items-center gap-2 rounded px-3 py-1.5 text-[11px] font-medium" style="background:#0d1117;border:1px solid var(--border-subtle);color:var(--text-secondary)">
            <span class={`h-1.5 w-1.5 rounded-full ${authed() ? "bg-emerald-400" : "bg-amber-400"}`}></span>
            <span>{authed() ? "Connected" : "No session"}</span>
          </div>
        </div>
      </header>
      </Show>

      <Show when={drawerOpen()}>
        <div class="fixed inset-0 z-40 bg-black/50" onClick={() => setDrawerOpen(false)}></div>
      </Show>

      <aside class={`fixed inset-y-0 left-0 z-50 w-[340px] shadow-2xl transition-transform duration-200 ${drawerOpen() ? "translate-x-0" : "-translate-x-full"}`} style="background:var(--bg-panel);border-right:1px solid var(--border-subtle)">
        <div class="flex items-center justify-between px-5 py-3.5" style="border-bottom:1px solid var(--border-subtle)">
          <div>
            <p class="text-[9px] font-semibold" style="color:var(--text-tertiary);letter-spacing:0">Connection</p>
            <h2 class="text-[13px] font-semibold" style="color:var(--text-primary)">Nubra Session</h2>
          </div>
          <button class="terminal-button-secondary px-2.5 py-1" onClick={() => setDrawerOpen(false)}>✕</button>
        </div>

        <div class="space-y-5 p-5">
          <section class="space-y-3.5">
            <label class="grid gap-1.5 text-[10px] font-semibold" style="color:var(--text-muted);letter-spacing:0">
              Environment
              <select class="terminal-input" value={environment()} onInput={(e) => setEnvironment(e.currentTarget.value)}>
                <option value="https://api.nubra.io">Production</option>
                <option value="https://uatapi.nubra.io">UAT</option>
              </select>
            </label>
            <label class="grid gap-1.5 text-[10px] font-semibold" style="color:var(--text-muted);letter-spacing:0">
              Session Token
              <input class="terminal-input" type="password" value={token()} onInput={(e) => {
                setToken(e.currentTarget.value);
                localStorage.setItem("nubraSessionToken", e.currentTarget.value);
              }} placeholder="Bearer …" />
            </label>
            <label class="grid gap-1.5 text-[10px] font-semibold" style="color:var(--text-muted);letter-spacing:0">
              Device ID
              <input class="terminal-input" value={deviceId()} onInput={(e) => {
                setDeviceId(e.currentTarget.value);
                localStorage.setItem("nubraDeviceId", e.currentTarget.value);
              }} placeholder="Nubra-OSS-…" />
            </label>
          </section>

          <section class="space-y-3.5 pt-4" style="border-top:1px solid var(--border-subtle)">
            <div class="grid grid-cols-2 gap-3">
              <label class="grid gap-1.5 text-[10px] font-semibold" style="color:var(--text-muted);letter-spacing:0">
                Method
                <select class="terminal-input" value={authMethod()} onInput={(e) => setAuthMethod(e.currentTarget.value)}>
                  <option value="otp">SMS OTP</option>
                  <option value="totp">TOTP</option>
                </select>
              </label>
              <label class="grid gap-1.5 text-[10px] font-semibold" style="color:var(--text-muted);letter-spacing:0">
                Phone
                <input class="terminal-input" value={phone()} onInput={(e) => setPhone(e.currentTarget.value)} placeholder="Mobile number" />
              </label>
            </div>
            <button class="terminal-button w-full" onClick={() => run(startLogin)} disabled={busy()}>Start Login</button>
            <div class="grid grid-cols-2 gap-3">
              <label class="grid gap-1.5 text-[10px] font-semibold" style="color:var(--text-muted);letter-spacing:0">
                OTP / TOTP
                <input class="terminal-input" value={otp()} onInput={(e) => setOtp(e.currentTarget.value)} inputmode="numeric" />
              </label>
              <label class="grid gap-1.5 text-[10px] font-semibold" style="color:var(--text-muted);letter-spacing:0">
                MPIN
                <input class="terminal-input" type="password" value={mpin()} onInput={(e) => setMpin(e.currentTarget.value)} inputmode="numeric" />
              </label>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <button class="terminal-button-secondary" onClick={() => run(verifyCode)} disabled={busy()}>Verify Code</button>
              <button class="terminal-button-secondary" onClick={() => run(verifyMpin)} disabled={busy()}>Verify MPIN</button>
            </div>
            <p class="text-[11px] leading-5" style="color:var(--text-secondary)">{loginStatus()}</p>
          </section>
        </div>
      </aside>

      <main class="flex flex-col" style="background:var(--bg-main)">
        <Show when={toast()}>
          <div class="flex items-center gap-2.5 px-5 py-2 text-[11px] font-medium" style="background:rgba(239,68,68,0.07);border-bottom:1px solid rgba(239,68,68,0.18);color:#fca5a5">
            <span class="shrink-0 opacity-60">⚠</span>
            {toast()}
          </div>
        </Show>

        <Show when={section() === "rolling"}>
          {/* ── Toolbar ── */}
          <div class="control-panel">
            <label class="terminal-label">
              Underlying
              <input class="terminal-input w-24" value={rollSymbol()} onInput={(e) => setRollSymbol(e.currentTarget.value.toUpperCase())} />
            </label>
            <label class="terminal-label">
              Type
              <select class="terminal-input" value={rollType()} onInput={(e) => setRollType(e.currentTarget.value)}>
                <option value="INDEX">INDEX</option>
                <option value="STOCK">STOCK</option>
              </select>
            </label>
            <label class="terminal-label">
              Exchange
              <select class="terminal-input" value={rollExchange()} onInput={(e) => setRollExchange(e.currentTarget.value)}>
                <option value="NSE">NSE</option>
                <option value="BSE">BSE</option>
              </select>
            </label>
            <label class="terminal-label">
              Expiry
              <select class="terminal-input w-28" value={rollExpiry()} onInput={(e) => setRollExpiry(e.currentTarget.value)}>
                <option value="">Auto</option>
                <For each={rollExpiries()}>{(expiry) => <option value={expiry}>{expiry}</option>}</For>
              </select>
            </label>
            <div class="h-6 w-px shrink-0" style="background:var(--border-muted)"></div>
            <label class="terminal-label">
              Start
              <input class="terminal-input w-40" type="datetime-local" value={rollStart()} onInput={(e) => setRollStart(e.currentTarget.value)} />
            </label>
            <label class="terminal-label">
              End
              <input class="terminal-input w-40" type="datetime-local" value={rollEnd()} onInput={(e) => setRollEnd(e.currentTarget.value)} />
            </label>
            <div class="ml-auto flex items-center gap-2">
              <button class="terminal-button-secondary" onClick={() => run(loadRollingExpiries)} disabled={busy()}>Load Expiries</button>

              {/* Import button — always visible */}
              <label class="terminal-button-secondary flex cursor-pointer items-center gap-1.5" title="Import CSV or Parquet file">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="flex-shrink:0">
                  <path d="M6 9V2M3.5 4.5L6 2l2.5 2.5M2 10h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                Import
                <input ref={importFileRef} type="file" accept=".csv,.parquet" class="sr-only" onChange={handleImport} />
              </label>

              {/* Download buttons — only after data is loaded */}
              <Show when={rollExportData().length > 0}>
                <div class="flex items-center" style="border:1px solid var(--border-muted);border-radius:5px;overflow:hidden">
                  <button
                    class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-all duration-150"
                    style="color:var(--text-secondary);background:transparent;border-right:1px solid var(--border-muted)"
                    onClick={downloadCSV}
                    title={`Download ${rollExportData().length.toLocaleString()} rows as CSV`}
                  >
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style="flex-shrink:0">
                      <path d="M6 1v7M3.5 5.5L6 8l2.5-2.5M2 10h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    CSV
                  </button>
                  <button
                    class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-all duration-150"
                    style="color:var(--text-secondary);background:transparent"
                    onClick={downloadParquet}
                    title={`Download ${rollExportData().length.toLocaleString()} rows as Parquet`}
                  >
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style="flex-shrink:0">
                      <path d="M6 1v7M3.5 5.5L6 8l2.5-2.5M2 10h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    Parquet
                  </button>
                </div>
              </Show>

              <button class="terminal-button" onClick={() => { setImportMode(false); autoRollLoadedKey = ""; run(loadRollingStraddle); }} disabled={busy()}>Plot Rolling</button>
              <Show
                when={rollLive()}
                fallback={<button class="terminal-button-secondary" onClick={startRollLive} disabled={busy() || !authed()}>Start Live</button>}
              >
                <button class="terminal-button-secondary" onClick={stopRollLive}>Stop Live</button>
              </Show>
            </div>
          </div>

          {/* ── Chart workspace ── */}
          <div class="control-panel line-tool-panel">
            <label class="terminal-label">
              Line Name
              <input class="terminal-input w-36" value={rollLineName()} onInput={(e) => setRollLineName(e.currentTarget.value)} placeholder="Support" />
            </label>
            <label class="terminal-label">
              Value
              <input class="terminal-input w-28" value={rollLineValue()} onInput={(e) => setRollLineValue(e.currentTarget.value)} placeholder="125.50" inputmode="decimal" />
            </label>
            <label class="terminal-label">
              Target
              <select class="terminal-input" value={rollLineTarget()} onInput={(e) => setRollLineTarget(e.currentTarget.value)}>
                <option value="bid">Bid</option>
                <option value="ask">Ask</option>
                <option value="iv">IV</option>
              </select>
            </label>
            <button class="terminal-button-secondary" onClick={addRollLine}>Draw Line</button>
          </div>

          <div class="chart-workspace">
            {/* Metrics sidebar */}
            <aside class="chart-sidebar">
              <div class="sidebar-metric">
                <span class="sidebar-label">Spot</span>
                <strong class="sidebar-value">{rollStats().spot}</strong>
              </div>
              <div class="sidebar-divider" />
              <div class="sidebar-metric">
                <span class="sidebar-label">Strike</span>
                <strong class="sidebar-value">{rollStats().strike}</strong>
              </div>
              <div class="sidebar-divider" />
              <div class="sidebar-metric">
                <span class="sidebar-label">Bid</span>
                <strong class="sidebar-value bid">{rollStats().bid}</strong>
              </div>
              <div class="sidebar-divider" />
              <div class="sidebar-metric">
                <span class="sidebar-label">Ask</span>
                <strong class="sidebar-value ask">{rollStats().ask}</strong>
              </div>
              <div class="sidebar-divider" />
              <div class="sidebar-metric">
                <span class="sidebar-label">IV Mid</span>
                <strong class="sidebar-value iv">{rollStats().iv}</strong>
              </div>
              <div class="mt-auto sidebar-divider" />
              <div class="sidebar-status">
                <span class="sidebar-label">Status</span>
                <span class="sidebar-status-value">{rollStatus()}</span>
              </div>
              <Show when={rollDrawnLines().length}>
                <div class="sidebar-divider" />
                <div class="line-list">
                  <span class="sidebar-label">Lines</span>
                  <For each={rollDrawnLines()}>
                    {(line) => (
                      <button class="line-list-item" onClick={() => removeRollLine(line.id)} title="Remove line">
                        <span class="line-list-color" style={`background:${rollLineColor(line.target)}`}></span>
                        <span class="line-list-name">{line.name}</span>
                        <span class="line-list-value">{line.target === "iv" ? `${line.value}%` : rupee.format(line.value)}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </aside>

            {/* Single chart card — Bid/Ask on right axis, IV on left axis */}
            <div class="chart-card">
              <div class="chart-card-header">
                <div>
                  <h2 class="chart-card-title">Rolling Straddle</h2>
                  <p class="chart-card-meta">{rollStats().meta}</p>
                </div>
                <div class="flex items-center gap-4 text-[10px]">
                  <span class="flex items-center gap-1.5">
                    <span class="inline-block h-2 w-4 rounded-sm" style="background:#21d19f"></span>
                    <span style="color:var(--text-muted)">Bid ₹</span>
                  </span>
                  <span class="flex items-center gap-1.5">
                    <span class="inline-block h-2 w-4 rounded-sm" style="background:#ffb15c"></span>
                    <span style="color:var(--text-muted)">Ask ₹</span>
                  </span>
                  <span class="flex items-center gap-1.5">
                    <span class="inline-block h-px w-4" style="background:#a78bfa;border-top:2px dashed #a78bfa"></span>
                    <span style="color:var(--text-muted)">IV % (left)</span>
                  </span>
                </div>
              </div>
              <div class="chart-card-body" ref={(el) => { rollChartHost = el; initRollChart(); queueChartResize(); }}></div>
            </div>
          </div>
        </Show>

        <Show when={section() === "chain"}>
          <div class="chain-market-strip">
            <Metric label="Spot" value={formatMoney(chainData()?.cp)} />
            <Metric label="ATM Strike" value={formatStrike(chainData()?.atm)} />
            <Metric label="Expiry" value={chainData()?.expiry || chainExpiry() || "Auto"} />
            <Metric label="Strikes" value={String(optionRows().length)} />
            <Metric label="Status" value={chainStatus()} />
          </div>

          <div class="option-chain-workspace">
            <aside class="chain-sidebar">
              <div class="chain-kicker">Option Chain</div>
              <h2 class="chain-title">{chainData()?.asset || chainSymbol()}</h2>
              <div class="chain-subtitle">{chainExchange()} · {chainData()?.expiry || chainExpiry() || "Auto"}</div>

              <div class="chain-stat-grid">
                <div class="chain-stat">
                  <span>Spot</span>
                  <strong>{formatMoney(chainData()?.cp)}</strong>
                </div>
                <div class="chain-stat">
                  <span>ATM</span>
                  <strong>{formatStrike(chainData()?.atm)}</strong>
                </div>
                <div class="chain-stat">
                  <span>Strikes</span>
                  <strong>{optionRows().length}</strong>
                </div>
                <div class="chain-stat">
                  <span>Status</span>
                  <strong>{chainStatus()}</strong>
                </div>
              </div>
            </aside>

            <section class="chain-table-card">
              <div class="chain-table-header">
                <div>
                  <div class="flex items-center gap-2">
                    <h2>Options Chain</h2>
                    <span class="chain-ready">{chainStatus()}</span>
                  </div>
                  <p>{chainData()?.asset || chainSymbol()} · {chainExchange()} · {chainData()?.expiry || chainExpiry() || "Auto"} · prices in rupees</p>
                </div>
                <div class="chain-actions">
                  <label class="chain-inline-field">
                    Underlying
                    <input class="terminal-input w-24" value={chainSymbol()} onInput={(e) => {
                      stopChainLive();
                      setChainSymbol(e.currentTarget.value.toUpperCase());
                      setChainData(null);
                      setChainExpiry("");
                      setChainExpiries([]);
                    }} />
                  </label>
                  <label class="chain-inline-field">
                    Exchange
                    <select class="terminal-input" value={chainExchange()} onInput={(e) => {
                      stopChainLive();
                      setChainExchange(e.currentTarget.value);
                      setChainData(null);
                      setChainExpiry("");
                      setChainExpiries([]);
                    }}>
                      <option value="NSE">NSE</option>
                      <option value="BSE">BSE</option>
                    </select>
                  </label>
                  <label class="chain-inline-field">
                    Expiry
                    <select class="terminal-input w-32" value={chainExpiry()} onInput={(e) => {
                      stopChainLive();
                      setChainExpiry(e.currentTarget.value);
                      setChainData(null);
                    }}>
                      <option value="">Auto</option>
                      <For each={chainExpiries()}>{(expiry) => <option value={expiry}>{expiry}</option>}</For>
                    </select>
                  </label>
                  <button class="terminal-button-secondary" onClick={() => run(loadOptionChainExpiries)} disabled={busy()}>Expiries</button>
                  <button class="terminal-button" onClick={() => { autoChainLoadedKey = ""; run(loadOptionChain); }} disabled={busy()}>Load</button>
                  <Show
                    when={chainLive()}
                    fallback={<button class="terminal-button-secondary" onClick={startChainLive} disabled={busy() || !authed()}>Start Live</button>}
                  >
                    <button class="terminal-button-secondary" onClick={stopChainLive}>Stop Live</button>
                  </Show>
                  <div class="chain-column-menu">
                    <button class="chain-icon-button" title="Choose columns" onClick={() => setChainColumnMenuOpen((open) => !open)}>Columns</button>
                    <Show when={chainColumnMenuOpen()}>
                      <div class="chain-column-popover">
                        <button class="chain-column-all" onClick={showAllChainColumns}>All columns</button>
                        <For each={CHAIN_COLUMNS}>
                          {(column) => (
                            <label class="chain-check-row">
                              <input
                                type="checkbox"
                                checked={chainVisibleColumns()[column.key]}
                                onInput={() => toggleChainColumn(column.key)}
                              />
                              <span>{column.label}</span>
                            </label>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                  <label class="chain-inline-field">
                    Filter
                    <select class="terminal-input" value={chainFilterMode()} onInput={(e) => setChainFilterMode(e.currentTarget.value)}>
                      <option value="atm">ATM distance</option>
                      <option value="premium">Premium range</option>
                    </select>
                  </label>
                  <Show when={chainFilterMode() === "atm"}>
                    <label class="chain-inline-field chain-range-field">
                      ATM Distance
                      <input class="chain-filter" value={chainAtmRange()} placeholder="+/-800 / +2" onInput={(e) => setChainAtmRange(e.currentTarget.value)} />
                    </label>
                  </Show>
                  <Show when={chainFilterMode() === "premium"}>
                    <label class="chain-inline-field chain-premium-field">
                      Premium From
                      <input class="chain-filter" inputmode="decimal" value={chainPremiumMin()} placeholder="100" onInput={(e) => setChainPremiumMin(e.currentTarget.value)} />
                    </label>
                    <label class="chain-inline-field chain-premium-field">
                      Premium To
                      <input class="chain-filter" inputmode="decimal" value={chainPremiumMax()} placeholder="300" onInput={(e) => setChainPremiumMax(e.currentTarget.value)} />
                    </label>
                  </Show>
                  <div class="chain-pill">{chainData()?.all_expiries?.length || chainExpiries().length || 0} expiries</div>
                </div>
              </div>

              <div class="chain-table-wrap">
                <Show
                  when={visibleOptionRows().length}
                  fallback={<div class="chain-empty">Load the option chain to view strikes, prices, OI, volume and Greeks.</div>}
                >
                  <table class="chain-table">
                    <thead>
                      <tr class="chain-group-row">
                        <th colSpan={visibleColumnCount()}>Calls</th>
                        <th class="strike-head">Strike Price</th>
                        <th colSpan={visibleColumnCount()}>Puts</th>
                      </tr>
                      <tr>
                        <For each={visibleCallColumns()}>
                          {(key) => <th class={key === "iv" ? "chain-head-iv" : key === "ltp" ? "chain-head-ltp" : ""}>{chainColumnLabel(key)}</th>}
                        </For>
                        <th class="strike-head">Strike Price</th>
                        <For each={visiblePutColumns()}>
                          {(key) => <th class={key === "iv" ? "chain-head-iv" : key === "ltp" ? "chain-head-ltp" : ""}>{chainColumnLabel(key)}</th>}
                        </For>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={visibleOptionRows()}>
                        {(row) => (
                          <tr class={Number(row.strike) === Number(chainData()?.atm) ? "atm-row" : ""}>
                            <For each={visibleCallColumns()}>
                              {(key, index) => {
                                const showSide = showPremiumSide(row.ce);
                                const props = optionCellProps(showSide ? row.ce : null, key);
                                const sideClass = index() === 0 ? "chain-side-call-start" : index() === visibleCallColumns().length - 1 ? "chain-side-call-end" : "";
                                return <OptionCell {...props} tone={props.tone === "oi" ? "oi-call" : props.tone} class={[sideClass, showSide ? "" : "chain-cell-filtered"].filter(Boolean).join(" ")} />;
                              }}
                            </For>
                            <td class="strike-cell">{formatStrike(row.strike)}</td>
                            <For each={visiblePutColumns()}>
                              {(key, index) => {
                                const showSide = showPremiumSide(row.pe);
                                const props = optionCellProps(showSide ? row.pe : null, key);
                                const sideClass = index() === 0 ? "chain-side-put-start" : index() === visiblePutColumns().length - 1 ? "chain-side-put-end" : "";
                                return <OptionCell {...props} tone={props.tone === "oi" ? "oi-put" : props.tone} class={[sideClass, showSide ? "" : "chain-cell-filtered"].filter(Boolean).join(" ")} />;
                              }}
                            </For>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </div>
            </section>
          </div>
        </Show>

        <Show when={section() === "market"}>
          {/* ── Toolbar ── */}
          <div class="control-panel">
            <label class="terminal-label">
              Symbol
              <input class="terminal-input w-24" value={symbol()} onInput={(e) => setSymbol(e.currentTarget.value.toUpperCase())} />
            </label>
            <label class="terminal-label">
              Type
              <select class="terminal-input" value={instrumentType()} onInput={(e) => setInstrumentType(e.currentTarget.value)}>
                <option value="INDEX">INDEX</option>
                <option value="STOCK">STOCK</option>
                <option value="FUT">FUT</option>
                <option value="OPT">OPT</option>
              </select>
            </label>
            <label class="terminal-label">
              Exchange
              <select class="terminal-input" value={exchange()} onInput={(e) => setExchange(e.currentTarget.value)}>
                <option value="NSE">NSE</option>
                <option value="BSE">BSE</option>
              </select>
            </label>
            <label class="terminal-label">
              Interval
              <select class="terminal-input" value={interval()} onInput={(e) => setIntervalValue(e.currentTarget.value)}>
                <option value="1s">1s</option>
                <option value="1m">1m</option>
                <option value="3m">3m</option>
                <option value="5m">5m</option>
                <option value="15m">15m</option>
                <option value="1h">1h</option>
                <option value="1d">1d</option>
              </select>
            </label>
            <div class="h-6 w-px shrink-0" style="background:var(--border-muted)"></div>
            <label class="terminal-label">
              Start
              <input class="terminal-input w-40" type="datetime-local" value={startDate()} onInput={(e) => setStartDate(e.currentTarget.value)} />
            </label>
            <label class="terminal-label">
              End
              <input class="terminal-input w-40" type="datetime-local" value={endDate()} onInput={(e) => setEndDate(e.currentTarget.value)} />
            </label>
            <div class="ml-auto flex items-center gap-2">
              <button class="terminal-button-secondary" onClick={() => run(loadSpotPrice)} disabled={busy()}>Spot</button>
              <button class="terminal-button" onClick={() => run(loadPriceChart)} disabled={busy()}>Load Chart</button>
            </div>
          </div>

          {/* ── Chart workspace ── */}
          <div class="chart-workspace">
            {/* Metrics sidebar */}
            <aside class="chart-sidebar">
              <div class="sidebar-metric">
                <span class="sidebar-label">Spot</span>
                <strong class="sidebar-value">{spot()}</strong>
              </div>
              <div class="sidebar-divider" />
              <div class="sidebar-metric">
                <span class="sidebar-label">Change</span>
                <strong class="sidebar-value">{change()}</strong>
              </div>
              <div class="sidebar-divider" />
              <div class="sidebar-metric">
                <span class="sidebar-label">Candles</span>
                <strong class="sidebar-value">{String(candleCount())}</strong>
              </div>
              <div class="mt-auto pt-4 sidebar-divider" />
              <div class="sidebar-status">
                <span class="sidebar-label">Status</span>
                <span class="sidebar-status-value">{chartStatus()}</span>
              </div>
            </aside>

            {/* Chart card */}
            <div class="chart-card">
              <div class="chart-card-header">
                <div>
                  <h2 class="chart-card-title">{symbol()}</h2>
                  <p class="chart-card-meta">{interval()} · Price candles · IST</p>
                </div>
                <div class="flex items-center gap-1.5 text-[10px] font-semibold" style="letter-spacing:0">
                  <span class={`h-1.5 w-1.5 rounded-full ${authed() ? "bg-emerald-400" : "bg-amber-400"}`}></span>
                  <span style={`color:${authed() ? "#34d399" : "#fbbf24"}`}>{authed() ? "Live" : "No session"}</span>
                </div>
              </div>
              <div class="chart-card-body" ref={(el) => { priceChartHost = el; initPriceChart(); queueChartResize(); }}></div>
            </div>
          </div>
        </Show>
      </main>
    </div>
  );
}

function Panel(props) {
  return (
    <section class="border border-gray-800 bg-[#12161A]">
      <div class="border-b border-gray-800 px-3 py-2">
        <div>
          <h3 class="text-sm font-semibold text-white">{props.title}</h3>
          <p class="text-[11px] readable-muted">{props.subtitle}</p>
        </div>
      </div>
      {props.children}
    </section>
  );
}

function Metric(props) {
  return (
    <div class="metric-item">
      <span class="metric-label">{props.label}</span>
      <strong class="metric-value">{props.value}</strong>
    </div>
  );
}

function OptionCell(props) {
  const n = Number(props.value);
  const hasValue = Number.isFinite(n);
  const display = () => {
    if (!hasValue) return "--";
    if (props.money) return formatMoney(n);
    if (props.compact) return formatCompact(n);
    return `${formatPlain(n, props.digits ?? 2)}${props.suffix || ""}`;
  };
  const className = () => [props.class, props.tone ? `chain-cell-${props.tone}` : ""].filter(Boolean).join(" ");
  return <td class={className()}>{display()}</td>;
}

render(() => <App />, document.getElementById("root"));
