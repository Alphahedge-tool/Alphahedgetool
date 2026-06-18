const $ = (id) => document.getElementById(id);

const state = {
  candles: [],
  view: { start: 0, end: 1 },
  priceRange: null,
  drag: null,
  lastPointer: null,
  theme: "dark"
};

const els = {
  environment: $("environment"),
  token: $("token"),
  deviceId: $("deviceId"),
  phone: $("phone"),
  authMethod: $("authMethod"),
  otp: $("otp"),
  mpin: $("mpin"),
  sendOtp: $("sendOtp"),
  verifyOtp: $("verifyOtp"),
  verifyMpin: $("verifyMpin"),
  loginStatus: $("loginStatus"),
  exchange: $("exchange"),
  instrumentType: $("instrumentType"),
  symbol: $("symbol"),
  symbols: $("symbols"),
  interval: $("interval"),
  chartType: $("chartType"),
  startDate: $("startDate"),
  endDate: $("endDate"),
  loadChart: $("loadChart"),
  loadInstruments: $("loadInstruments"),
  currentPrice: $("currentPrice"),
  spotValue: $("spotValue"),
  changeValue: $("changeValue"),
  candleCount: $("candleCount"),
  status: $("status"),
  chartTitle: $("chartTitle"),
  chartMeta: $("chartMeta"),
  fitChart: $("fitChart"),
  showAll: $("showAll"),
  toggleTheme: $("toggleTheme"),
  host: $("chartHost"),
  tvChart: $("tvChart"),
  gexTvChart: $("gexTvChart"),
  glCanvas: $("glCanvas"),
  overlayCanvas: $("overlayCanvas"),
  tooltip: $("tooltip")
};

const rupee = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2
});

const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const istDateTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

const loginState = {
  flowId: sessionStorage.getItem("nubraFlowId") || ""
};

const liveState = {
  socket: null,
  signature: "",
  enabled: false,
  lastCandleTime: 0,
  lastGexTime: 0,
  includeGex: false,
  backfillTimer: null,
  backfillInFlight: false,
  gexBackfillInFlight: false,
  animFrame: null,
  gexAnimFrame: null,
  optionCache: new Map(),
  gexSpot: 0
};

const tvState = {
  mainChart: null,
  candleSeries: null,
  lineSeries: null,
  gexChart: null,
  gexBaselineSeries: null,
  rollChart: null,
  rollBidSeries: null,
  rollAskSeries: null,
  syncLock: false
};

function setStatus(text) {
  els.status.textContent = text;
}

function toRupees(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n / 100 : null;
}

function fromLocalInput(value) {
  if (!value) return null;
  return new Date(value).toISOString();
}

function toLocalInput(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function seedDates() {
  const end = new Date();
  const start = new Date(end.getTime() - 6 * 60 * 60 * 1000);
  els.startDate.value = toLocalInput(start);
  els.endDate.value = toLocalInput(end);
  // seed GEX date picker to today in IST
  const istToday = new Date(end.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const gexDateEl = document.getElementById("gexDate");
  if (gexDateEl) gexDateEl.value = istToday;
  const rollStartEl = document.getElementById("rollStart");
  const rollEndEl = document.getElementById("rollEnd");
  if (rollStartEl && rollEndEl) {
    const rollEnd = new Date();
    const rollStart = new Date(rollEnd.getTime() - 30 * 60 * 1000);
    rollStartEl.value = toLocalInput(rollStart);
    rollEndEl.value = toLocalInput(rollEnd);
  }
}

function todayIstDate() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function istClockMinutes(timeMs = Date.now()) {
  const ist = new Date(timeMs + 5.5 * 3600 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function isAfterMarketClose(timeMs = Date.now()) {
  return istClockMinutes(timeMs) >= 15 * 60 + 30;
}

function stopLiveAfterClose() {
  if (liveState.enabled) {
    stopLiveSocket();
    setStatus("Closed");
    gexEls.status.textContent = "Market closed";
  }
}

function localInputDate(value) {
  return value ? value.slice(0, 10) : "";
}

function selectedChartIsToday() {
  const today = todayIstDate();
  return localInputDate(els.endDate.value) === today || gexHistEls?.gexDate?.value === today;
}

function seedAuth() {
  els.token.value = localStorage.getItem("nubraSessionToken") || "";
  els.deviceId.value = localStorage.getItem("nubraDeviceId") || "";
  els.phone.value = localStorage.getItem("nubraPhone") || "";
  els.authMethod.value = localStorage.getItem("nubraAuthMethod") || "otp";
  if (!els.deviceId.value && els.phone.value) {
    els.deviceId.value = deviceIdForPhone(els.phone.value);
  }
  if (els.deviceId.value) localStorage.setItem("nubraDeviceId", els.deviceId.value);
  els.loginStatus.textContent = els.token.value ? "Session token loaded" : "Not logged in";
}

function saveAuthInputs() {
  localStorage.setItem("nubraDeviceId", els.deviceId.value.trim());
  localStorage.setItem("nubraPhone", els.phone.value.trim());
  localStorage.setItem("nubraAuthMethod", els.authMethod.value);
}

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

function deviceIdForPhone(phone) {
  return `Nubra-OSS-${digits(phone)}`;
}

function authHeaders(contentType = "application/json") {
  const token = els.token.value.trim();
  const deviceId = els.deviceId.value.trim();
  if (!token || !deviceId) {
    throw new Error("Session token and device ID are required.");
  }

  return {
    Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
    "x-device-id": deviceId,
    "content-type": contentType
  };
}

async function nubraFetch(path, options = {}) {
  const base = els.environment.value;
  const target = new URL(path, `${base}/`);
  const proxyUrl = `/api/proxy?url=${encodeURIComponent(target.toString())}`;
  const response = await fetch(proxyUrl, {
    ...options,
    headers: {
      ...authHeaders(options.contentType),
      ...(options.headers || {})
    }
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

async function nubraRawFetch(path, options = {}) {
  const base = els.environment.value;
  const target = new URL(path, `${base}/`);
  const proxyUrl = `/api/proxy?url=${encodeURIComponent(target.toString())}`;
  const response = await fetch(proxyUrl, {
    method: options.method || "GET",
    headers: options.headers || { "content-type": "application/json" },
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

async function sendOtp() {
  const phone = digits(els.phone.value);
  if (phone.length < 10) throw new Error("Enter a valid Nubra phone number.");
  els.phone.value = phone;
  els.deviceId.value = deviceIdForPhone(phone);
  saveAuthInputs();
  setStatus("OTP");
  els.loginStatus.textContent = els.authMethod.value === "totp" ? "TOTP mode ready. Enter authenticator code." : "Starting OTP login";

  const response = await fetch("/api/auth/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      phone,
      auth_method: els.authMethod.value,
      environment: els.environment.value.includes("uat") ? "UAT" : "PROD"
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || data.message || "Unable to start Nubra login.");

  loginState.flowId = data.flow_id || "";
  sessionStorage.setItem("nubraFlowId", loginState.flowId);
  if (data.device_id) {
    els.deviceId.value = data.device_id;
    localStorage.setItem("nubraDeviceId", data.device_id);
  }
  els.loginStatus.textContent = data.message || (els.authMethod.value === "totp" ? "Enter TOTP." : "OTP sent. Enter OTP and verify.");
  setStatus(els.authMethod.value === "totp" ? "TOTP" : "OTP sent");
}

async function verifyOtp() {
  const phone = digits(els.phone.value);
  const otp = els.otp.value.trim();
  if (!phone || !otp) throw new Error("Phone and OTP are required.");
  if (!loginState.flowId) throw new Error("Start login first.");
  saveAuthInputs();
  setStatus("Verify");

  const endpoint = els.authMethod.value === "totp" ? "/api/auth/verify-totp" : "/api/auth/verify-otp";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(els.authMethod.value === "totp"
      ? { flow_id: loginState.flowId, totp: otp }
      : { flow_id: loginState.flowId, otp })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || data.message || "Verification failed.");

  els.loginStatus.textContent = data.message || "Code verified. Enter MPIN.";
  setStatus("OTP ok");
}

async function verifyMpin() {
  const pin = els.mpin.value.trim();
  if (!pin) throw new Error("MPIN is required.");
  if (!loginState.flowId) throw new Error("Start login first.");
  saveAuthInputs();
  setStatus("MPIN");

  const response = await fetch("/api/auth/verify-mpin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ flow_id: loginState.flowId, mpin: pin })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || data.message || "MPIN incorrect.");

  const sessionToken = data?.access_token || "";
  if (!sessionToken) throw new Error("Nubra did not return session_token.");
  els.token.value = sessionToken;
  if (data.device_id) {
    els.deviceId.value = data.device_id;
    localStorage.setItem("nubraDeviceId", data.device_id);
  }
  els.mpin.value = "";
  els.otp.value = "";
  localStorage.setItem("nubraSessionToken", sessionToken);
  sessionStorage.removeItem("nubraFlowId");
  loginState.flowId = "";
  els.loginStatus.textContent = data.message || `Logged in as ${data.account_id ?? "Nubra User"}`;
  setStatus("Logged in");
}

async function loadInstruments() {
  setStatus("Lookup");
  const date = new Date().toISOString().slice(0, 10);
  const exchange = els.exchange.value;
  const data = await nubraFetch(`refdata/refdata/${date}?exchange=${exchange}`, { method: "GET" });
  const items = Array.isArray(data.refdata) ? data.refdata : [];
  const term = els.symbol.value.trim().toUpperCase();
  const matches = items
    .filter((item) => {
      const haystack = `${item.stock_name || ""} ${item.asset || ""} ${item.zanskar_name || ""}`.toUpperCase();
      return !term || haystack.includes(term);
    })
    .slice(0, 80);

  els.symbols.innerHTML = "";
  for (const item of matches) {
    const option = document.createElement("option");
    option.value = item.stock_name || item.asset || "";
    option.label = `${item.exchange} ${item.derivative_type} ref:${item.ref_id} ${item.asset || ""}`;
    els.symbols.appendChild(option);
  }
  setStatus(`${matches.length} found`);
}

async function loadCurrentPrice() {
  setStatus("Spot");
  const symbol = els.symbol.value.trim().toUpperCase();
  const exchange = els.exchange.value;
  if (!symbol) throw new Error("Symbol is required.");
  const suffix = exchange === "BSE" ? `?exchange=BSE` : "";
  const data = await nubraFetch(`optionchains/${encodeURIComponent(symbol)}/price${suffix}`, { method: "GET" });
  const price = toRupees(data.price);
  const prevClose = toRupees(data.prev_close);
  els.spotValue.textContent = price == null ? "--" : rupee.format(price);
  els.changeValue.textContent = Number.isFinite(data.change) ? `${number.format(data.change)}%` : "--";
  els.chartMeta.textContent = `Spot ${price == null ? "--" : rupee.format(price)} | Prev close ${prevClose == null ? "--" : rupee.format(prevClose)} | UTC+5:30`;
  setStatus("Ready");
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

function mergeCandles(symbolData) {
  const fields = ["open", "high", "low", "close"];
  const byTs = new Map();

  for (const field of fields) {
    const points = Array.isArray(symbolData?.[field]) ? symbolData[field] : [];
    for (const point of points) {
      const ts = Number(point.ts ?? point.timestamp);
      const value = toRupees(point.v ?? point.value);
      if (!Number.isFinite(ts) || value == null) continue;
      const ms = Math.floor(ts / 1_000_000);
      const candle = byTs.get(ms) || { time: ms, open: null, high: null, low: null, close: null };
      candle[field] = value;
      byTs.set(ms, candle);
    }
  }

  return [...byTs.values()]
    .filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite))
    .sort((a, b) => a.time - b.time);
}

function intervalMs(interval = els.interval.value) {
  const value = String(interval || "1m").trim();
  const n = Number.parseInt(value, 10) || 1;
  if (value.endsWith("s")) return n * 1000;
  if (value.endsWith("h")) return n * 60 * 60 * 1000;
  if (value.endsWith("d")) return n * 24 * 60 * 60 * 1000;
  return n * 60 * 1000;
}

function bucketStartMs(timeMs, stepMs = intervalMs()) {
  return Math.floor(timeMs / stepMs) * stepMs;
}

function appendOrReplaceCandle(candle) {
  const next = state.candles.filter((point) => point.time !== candle.time);
  next.push(candle);
  state.candles = next.sort((a, b) => a.time - b.time);
  els.candleCount.textContent = String(state.candles.length);
}

function appendOrReplaceGexPoint(point) {
  const next = gexHist.points.filter((item) => item.time !== point.time);
  next.push(point);
  gexHist.points = next.sort((a, b) => a.time - b.time);
}

function mergeCandleList(nextCandles) {
  const byTime = new Map(state.candles.map((candle) => [candle.time, candle]));
  for (const candle of nextCandles) {
    if ([candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) {
      byTime.set(candle.time, candle);
    }
  }
  state.candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  els.candleCount.textContent = String(state.candles.length);
}

async function backfillCandlesQuietly(startMs, endMs = Date.now()) {
  if (liveState.backfillInFlight) return;
  const symbol = els.symbol.value.trim().toUpperCase();
  if (!symbol || !els.token.value.trim() || !els.deviceId.value.trim()) return;

  liveState.backfillInFlight = true;
  try {
    const payload = {
      query: [{
        exchange: els.exchange.value,
        type: els.instrumentType.value,
        values: [symbol],
        fields: ["open", "high", "low", "close", "cumulative_volume"],
        startDate: new Date(startMs).toISOString(),
        endDate: new Date(endMs).toISOString(),
        interval: els.interval.value,
        intraDay: false,
        realTime: false
      }]
    };
    const data = await nubraFetch("charts/timeseries", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const candles = mergeCandles(extractSymbolData(data, symbol));
    if (!candles.length) return;
    mergeCandleList(candles);
    setTvMainData({ fit: false });
    const last = state.candles[state.candles.length - 1];
    if (last) liveState.lastCandleTime = Math.max(liveState.lastCandleTime, last.time);
    render();
  } catch (error) {
    console.warn("[Live] quiet candle backfill failed:", error.message);
  } finally {
    liveState.backfillInFlight = false;
  }
}

async function backfillGexQuietly() {
  if (liveState.gexBackfillInFlight) return;
  liveState.gexBackfillInFlight = true;
  const statusText = gexEls.status.textContent;
  try {
    await loadDayGex();
    gexEls.status.textContent = statusText;
  } catch (error) {
    console.warn("[Live] quiet GEX backfill failed:", error.message);
  } finally {
    liveState.gexBackfillInFlight = false;
  }
}

async function loadChart() {
  setStatus("Loading");
  const symbol = els.symbol.value.trim().toUpperCase();
  if (!symbol) throw new Error("Symbol is required.");

  const payload = {
    query: [
      {
        exchange: els.exchange.value,
        type: els.instrumentType.value,
        values: [symbol],
        fields: ["open", "high", "low", "close", "cumulative_volume"],
        startDate: fromLocalInput(els.startDate.value),
        endDate: fromLocalInput(els.endDate.value),
        interval: els.interval.value,
        intraDay: false,
        realTime: false
      }
    ]
  };

  const data = await nubraFetch("charts/timeseries", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  const symbolData = extractSymbolData(data, symbol);
  state.candles = mergeCandles(symbolData);
  setTvMainData();
  focusRecentCandles();
  els.candleCount.textContent = String(state.candles.length);
  els.chartTitle.textContent = `${symbol} ${els.interval.value}`;
  els.chartMeta.textContent = `${els.exchange.value} ${els.instrumentType.value} | Prices in rupees | UTC+5:30`;
  setStatus(state.candles.length ? "Ready" : "No data");
  if (selectedChartIsToday()) {
    startLiveSocket({ includeGex: Boolean(gexEls?.expiry?.value) });
  }
}

function fitChart() {
  state.priceRange = null;
  if (tvState.mainChart) tvState.mainChart.timeScale().fitContent();
  render();
}

function showAllCandles() {
  state.view.start = 0;
  state.view.end = Math.max(1, state.candles.length - 1);
  state.priceRange = null;
  if (tvState.mainChart) tvState.mainChart.timeScale().fitContent();
  render();
}

function focusRecentCandles() {
  const maxIndex = Math.max(1, state.candles.length - 1);
  const rect = els.host.getBoundingClientRect();
  const targetBars = Math.max(90, Math.min(240, Math.floor(rect.width / 5.8)));
  state.view.end = maxIndex;
  state.view.start = Math.max(0, maxIndex - Math.min(targetBars, maxIndex));
  state.priceRange = null;
  if (tvState.mainChart) {
    const from = tvTime(state.candles[Math.floor(state.view.start)]?.time || state.candles[0]?.time || Date.now());
    const to = tvTime(state.candles[Math.ceil(state.view.end)]?.time || state.candles[state.candles.length - 1]?.time || Date.now());
    tvState.mainChart.timeScale().setVisibleRange({ from, to });
  }
  render();
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function resizeCanvas(canvas) {
  const rect = els.host.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height, dpr };
}

function visibleCandles() {
  const start = Math.max(0, Math.floor(state.view.start));
  const end = Math.min(state.candles.length - 1, Math.ceil(state.view.end));
  return state.candles.slice(start, end + 1);
}

function visibleTimeDomain() {
  const startIdx = Math.max(0, Math.floor(state.view.start));
  const endIdx = Math.min(state.candles.length - 1, Math.ceil(state.view.end));
  const start = state.candles[startIdx]?.time;
  const end = state.candles[endIdx]?.time;
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) return { start, end };
  if (gexHist.points.length > 1) {
    return {
      start: gexHist.points[0].time,
      end: gexHist.points[gexHist.points.length - 1].time
    };
  }
  return null;
}

function xForTime(time, scale, domain = visibleTimeDomain()) {
  if (!domain || domain.end <= domain.start) return scale.left;
  return scale.left + ((time - domain.start) / (domain.end - domain.start)) * scale.plotW;
}

function timeTicks(domain, count = 8) {
  if (!domain) return [];
  const ticks = [];
  const step = (domain.end - domain.start) / Math.max(1, count - 1);
  for (let i = 0; i < count; i++) ticks.push(domain.start + step * i);
  return ticks;
}

function bounds(candles) {
  if (state.priceRange) return state.priceRange;
  if (!candles.length) return { min: 0, max: 1 };
  let min = Infinity;
  let max = -Infinity;
  for (const c of candles) {
    min = Math.min(min, c.low);
    max = Math.max(max, c.high);
  }
  const pad = Math.max((max - min) * 0.08, 0.01);
  return { min: min - pad, max: max + pad };
}

function makeScale(width, height, candles) {
  const pad = { left: 14, right: 92, top: 20, bottom: 46 };
  const plotW = Math.max(1, width - pad.left - pad.right);
  const plotH = Math.max(1, height - pad.top - pad.bottom);
  const b = bounds(candles);
  const start = state.view.start;
  const span = Math.max(1, state.view.end - state.view.start);
  const x = (index) => pad.left + ((index - start) / span) * plotW;
  const y = (price) => pad.top + (1 - (price - b.min) / (b.max - b.min)) * plotH;
  return { ...pad, plotW, plotH, min: b.min, max: b.max, x, y };
}

function clampView() {
  const maxIndex = Math.max(1, state.candles.length - 1);
  let span = Math.max(3, state.view.end - state.view.start);
  span = Math.min(span, maxIndex);
  if (state.view.start < 0) {
    state.view.start = 0;
    state.view.end = span;
  }
  if (state.view.end > maxIndex) {
    state.view.end = maxIndex;
    state.view.start = Math.max(0, maxIndex - span);
  }
}

function ensurePriceRange() {
  if (!state.priceRange) {
    state.priceRange = bounds(visibleCandles());
  }
}

function zoomTime(anchorRatio, factor) {
  if (!state.candles.length) return;
  const maxIndex = Math.max(1, state.candles.length - 1);
  const span = state.view.end - state.view.start;
  const nextSpan = Math.max(4, Math.min(maxIndex, span * factor));
  const anchor = state.view.start + span * anchorRatio;
  state.view.start = anchor - nextSpan * anchorRatio;
  state.view.end = state.view.start + nextSpan;
  clampView();
}

function panTime(deltaCandles) {
  if (!state.candles.length) return;
  state.view.start += deltaCandles;
  state.view.end += deltaCandles;
  clampView();
}

function zoomPrice(anchorRatio, factor) {
  ensurePriceRange();
  const range = state.priceRange.max - state.priceRange.min;
  const nextRange = Math.max(0.01, range * factor);
  const anchor = state.priceRange.max - range * anchorRatio;
  state.priceRange = {
    min: anchor - nextRange * (1 - anchorRatio),
    max: anchor + nextRange * anchorRatio
  };
}

function panPrice(deltaRatio) {
  ensurePriceRange();
  const range = state.priceRange.max - state.priceRange.min;
  const delta = range * deltaRatio;
  state.priceRange = {
    min: state.priceRange.min + delta,
    max: state.priceRange.max + delta
  };
}

function panPriceFromRange(baseRange, deltaRatio) {
  const range = baseRange.max - baseRange.min;
  const delta = range * deltaRatio;
  state.priceRange = {
    min: baseRange.min + delta,
    max: baseRange.max + delta
  };
}

function hitZone(event) {
  const rect = els.host.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const scale = makeScale(rect.width, rect.height, visibleCandles());
  if (x >= rect.width - scale.right) return "price";
  if (y >= rect.height - scale.bottom) return "time";
  return "plot";
}

function renderGl(width, height, dpr, candles, scale) {
  const gl = els.glCanvas.getContext("webgl", { antialias: false });
  if (!gl) return;
  gl.viewport(0, 0, width, height);
  const bg = parseColor(cssVar("--panel"));
  gl.clearColor(bg[0], bg[1], bg[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const vertex = `
    attribute vec2 a_position;
    uniform vec2 u_resolution;
    void main() {
      vec2 zeroToOne = a_position / u_resolution;
      vec2 clip = zeroToOne * 2.0 - 1.0;
      gl_Position = vec4(clip * vec2(1, -1), 0, 1);
    }
  `;
  const fragment = `
    precision mediump float;
    uniform vec4 u_color;
    void main() { gl_FragColor = u_color; }
  `;

  const program = createProgram(gl, vertex, fragment);
  gl.useProgram(program);
  const position = gl.getAttribLocation(program, "a_position");
  const resolution = gl.getUniformLocation(program, "u_resolution");
  const color = gl.getUniformLocation(program, "u_color");
  const cssW = width / dpr;
  const cssH = height / dpr;
  gl.uniform2f(resolution, cssW, cssH);
  gl.enableVertexAttribArray(position);

  if (els.chartType.value === "line") {
    const vertices = [];
    for (let i = 0; i < state.candles.length; i++) {
      const c = state.candles[i];
      if (i < state.view.start || i > state.view.end) continue;
      vertices.push(scale.x(i), scale.y(c.close));
    }
    drawVertices(gl, position, color, vertices, cssVar("--accent"), gl.LINE_STRIP);
    return;
  }

  const up = [];
  const down = [];
  const wickUp = [];
  const wickDown = [];
  const barSpacing = scale.plotW / Math.max(1, state.view.end - state.view.start);
  const candleW = Math.max(1, Math.min(18 / dpr, barSpacing * 0.72));
  const denseMode = barSpacing < 3.2;
  for (let i = 0; i < state.candles.length; i++) {
    const c = state.candles[i];
    if (i < state.view.start || i > state.view.end) continue;
    const target = c.close >= c.open ? up : down;
    const wick = c.close >= c.open ? wickUp : wickDown;
    const x = scale.x(i);
    const yOpen = scale.y(c.open);
    const yClose = scale.y(c.close);
    const yHigh = scale.y(c.high);
    const yLow = scale.y(c.low);
    const top = Math.min(yOpen, yClose);
    const bottom = Math.max(yOpen, yClose);
    const crispX = Math.round(x * dpr) / dpr + 0.5 / dpr;
    wick.push(crispX, yHigh, crispX, yLow);
    if (denseMode) {
      target.push(crispX, yOpen, crispX, yClose);
    } else {
      rect(target, Math.round((x - candleW / 2) * dpr) / dpr + 0.5 / dpr, top, candleW, Math.max(1 / dpr, bottom - top));
    }
  }
  drawVertices(gl, position, color, wickUp, cssVar("--up"), gl.LINES);
  drawVertices(gl, position, color, wickDown, cssVar("--down"), gl.LINES);
  drawVertices(gl, position, color, up, cssVar("--up"), denseMode ? gl.LINES : gl.TRIANGLES);
  drawVertices(gl, position, color, down, cssVar("--down"), denseMode ? gl.LINES : gl.TRIANGLES);
}

function rect(out, x, y, w, h) {
  out.push(x, y, x + w, y, x, y + h, x, y + h, x + w, y, x + w, y + h);
}

function drawVertices(gl, position, color, vertices, cssColor, mode) {
  if (!vertices.length) return;
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const rgba = parseColor(cssColor);
  gl.uniform4f(color, rgba[0], rgba[1], rgba[2], 1);
  gl.drawArrays(mode, 0, vertices.length / 2);
  gl.deleteBuffer(buffer);
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  return program;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

function parseColor(color) {
  const probe = document.createElement("span");
  probe.style.color = color;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color.match(/\d+/g).map(Number);
  probe.remove();
  return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
}

function tvTime(ms) {
  return Math.floor(ms / 1000);
}

function lwTimeSeconds(time) {
  if (typeof time === "number") return time;
  if (time && typeof time.timestamp === "number") return time.timestamp;
  if (time && typeof time.year === "number") {
    return Date.UTC(time.year, time.month - 1, time.day) / 1000;
  }
  return Date.now() / 1000;
}

function formatLwIstTime(time) {
  return istDateTime.format(new Date(lwTimeSeconds(time) * 1000));
}

function tvChartOptions() {
  return {
    autoSize: true,
    layout: {
      background: { type: "solid", color: cssVar("--panel") },
      textColor: cssVar("--muted"),
      fontFamily: "Inter, system-ui, sans-serif"
    },
    grid: {
      vertLines: { color: cssVar("--grid") },
      horzLines: { color: cssVar("--grid") }
    },
    rightPriceScale: {
      borderColor: cssVar("--line"),
      scaleMargins: { top: 0.08, bottom: 0.12 }
    },
    timeScale: {
      borderColor: cssVar("--line"),
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 8,
      barSpacing: 8,
      tickMarkFormatter: formatLwIstTime
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: cssVar("--accent-2"), style: 2, width: 1 },
      horzLine: { color: cssVar("--accent-2"), style: 2, width: 1 }
    },
    localization: {
      locale: "en-IN",
      timeFormatter: formatLwIstTime
    }
  };
}

function initTvCharts() {
  if (!window.LightweightCharts || tvState.mainChart) return;

  tvState.mainChart = LightweightCharts.createChart(els.tvChart, tvChartOptions());
  tvState.candleSeries = tvState.mainChart.addCandlestickSeries
    ? tvState.mainChart.addCandlestickSeries({
    upColor: cssVar("--up"),
    downColor: cssVar("--down"),
    borderUpColor: cssVar("--up"),
    borderDownColor: cssVar("--down"),
    wickUpColor: cssVar("--up"),
    wickDownColor: cssVar("--down")
  })
    : tvState.mainChart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: cssVar("--up"),
      downColor: cssVar("--down"),
      borderUpColor: cssVar("--up"),
      borderDownColor: cssVar("--down"),
      wickUpColor: cssVar("--up"),
      wickDownColor: cssVar("--down")
    });
  tvState.lineSeries = tvState.mainChart.addLineSeries
    ? tvState.mainChart.addLineSeries({
    color: cssVar("--accent"),
    lineWidth: 2,
    visible: false
  })
    : tvState.mainChart.addSeries(LightweightCharts.LineSeries, {
      color: cssVar("--accent"),
      lineWidth: 2,
      visible: false
    });

  tvState.gexChart = LightweightCharts.createChart(els.gexTvChart, {
    ...tvChartOptions(),
    rightPriceScale: {
      borderColor: cssVar("--line"),
      scaleMargins: { top: 0.12, bottom: 0.12 }
    },
    timeScale: {
      borderColor: cssVar("--line"),
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 8,
      barSpacing: 8,
      tickMarkFormatter: formatLwIstTime
    }
  });
  const baselineOptions = {
    baseValue: { type: "price", price: 0 },
    topLineColor: cssVar("--up"),
    topFillColor1: "rgba(18,214,160,0.30)",
    topFillColor2: "rgba(18,214,160,0.04)",
    bottomLineColor: cssVar("--down"),
    bottomFillColor1: "rgba(255,91,103,0.04)",
    bottomFillColor2: "rgba(255,91,103,0.30)",
    lineWidth: 2,
    priceFormat: { type: "volume" }
  };
  tvState.gexBaselineSeries = tvState.gexChart.addBaselineSeries
    ? tvState.gexChart.addBaselineSeries(baselineOptions)
    : tvState.gexChart.addSeries(LightweightCharts.BaselineSeries, baselineOptions);

  tvState.mainChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (tvState.syncLock || !range) return;
    tvState.syncLock = true;
    tvState.gexChart.timeScale().setVisibleLogicalRange(range);
    tvState.syncLock = false;
  });

  tvState.gexChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (tvState.syncLock || !range) return;
    tvState.syncLock = true;
    tvState.mainChart.timeScale().setVisibleLogicalRange(range);
    tvState.syncLock = false;
  });
}

function setTvMainData({ fit = true } = {}) {
  initTvCharts();
  if (!tvState.mainChart) return;
  const candleData = state.candles.map((c) => ({
    time: tvTime(c.time),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close
  }));
  const lineData = state.candles.map((c) => ({ time: tvTime(c.time), value: c.close }));
  tvState.candleSeries.setData(candleData);
  tvState.lineSeries.setData(lineData);
  const lineMode = els.chartType.value === "line";
  tvState.candleSeries.applyOptions({ visible: !lineMode });
  tvState.lineSeries.applyOptions({ visible: lineMode });
  if (fit) tvState.mainChart.timeScale().fitContent();
}

function updateTvCandle(candle) {
  initTvCharts();
  if (!tvState.mainChart || !tvState.candleSeries || !tvState.lineSeries) return;
  const time = tvTime(candle.time);
  tvState.candleSeries.update({
    time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close
  });
  tvState.lineSeries.update({ time, value: candle.close });
  const lineMode = els.chartType.value === "line";
  tvState.candleSeries.applyOptions({ visible: !lineMode });
  tvState.lineSeries.applyOptions({ visible: lineMode });
  const timeScale = tvState.mainChart.timeScale();
  if (timeScale.scrollToRealTime) timeScale.scrollToRealTime();
}

function setTvGexData() {
  initTvCharts();
  if (!tvState.gexBaselineSeries) return;
  const data = gexHist.points.map((p) => ({
    time: tvTime(p.time),
    value: p.netGex
  }));
  tvState.gexBaselineSeries.setData(data);
  const range = tvState.mainChart?.timeScale().getVisibleLogicalRange();
  if (range) tvState.gexChart.timeScale().setVisibleLogicalRange(range);
  else tvState.gexChart.timeScale().fitContent();
}

function updateTvGexPoint(point) {
  initTvCharts();
  if (!tvState.gexBaselineSeries) return;
  tvState.gexBaselineSeries.update({
    time: tvTime(point.time),
    value: point.netGex
  });
}

function animateTvGexPoint(point, fromValue) {
  if (liveState.gexAnimFrame) cancelAnimationFrame(liveState.gexAnimFrame);
  const start = performance.now();
  const duration = 260;
  const baseValue = Number.isFinite(fromValue) ? fromValue : point.netGex;

  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const netGex = baseValue + (point.netGex - baseValue) * eased;
    updateTvGexPoint({ ...point, netGex });
    if (t < 1) liveState.gexAnimFrame = requestAnimationFrame(frame);
    else {
      liveState.gexAnimFrame = null;
      updateTvGexPoint(point);
    }
  }

  liveState.gexAnimFrame = requestAnimationFrame(frame);
}

function streamMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Date.now();
  if (n > 1_000_000_000_000_000) return Math.floor(n / 1_000_000);
  if (n > 1_000_000_000_000) return n;
  return n * 1000;
}

function animateTvCandle(candle, fromClose) {
  if (liveState.animFrame) cancelAnimationFrame(liveState.animFrame);
  const start = performance.now();
  const duration = 260;
  const baseClose = Number.isFinite(fromClose) ? fromClose : candle.open;

  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const close = baseClose + (candle.close - baseClose) * eased;
    updateTvCandle({
      ...candle,
      close,
      high: Math.max(candle.high, close),
      low: Math.min(candle.low, close)
    });
    if (t < 1) liveState.animFrame = requestAnimationFrame(frame);
    else {
      liveState.animFrame = null;
      updateTvCandle(candle);
    }
  }

  liveState.animFrame = requestAnimationFrame(frame);
}

function upsertLiveCandle(raw) {
  if (isAfterMarketClose()) {
    stopLiveAfterClose();
    return;
  }
  const step = intervalMs();
  const rawTime = streamMs(raw.bucket_timestamp ?? raw.timestamp);
  const bucketTime = bucketStartMs(rawTime, step);
  const previousLast = state.candles[state.candles.length - 1];
  const updateTime = previousLast && bucketTime < previousLast.time ? previousLast.time : bucketTime;
  const candle = {
    time: updateTime,
    open: toRupees(raw.open) ?? Number(raw.open),
    high: toRupees(raw.high) ?? Number(raw.high),
    low: toRupees(raw.low) ?? Number(raw.low),
    close: toRupees(raw.close) ?? Number(raw.close)
  };
  if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) return;

  if (previousLast && updateTime - previousLast.time > step * 1.5) {
    backfillCandlesQuietly(previousLast.time + step, candle.time + step);
  }

  const existing = state.candles.find((item) => item.time === candle.time);
  const previousClose = existing?.close ?? previousLast?.close;
  appendOrReplaceCandle(candle);
  liveState.lastCandleTime = Math.max(liveState.lastCandleTime, candle.time);
  els.spotValue.textContent = rupee.format(candle.close);
  els.chartMeta.textContent = `Live ${els.exchange.value} ${els.instrumentType.value} | ${els.interval.value} | UTC+5:30`;

  animateTvCandle(candle, previousClose);
  const maxIndex = Math.max(1, state.candles.length - 1);
  const span = Math.max(3, state.view.end - state.view.start);
  const wasAtRight = !previousLast || state.view.end >= Math.max(1, state.candles.length - 2);
  if (wasAtRight) {
    state.view.end = maxIndex;
    state.view.start = Math.max(0, maxIndex - span);
  }
  render();
}

function startLiveBackfillMonitor() {
  clearInterval(liveState.backfillTimer);
  liveState.backfillTimer = setInterval(() => {
    if (!liveState.enabled || !selectedChartIsToday()) return;
    if (isAfterMarketClose()) {
      stopLiveAfterClose();
      return;
    }
    const last = state.candles[state.candles.length - 1];
    const lastTime = Math.max(liveState.lastCandleTime || 0, last?.time || 0);
    if (!lastTime) return;
    const step = intervalMs();
    if (Date.now() - lastTime > step + 20_000) {
      backfillCandlesQuietly(lastTime + step, Date.now());
    }
    if (liveState.includeGex && liveState.lastGexTime && Date.now() - liveState.lastGexTime > 80_000) {
      backfillGexQuietly();
    }
  }, 15_000);
}

function optionCacheKey(item, side) {
  const refId = item.ref_id ?? item.refId;
  if (refId != null) return `${side}:ref:${refId}`;
  const strike = toRupees(item.strike_price ?? item.sp) ?? Number(item.strike_price ?? item.sp);
  return `${side}:strike:${strike}`;
}

function updateOptionCache(chain, side) {
  const items = side === "CE" ? chain.ce : chain.pe;
  for (const item of Array.isArray(items) ? items : []) {
    const key = optionCacheKey(item, side);
    const prev = liveState.optionCache.get(key) || { side };
    const strike = toRupees(item.strike_price ?? item.sp) ?? Number(item.strike_price ?? item.sp);
    const gamma = Number(item.gamma);
    const oi = Number(item.open_interest ?? item.oi);
    const lotSize = Number(item.lot_size ?? item.ls);
    liveState.optionCache.set(key, {
      ...prev,
      side,
      strike: Number.isFinite(strike) ? strike : prev.strike,
      gamma: Number.isFinite(gamma) ? gamma : prev.gamma,
      oi: Number.isFinite(oi) ? oi : prev.oi,
      lotSize: Number.isFinite(lotSize) && lotSize > 0 ? lotSize : prev.lotSize
    });
  }
}

function optionRowsFromStream(chain, receivedAtMs = Date.now()) {
  if (typeof chain === "string") {
    try {
      chain = JSON.parse(chain);
    } catch {
      return null;
    }
  }
  if (!chain || typeof chain !== "object") return null;
  const nextSpot = toRupees(chain.current_price) ?? Number(chain.current_price);
  if (Number.isFinite(nextSpot) && nextSpot > 0) liveState.gexSpot = nextSpot;
  const spot = liveState.gexSpot || gexState.spot;
  if (!Number.isFinite(spot) || spot <= 0) return null;

  updateOptionCache(chain, "CE");
  updateOptionCache(chain, "PE");

  const rowsByStrike = new Map();
  let callGex = 0;
  let putGex = 0;
  let grossGex = 0;
  let usableLegs = 0;
  const tickTime = Number.isFinite(Number(receivedAtMs)) ? Number(receivedAtMs) : Date.now();

  for (const cached of liveState.optionCache.values()) {
    const lotSize = Number(cached.lotSize) || lotFallback(chain.asset || gexEls.symbol.value);
    const gamma = Number(cached.gamma);
    const oi = Number(cached.oi);
    const strike = Number(cached.strike);
    if (!Number.isFinite(strike) || !Number.isFinite(gamma) || !Number.isFinite(oi) || oi <= 0 || gamma === 0) continue;
    const signedGex = gexCr(gamma, oi, lotSize, spot) * (cached.side === "CE" ? 1 : -1);
    if (!Number.isFinite(signedGex) || signedGex === 0) continue;
    usableLegs += 1;
    if (cached.side === "CE") callGex += signedGex;
    else putGex += signedGex;
    grossGex += Math.abs(signedGex);
    const row = rowsByStrike.get(strike) || { strike, callGex: 0, putGex: 0, netGex: 0 };
    if (cached.side === "CE") row.callGex += signedGex;
    else row.putGex += signedGex;
    row.netGex = row.callGex + row.putGex;
    rowsByStrike.set(strike, row);
  }

  if (!usableLegs || !rowsByStrike.size || grossGex <= 0) return null;
  return {
    time: bucketStartMs(tickTime, 60_000),
    spot,
    callGex,
    putGex,
    grossGex,
    netGex: callGex + putGex,
    strikes: [...rowsByStrike.values()].sort((a, b) => a.strike - b.strike)
  };
}

function upsertGexSnapshot(point) {
  if (isAfterMarketClose()) {
    stopLiveAfterClose();
    return;
  }
  if (!point || !Number.isFinite(point.grossGex) || point.grossGex <= 0 || !Array.isArray(point.strikes) || !point.strikes.length) {
    return;
  }
  const prev = gexHist.points[gexHist.points.length - 1];
  const step = 60_000;
  const updateTime = prev && point.time < prev.time ? prev.time : point.time;
  const nextPoint = { ...point, time: updateTime };
  const existing = gexHist.points.find((item) => item.time === nextPoint.time);
  const fromValue = existing?.netGex ?? prev?.netGex;
  if (prev && updateTime - prev.time > step * 1.5) {
    backfillGexQuietly();
  }
  if (!prev || prev.time !== nextPoint.time) {
    if (prev) {
      const prevSign = Math.sign(prev.netGex);
      const currSign = Math.sign(nextPoint.netGex);
      if (prevSign !== 0 && currSign !== 0 && prevSign !== currSign) {
        gexHist.flips.push({ time: nextPoint.time, from: prevSign, to: currSign });
      }
    }
  }
  appendOrReplaceGexPoint(nextPoint);
  liveState.lastGexTime = Math.max(liveState.lastGexTime, nextPoint.time);

  const flipLevel = calcFlipLevel(gexState.strikes);
  gexHistEls.regime.textContent = nextPoint.netGex >= 0 ? "POSITIVE" : "NEGATIVE";
  gexHistEls.regime.className = `gex-regime-badge ${nextPoint.netGex >= 0 ? "positive" : "negative"}`;
  gexHistEls.flipsLbl.textContent = `${gexHist.flips.length} flip${gexHist.flips.length !== 1 ? "s" : ""}`;
  gexHistEls.pointsLbl.textContent = `${gexHist.points.length} pts`;
  gexEls.stats.hidden = false;
  gexEls.net.textContent = gexFmt(nextPoint.netGex);
  gexEls.net.style.color = nextPoint.netGex >= 0 ? "var(--up)" : "var(--down)";
  gexEls.call.textContent = gexFmt(nextPoint.callGex);
  gexEls.put.textContent = gexFmt(nextPoint.putGex);
  gexEls.spot.textContent = nextPoint.spot ? rupee.format(nextPoint.spot) : "--";
  gexEls.flip.textContent = flipLevel ? rupee.format(flipLevel) : "--";
  gexEls.meta.textContent = `Live Net GEX: ${gexFmt(nextPoint.netGex)} | Total exposure: ${gexFmt(nextPoint.grossGex)} | ${gexEls.exchange.value}`;
  renderGexHistory({ syncTv: false });
  animateTvGexPoint(nextPoint, fromValue);
}

function resizeTvCharts() {
  if (!tvState.mainChart) return;
  tvState.mainChart.resize(els.tvChart.clientWidth, els.tvChart.clientHeight);
  tvState.gexChart.resize(els.gexTvChart.clientWidth, els.gexTvChart.clientHeight);
  if (tvState.rollChart && rollEls.chart) {
    tvState.rollChart.resize(rollEls.chart.clientWidth, rollEls.chart.clientHeight);
  }
}

function renderOverlay(width, height, dpr, candles, scale) {
  const ctx = els.overlayCanvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.scale(dpr, dpr);
  const w = width / dpr;
  const h = height / dpr;
  const s = makeScale(w, h, candles);
  ctx.fillStyle = cssVar("--axis");
  ctx.fillRect(w - s.right, 0, s.right, h);
  ctx.fillRect(0, h - s.bottom, w, s.bottom);
  ctx.strokeStyle = cssVar("--grid");
  ctx.fillStyle = cssVar("--muted");
  ctx.lineWidth = 1;
  ctx.font = "11px Inter, system-ui, sans-serif";

  for (let i = 0; i <= 7; i++) {
    const y = Math.round(s.top + (s.plotH / 7) * i) + 0.5;
    const price = s.max - ((s.max - s.min) / 7) * i;
    ctx.beginPath();
    ctx.moveTo(s.left, y);
    ctx.lineTo(w - s.right, y);
    ctx.stroke();
    ctx.fillStyle = cssVar("--axis");
    ctx.fillRect(w - s.right + 1, y - 11, s.right - 3, 22);
    ctx.fillStyle = cssVar("--muted");
    ctx.fillText(number.format(price), w - s.right + 10, y + 4);
  }

  ctx.strokeStyle = cssVar("--line");
  ctx.beginPath();
  ctx.moveTo(w - s.right + 0.5, 0);
  ctx.lineTo(w - s.right + 0.5, h);
  ctx.moveTo(0, h - s.bottom + 0.5);
  ctx.lineTo(w, h - s.bottom + 0.5);
  ctx.stroke();

  const domain = visibleTimeDomain();
  const ticks = timeTicks(domain, 8);
  for (const tick of ticks) {
    const x = xForTime(tick, s, domain);
    ctx.fillStyle = cssVar("--muted");
    ctx.fillText(istDateTime.format(new Date(tick)), Math.max(8, Math.min(x - 34, w - 150)), h - 17);
  }

  if (state.lastPointer && state.candles.length) {
    const idx = Math.round(state.view.start + ((state.lastPointer.x - s.left) / s.plotW) * (state.view.end - state.view.start));
    const candle = state.candles[Math.max(0, Math.min(state.candles.length - 1, idx))];
    if (candle) {
      const x = s.x(idx);
      const y = s.y(candle.close);
      ctx.strokeStyle = cssVar("--accent-2");
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, s.top);
      ctx.lineTo(x, h - s.bottom);
      ctx.moveTo(s.left, y);
      ctx.lineTo(w - s.right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cssVar("--accent-2");
      ctx.fillRect(w - s.right + 1, y - 12, s.right - 4, 24);
      ctx.fillStyle = "#08110f";
      ctx.font = "700 11px Inter, system-ui, sans-serif";
      ctx.fillText(number.format(candle.close), w - s.right + 10, y + 4);
      showTooltip(candle, x, y);
    }
  } else {
    els.tooltip.hidden = true;
  }
  ctx.restore();
}

function showTooltip(candle, x, y) {
  els.tooltip.hidden = false;
  els.tooltip.innerHTML = `
    <strong>${istDateTime.format(new Date(candle.time))}</strong><br>
    O ${number.format(candle.open)} H ${number.format(candle.high)}<br>
    L ${number.format(candle.low)} C ${number.format(candle.close)}
  `;
  const host = els.host.getBoundingClientRect();
  const left = Math.min(host.width - 182, Math.max(8, x + 12));
  const top = Math.min(host.height - 90, Math.max(8, y - 44));
  els.tooltip.style.left = `${left}px`;
  els.tooltip.style.top = `${top}px`;
}

function render() {
  const glSize = resizeCanvas(els.glCanvas);
  const overlaySize = resizeCanvas(els.overlayCanvas);
  const candles = visibleCandles();
  const cssW = glSize.width / glSize.dpr;
  const cssH = glSize.height / glSize.dpr;
  const scale = makeScale(cssW, cssH, candles);
  renderGl(glSize.width, glSize.height, glSize.dpr, candles, scale);
  renderOverlay(overlaySize.width, overlaySize.height, overlaySize.dpr, candles, scale);
  if (gexHist?.points?.length) renderGexHistory();
  resizeTvCharts();
}

function bindSafe(button, fn) {
  button.addEventListener("click", async () => {
    try {
      await fn();
    } catch (error) {
      setStatus("Error");
      alert(error.message);
    }
  });
}

function bindInteractions() {
  els.chartType.addEventListener("change", () => {
    setTvMainData();
    render();
  });
  els.host.addEventListener("contextmenu", (event) => event.preventDefault());
  els.host.addEventListener("mousemove", (event) => {
    if (event.target.closest(".tv-chart")) return;
    const rect = els.host.getBoundingClientRect();
    state.lastPointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const zone = hitZone(event);
    els.host.classList.toggle("is-price-scale", zone === "price" && !state.drag);
    els.host.classList.toggle("is-time-scale", zone === "time" && !state.drag);
    if (state.drag) {
      const dx = event.clientX - state.drag.x;
      const dy = event.clientY - state.drag.y;
      const scale = makeScale(rect.width, rect.height, visibleCandles());
      if (state.drag.mode === "plot") {
        const span = state.drag.view.end - state.drag.view.start;
        state.view.start = state.drag.view.start - (dx / scale.plotW) * span;
        state.view.end = state.drag.view.end - (dx / scale.plotW) * span;
        clampView();
        panPriceFromRange(state.drag.priceRange, dy / scale.plotH);
      }
      if (state.drag.mode === "price") {
        state.priceRange = { ...state.drag.priceRange };
        zoomPrice(state.drag.anchorRatio, Math.exp(dy * 0.0065));
      }
      if (state.drag.mode === "time") {
        state.view = { ...state.drag.view };
        zoomTime(state.drag.anchorRatio, Math.exp(dx * 0.005));
      }
    }
    render();
  });
  els.host.addEventListener("mouseleave", () => {
    state.lastPointer = null;
    state.drag = null;
    els.host.classList.remove("is-panning", "is-price-scale", "is-time-scale");
    render();
  });
  els.host.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".tv-chart")) return;
    if (!state.candles.length) return;
    const rect = els.host.getBoundingClientRect();
    const scale = makeScale(rect.width, rect.height, visibleCandles());
    const zone = hitZone(event);
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    ensurePriceRange();
    state.drag = {
      mode: zone,
      x: event.clientX,
      y: event.clientY,
      view: { ...state.view },
      priceRange: { ...state.priceRange },
      anchorRatio: zone === "price"
        ? Math.max(0, Math.min(1, (y - scale.top) / scale.plotH))
        : Math.max(0, Math.min(1, (x - scale.left) / scale.plotW))
    };
    els.host.classList.toggle("is-panning", zone === "plot");
    els.host.setPointerCapture(event.pointerId);
  });
  els.host.addEventListener("pointerup", (event) => {
    state.drag = null;
    els.host.classList.remove("is-panning");
    if (els.host.hasPointerCapture(event.pointerId)) els.host.releasePointerCapture(event.pointerId);
  });
  els.host.addEventListener("dblclick", (event) => {
    if (event.target.closest(".tv-chart")) return;
    const zone = hitZone(event);
    if (zone === "price") {
      state.priceRange = null;
      render();
      return;
    }
    fitChart();
  });
  els.host.addEventListener("wheel", (event) => {
    if (event.target.closest(".tv-chart")) return;
    if (!state.candles.length) return;
    event.preventDefault();
    const rect = els.host.getBoundingClientRect();
    const scale = makeScale(rect.width, rect.height, visibleCandles());
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const zone = hitZone(event);
    const factor = Math.exp(Math.sign(event.deltaY) * 0.14);
    if (event.shiftKey) {
      panTime(Math.sign(event.deltaY) * Math.max(1, (state.view.end - state.view.start) * 0.08));
    } else if (zone === "price" || event.altKey) {
      const anchorRatio = Math.max(0, Math.min(1, (y - scale.top) / scale.plotH));
      zoomPrice(anchorRatio, factor);
    } else {
      const anchorRatio = Math.max(0, Math.min(1, (x - scale.left) / scale.plotW));
      zoomTime(anchorRatio, factor);
    }
    render();
  }, { passive: false });
  window.addEventListener("resize", render);
}

bindSafe(els.loadInstruments, loadInstruments);
bindSafe(els.currentPrice, loadCurrentPrice);
bindSafe(els.loadChart, loadChart);
bindSafe(els.sendOtp, sendOtp);
bindSafe(els.verifyOtp, verifyOtp);
bindSafe(els.verifyMpin, verifyMpin);
els.fitChart.addEventListener("click", fitChart);
els.showAll.addEventListener("click", showAllCandles);
els.toggleTheme.addEventListener("click", () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  document.documentElement.classList.toggle("light", state.theme === "light");
  render();
});

// ─── Gamma Exposure (GEX) ────────────────────────────────────────────────────

const gexEls = {
  symbol:    $("gexSymbol"),
  expiry:    $("gexExpiry"),
  exchange:  $("gexExchange"),
  load:      $("loadGex"),
  stats:     $("gexStats"),
  chartWrap: $("gexChartWrap"),
  canvas:    $("gexCanvas"),
  title:     $("gexTitle"),
  meta:      $("gexMeta"),
  spot:      $("gexSpot"),
  net:       $("gexNet"),
  call:      $("gexCall"),
  put:       $("gexPut"),
  flip:      $("gexFlip"),
  status:    $("gexStatus")
};

const gexState = {
  strikes: [],   // { strike, callGex, putGex, netGex }
  spot: 0,
  expiry: ""
};

function gexFmt(v) {
  if (!Number.isFinite(v)) return "--";
  return `${v.toFixed(2)} Cr`;
}

function lotFallback(symbol) {
  return ({ NIFTY: 65, SENSEX: 20, BANKNIFTY: 35, FINNIFTY: 65 }[symbol] || 1);
}

function gexCr(gamma, oi, lotSize, spot) {
  if (![gamma, oi, lotSize, spot].every(Number.isFinite) || spot <= 0) return 0;
  return (gamma * oi * lotSize * spot * spot) / 10_000_000;
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

function buildLookup(points, rupeeValue = false) {
  return new Map((Array.isArray(points) ? points : [])
    .map((point) => [pointMs(point), pointNumber(point, rupeeValue)])
    .filter(([ts]) => Number.isFinite(ts)));
}

function calcFlipLevel(strikeRows) {
  const rows = strikeRows
    .filter((row) => Number.isFinite(row.strike) && Number.isFinite(row.netGex))
    .sort((a, b) => a.strike - b.strike);
  if (rows.length < 2) return null;

  let prevStrike = rows[0].strike;
  let prevCum = rows[0].netGex;
  for (let i = 1; i < rows.length; i++) {
    const currStrike = rows[i].strike;
    const currCum = prevCum + rows[i].netGex;
    if (prevCum === 0) return prevStrike;
    if (Math.sign(prevCum) !== Math.sign(currCum)) {
      const span = currCum - prevCum;
      const ratio = span === 0 ? 0 : -prevCum / span;
      return prevStrike + (currStrike - prevStrike) * Math.max(0, Math.min(1, ratio));
    }
    prevStrike = currStrike;
    prevCum = currCum;
  }
  return null;
}

async function fetchBatch(refIds) {
  return Promise.all(
    refIds.map((id) =>
      nubraFetch(`orderbooks/${id}?levels=1`, { method: "GET" }).catch(() => null)
    )
  );
}

async function loadGexLegacy() {
  const symbol   = gexEls.symbol.value.trim().toUpperCase();
  const exchange = gexEls.exchange.value;
  const expiry   = gexEls.expiry.value;

  if (!symbol) { gexEls.status.textContent = "Enter a symbol"; return; }

  gexEls.status.textContent = "Fetching chain…";
  gexEls.stats.hidden = false;

  const chainPath = `optionchains/${encodeURIComponent(symbol)}?exchange=${exchange}` +
    (expiry ? `&expiry=${expiry}` : "");

  let chain;
  try {
    const data = await nubraFetch(chainPath, { method: "GET" });
    chain = data.chain;
  } catch (err) {
    gexEls.status.textContent = `Chain error: ${err.message}`;
    return;
  }

  const spot = chain.cp / 100;
  gexState.spot = spot;
  gexEls.spot.textContent = rupee.format(spot);

  // Populate expiry dropdown from chain response
  if (Array.isArray(chain.all_expiries) && chain.all_expiries.length) {
    gexEls.expiry.innerHTML = chain.all_expiries
      .map((e) => `<option value="${e}"${e === chain.expiry ? " selected" : ""}>${e}</option>`)
      .join("");
  }

  const ceItems = Array.isArray(chain.ce) ? chain.ce : [];
  const peItems = Array.isArray(chain.pe) ? chain.pe : [];

  // Collect all ref_ids we need live quotes for (to get fresh LTP for GEX scaling)
  // We have gamma & OI from chain already — batch fetch market quotes for fresh LTP
  const allItems = [...ceItems, ...peItems];
  const refIds = allItems.map((x) => x.ref_id).filter(Boolean);

  // Fetch in batches of 8
  const BATCH = 8;
  const ltpMap = new Map();
  const totalBatches = Math.ceil(refIds.length / BATCH);

  for (let b = 0; b < totalBatches; b++) {
    const batch = refIds.slice(b * BATCH, (b + 1) * BATCH);
    gexEls.status.textContent = `Quotes ${b + 1}/${totalBatches}…`;
    const results = await fetchBatch(batch);
    for (let i = 0; i < batch.length; i++) {
      const ob = results[i]?.orderBook;
      if (ob) ltpMap.set(batch[i], ob.ltp);
    }
    // small yield so UI stays responsive
    await new Promise((r) => setTimeout(r, 0));
  }

  // ── GEX calculation ──────────────────────────────────────────────────────
  // GEX (per strike, dealer perspective) =
  //   gamma × OI × lot_size × spot²
  // CE: dealers are typically short calls → negative gamma exposure (they sold calls)
  // PE: dealers are typically long puts (bought from retail) → negative put gamma
  // Net GEX = sum(call_GEX - put_GEX) where positive = dealers net long gamma (stabilising)

  const byStrike = new Map();

  function addGex(items, side) {
    for (const item of items) {
      const strike = item.sp / 100;
      const gamma  = item.gamma || 0;
      const oi     = item.oi    || 0;
      const ls     = item.ls    || 1;
      const gex = gamma * oi * ls * (side === "CE" ? 1 : -1);
      let row = byStrike.get(strike) || { strike, callGex: 0, putGex: 0, netGex: 0 };
      if (side === "CE") row.callGex += gex;
      else               row.putGex  += gex;
      byStrike.set(strike, row);
    }
  }

  addGex(ceItems, "CE");
  addGex(peItems, "PE");

  const strikes = [...byStrike.values()].map((r) => {
    r.netGex = r.callGex + r.putGex;
    return r;
  }).sort((a, b) => a.strike - b.strike);

  gexState.strikes = strikes;
  gexState.expiry  = chain.expiry;

  // Aggregate stats
  const totalCallGex = strikes.reduce((s, r) => s + r.callGex, 0);
  const totalPutGex  = strikes.reduce((s, r) => s + r.putGex,  0);
  const netGex       = totalCallGex + totalPutGex;

  // Gamma flip level = strike where cumulative net GEX crosses zero (closest to spot)
  let flipStrike = null;
  const nearSpot = strikes.filter((r) => Math.abs(r.strike - spot) < spot * 0.15);
  for (let i = 0; i < nearSpot.length - 1; i++) {
    if (nearSpot[i].netGex * nearSpot[i + 1].netGex <= 0) {
      flipStrike = nearSpot[i + 1].strike;
      break;
    }
  }

  gexEls.net.textContent   = gexFmt(netGex);
  gexEls.net.style.color   = netGex >= 0 ? "var(--up)" : "var(--down)";
  gexEls.call.textContent  = gexFmt(totalCallGex);
  gexEls.put.textContent   = gexFmt(totalPutGex);
  gexEls.flip.textContent  = flipStrike ? rupee.format(flipStrike) : "n/a";
  gexEls.status.textContent = `${strikes.length} strikes loaded`;
  gexEls.title.textContent  = `Gamma Exposure — ${symbol} ${chain.expiry}`;
  gexEls.meta.textContent   = `Net GEX: ${gexFmt(netGex)} | ${exchange} | ${new Date().toLocaleTimeString("en-IN")}`;

  gexEls.chartWrap.hidden = false;
  renderGex();
}

function renderGex() {
  const canvas = gexEls.canvas;
  const dpr    = window.devicePixelRatio || 1;
  const rect   = canvas.getBoundingClientRect();
  const w      = Math.max(1, Math.floor(rect.width  * dpr));
  const h      = Math.max(1, Math.floor(rect.height * dpr));
  canvas.width  = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);

  const strikes = gexState.strikes;
  if (!strikes.length) return;

  const cssW = w / dpr;
  const cssH = h / dpr;
  ctx.save();
  ctx.scale(dpr, dpr);

  const pad = { top: 20, bottom: 36, left: 58, right: 16 };
  const plotW = cssW - pad.left - pad.right;
  const plotH = cssH - pad.top  - pad.bottom;

  const maxAbs = Math.max(...strikes.map((r) => Math.max(Math.abs(r.callGex), Math.abs(r.putGex))), 1);
  const barW   = Math.max(2, plotW / strikes.length - 1);

  // background
  ctx.fillStyle = cssVar("--panel");
  ctx.fillRect(0, 0, cssW, cssH);

  // zero line
  const zeroY = pad.top + plotH / 2;
  ctx.strokeStyle = cssVar("--line");
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, zeroY + 0.5);
  ctx.lineTo(cssW - pad.right, zeroY + 0.5);
  ctx.stroke();

  // spot line
  if (gexState.spot) {
    const spotX = pad.left + ((gexState.spot - strikes[0].strike) /
      (strikes[strikes.length - 1].strike - strikes[0].strike || 1)) * plotW;
    ctx.strokeStyle = cssVar("--accent-2");
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(spotX, pad.top);
    ctx.lineTo(spotX, cssH - pad.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = cssVar("--accent-2");
    ctx.font = "bold 10px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`Spot ${number.format(gexState.spot)}`, spotX, pad.top - 6);
  }

  // bars: call GEX up, put GEX down
  for (let i = 0; i < strikes.length; i++) {
    const row = strikes[i];
    const x   = pad.left + (i / Math.max(strikes.length - 1, 1)) * plotW;

    const callH = (row.callGex / maxAbs) * (plotH / 2);
    const putH  = (row.putGex  / maxAbs) * (plotH / 2);

    // Call bar (up, green)
    ctx.fillStyle = "rgba(18, 214, 160, 0.75)";
    ctx.fillRect(x - barW / 2, zeroY - callH, barW, callH);

    // Put bar (down, red)
    ctx.fillStyle = "rgba(255, 91, 103, 0.75)";
    ctx.fillRect(x - barW / 2, zeroY, barW, putH);
  }

  // Y-axis labels
  ctx.fillStyle = cssVar("--muted");
  ctx.font = "10px Inter, system-ui, sans-serif";
  ctx.textAlign = "right";
  for (const frac of [1, 0.5, 0, -0.5, -1]) {
    const y = zeroY - frac * (plotH / 2);
    ctx.fillText(gexFmt(frac * maxAbs), pad.left - 6, y + 3.5);
  }

  // X-axis strike labels (show ~8 evenly spaced)
  ctx.textAlign = "center";
  const step = Math.max(1, Math.floor(strikes.length / 8));
  for (let i = 0; i < strikes.length; i += step) {
    const x = pad.left + (i / Math.max(strikes.length - 1, 1)) * plotW;
    ctx.fillText(number.format(strikes[i].strike), x, cssH - pad.bottom + 14);
  }

  // Legend
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(18, 214, 160, 0.85)";
  ctx.fillRect(pad.left, cssH - pad.bottom + 22, 10, 9);
  ctx.fillStyle = cssVar("--muted");
  ctx.fillText("Call GEX", pad.left + 13, cssH - pad.bottom + 30);
  ctx.fillStyle = "rgba(255, 91, 103, 0.85)";
  ctx.fillRect(pad.left + 72, cssH - pad.bottom + 22, 10, 9);
  ctx.fillStyle = cssVar("--muted");
  ctx.fillText("Put GEX", pad.left + 85, cssH - pad.bottom + 30);

  ctx.restore();
}

async function loadGex() {
  const symbol = gexEls.symbol.value.trim().toUpperCase();
  const exchange = gexEls.exchange.value;
  const date = gexHistEls.gexDate.value || new Date().toISOString().slice(0, 10);
  if (!symbol) { gexEls.status.textContent = "Enter a symbol"; return; }

  gexEls.status.textContent = "Loading strikes from refdata...";
  gexEls.stats.hidden = false;

  let refRows = [];
  try {
    const data = await nubraFetch(`refdata/refdata/${date}?exchange=${exchange}`, { method: "GET" });
    refRows = Array.isArray(data.refdata) ? data.refdata : [];
  } catch (err) {
    gexEls.status.textContent = `Refdata error: ${err.message}`;
    return;
  }

  const rows = refRows.filter((row) => {
    const asset = String(row.asset || "").toUpperCase();
    const dtype = String(row.derivative_type || "").toUpperCase();
    const side = String(row.option_type || "").toUpperCase();
    return asset === symbol && dtype === "OPT" && (side === "CE" || side === "PE") && row.stock_name;
  });

  const expiries = [...new Set(rows.map((row) => String(row.expiry)).filter(Boolean))].sort();
  if (!expiries.length) {
    gexEls.status.textContent = "No option strikes found in refdata";
    return;
  }

  const current = gexEls.expiry.value;
  gexEls.expiry.innerHTML = expiries
    .map((expiry) => `<option value="${expiry}"${expiry === current ? " selected" : ""}>${expiry}</option>`)
    .join("");

  const selectedExpiry = gexEls.expiry.value || expiries[0];
  const selectedRows = rows.filter((row) => String(row.expiry) === selectedExpiry);
  const ceCount = selectedRows.filter((row) => String(row.option_type).toUpperCase() === "CE").length;
  const peCount = selectedRows.filter((row) => String(row.option_type).toUpperCase() === "PE").length;

  gexState.strikes = [];
  gexState.expiry = selectedExpiry;
  gexEls.title.textContent = `Gamma Exposure - ${symbol} ${selectedExpiry}`;
  gexEls.meta.textContent = `${exchange} refdata only | CE ${ceCount} / PE ${peCount} | Lot size from refdata`;
  gexEls.status.textContent = `Ready: ${selectedRows.length} strikes from refdata. ${date === todayIstDate() ? "Connecting option-chain live..." : "Click Day GEX."}`;
  gexEls.chartWrap.hidden = true;
  if (date === todayIstDate()) {
    gexHistEls.wrap.hidden = false;
    gexHistEls.symLabel.textContent = `${symbol} ${selectedExpiry}`;
    startLiveSocket({ includeGex: true });
  }
}

bindSafe(gexEls.load, loadGex);
window.addEventListener("resize", () => { if (gexState.strikes.length) renderGex(); });

// ─── GEX History (Net GEX over time, min-by-min, regime tracker) ─────────────

const gexHist = {
  points:       [],   // [{ time: ms, netGex: number }]
  flips:        [],   // [{ time: ms, from: sign, to: sign }]
  trackTimer:   null,
  tracking:     false,
  symbol:       ""
};

const gexHistEls = {
  wrap:      $("gexHistory"),
  canvas:    $("gexHistCanvas"),
  resize:    $("gexHistoryResize"),
  symLabel:  $("gexHistSymbol"),
  regime:    $("gexHistRegime"),
  flipsLbl:  $("gexHistFlips"),
  pointsLbl: $("gexHistPoints"),
  track:     $("trackGex"),
  stop:      $("stopGex"),
  clear:     $("clearGexHist"),
  dayGex:    $("dayGex"),
  gexDate:   $("gexDate")
};

async function computeNetGex() {
  const symbol   = gexEls.symbol.value.trim().toUpperCase();
  const exchange = gexEls.exchange.value;
  const expiry   = gexEls.expiry.value;
  if (!symbol) return null;

  const chainPath = `optionchains/${encodeURIComponent(symbol)}?exchange=${exchange}` +
    (expiry ? `&expiry=${expiry}` : "");

  let chain;
  try {
    const data = await nubraFetch(chainPath, { method: "GET" });
    chain = data.chain;
  } catch { return null; }

  const spot    = chain.cp / 100;
  const ceItems = Array.isArray(chain.ce) ? chain.ce : [];
  const peItems = Array.isArray(chain.pe) ? chain.pe : [];

  let callGexTotal = 0;
  let putGexTotal  = 0;
  for (const item of ceItems) {
    callGexTotal += (item.gamma || 0) * (item.oi || 0) * (item.ls || 1);
  }
  for (const item of peItems) {
    putGexTotal  -= (item.gamma || 0) * (item.oi || 0) * (item.ls || 1);
  }

  return { netGex: callGexTotal + putGexTotal, spot, symbol };
}

function pushGexPoint(netGex) {
  const now  = Date.now();
  const prev = gexHist.points[gexHist.points.length - 1];

  // Detect regime flip
  if (prev) {
    const prevSign = Math.sign(prev.netGex);
    const currSign = Math.sign(netGex);
    if (prevSign !== 0 && currSign !== 0 && prevSign !== currSign) {
      gexHist.flips.push({ time: now, from: prevSign, to: currSign });
    }
  }

  gexHist.points.push({ time: now, netGex });

  // Update header badges
  const regime = netGex >= 0 ? "POSITIVE" : "NEGATIVE";
  gexHistEls.regime.textContent = regime;
  gexHistEls.regime.className   = `gex-regime-badge ${netGex >= 0 ? "positive" : "negative"}`;
  gexHistEls.flipsLbl.textContent = `${gexHist.flips.length} flip${gexHist.flips.length !== 1 ? "s" : ""}`;
  gexHistEls.pointsLbl.textContent = `${gexHist.points.length} pts`;

  renderGexHistory();
  setTvGexData();
}

async function pollGex() {
  if (!gexHist.tracking) return;
  gexEls.status.textContent = "Tracking…";
  const result = await computeNetGex();
  if (result) {
    pushGexPoint(result.netGex);
    gexHist.symbol = result.symbol;
    gexHistEls.symLabel.textContent = result.symbol;
  }
}

async function startTracking() {
  if (gexHist.tracking) return;
  gexHist.tracking = true;
  gexHistEls.track.disabled = true;
  gexHistEls.stop.disabled  = false;
  gexHistEls.wrap.hidden    = false;
  gexHistEls.symLabel.textContent = gexEls.symbol.value.trim().toUpperCase() || "--";
  gexEls.status.textContent = "Track: building selected-date intraday GEX...";
  let keepLive = false;
  try {
    await loadDayGex();
    if (gexHistEls.gexDate.value === todayIstDate() && startLiveSocket({ includeGex: true })) {
      gexHist.tracking = true;
      gexHistEls.track.disabled = true;
      gexHistEls.stop.disabled = false;
      gexEls.status.textContent = "Track live websocket running";
      keepLive = true;
    }
    if (!keepLive) gexEls.status.textContent = "Track ready from selected-date intraday batches";
  } catch (error) {
    gexEls.status.textContent = `Track error: ${error.message}`;
  } finally {
    if (keepLive) return;
    gexHist.tracking = false;
    gexHistEls.track.disabled = false;
    gexHistEls.stop.disabled = true;
  }
}

function stopTracking() {
  gexHist.tracking = false;
  clearInterval(gexHist.trackTimer);
  gexHist.trackTimer = null;
  stopLiveSocket();
  gexHistEls.track.disabled = false;
  gexHistEls.stop.disabled  = true;
  gexEls.status.textContent = "Tracking stopped";
}

function clearGexHistory() {
  gexHist.points = [];
  gexHist.flips  = [];
  gexHistEls.regime.textContent   = "--";
  gexHistEls.regime.className     = "gex-regime-badge";
  gexHistEls.flipsLbl.textContent = "0 flips";
  gexHistEls.pointsLbl.textContent = "0 pts";
  renderGexHistory();
  setTvGexData();
}

function stopLiveSocket() {
  liveState.enabled = false;
  liveState.signature = "";
  liveState.includeGex = false;
  liveState.optionCache.clear();
  liveState.gexSpot = 0;
  clearInterval(liveState.backfillTimer);
  liveState.backfillTimer = null;
  if (liveState.animFrame) {
    cancelAnimationFrame(liveState.animFrame);
    liveState.animFrame = null;
  }
  if (liveState.gexAnimFrame) {
    cancelAnimationFrame(liveState.gexAnimFrame);
    liveState.gexAnimFrame = null;
  }
  if (liveState.socket) {
    liveState.socket.close();
    liveState.socket = null;
  }
}

function startLiveSocket({ includeGex = false } = {}) {
  if (!selectedChartIsToday()) return false;
  if (isAfterMarketClose()) {
    setStatus("Closed");
    gexEls.status.textContent = "Market closed";
    return false;
  }
  const symbol = (includeGex ? gexEls.symbol.value : els.symbol.value).trim().toUpperCase();
  const exchange = includeGex ? gexEls.exchange.value : els.exchange.value;
  const expiry = includeGex ? gexEls.expiry.value : "";
  const token = els.token.value.trim();
  const deviceId = els.deviceId.value.trim();
  if (!symbol || !token || !deviceId) return false;

  const signature = JSON.stringify({
    symbol,
    exchange,
    interval: els.interval.value,
    expiry,
    environment: els.environment.value
  });
  if (liveState.socket && liveState.signature === signature) return true;

  stopLiveSocket();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws/live`);
  liveState.socket = socket;
  liveState.signature = signature;
  liveState.enabled = true;
  liveState.includeGex = includeGex;
  liveState.lastCandleTime = state.candles[state.candles.length - 1]?.time || 0;
  liveState.lastGexTime = gexHist.points[gexHist.points.length - 1]?.time || 0;
  startLiveBackfillMonitor();

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      type: "subscribe",
      environment: els.environment.value,
      token,
      deviceId,
      symbol,
      exchange,
      interval: els.interval.value,
      expiry
    }));
    setStatus("Live");
    gexEls.status.textContent = includeGex ? "Live websocket connecting..." : gexEls.status.textContent;
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (isAfterMarketClose()) {
      stopLiveAfterClose();
      return;
    }
    if (message.event === "ohlcv") {
      upsertLiveCandle(message.data || {});
      return;
    }
    if (message.event === "option") {
      const snapshot = optionRowsFromStream(message.data || {}, message.received_at_ms);
      if (!snapshot) {
        gexEls.status.textContent = `Live GEX waiting for OI/gamma (${liveState.optionCache.size} legs cached)`;
        return;
      }
      gexState.strikes = snapshot.strikes;
      gexState.spot = snapshot.spot;
      upsertGexSnapshot(snapshot);
      gexEls.status.textContent = `Live GEX ${gexFmt(snapshot.netGex)}`;
      return;
    }
    if (message.event === "status") {
      if (message.status === "connected" || message.status === "subscribed") setStatus("Live");
      if (includeGex && message.status) gexEls.status.textContent = `Live ${message.status}`;
      return;
    }
    if (message.event === "error") {
      setStatus("Live err");
      gexEls.status.textContent = message.message || "Live websocket error";
    }
  });

  socket.addEventListener("close", () => {
    if (liveState.socket === socket) liveState.socket = null;
    if (liveState.enabled) {
      setStatus("Live closed");
      gexEls.status.textContent = "Live websocket closed";
    }
  });

  socket.addEventListener("error", () => {
    setStatus("Live err");
    if (includeGex) gexEls.status.textContent = "Live websocket error";
  });

  return true;
}

function renderGexHistory({ syncTv = true } = {}) {
  if (syncTv) setTvGexData();
  const canvas = gexHistEls.canvas;
  const dpr    = window.devicePixelRatio || 1;
  const rect   = canvas.getBoundingClientRect();
  const w      = Math.max(1, Math.floor(rect.width  * dpr));
  const h      = Math.max(1, Math.floor(rect.height * dpr));
  canvas.width  = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);

  const cssW = w / dpr;
  const cssH = h / dpr;
  ctx.save();
  ctx.scale(dpr, dpr);

  const pts = gexHist.points;

  // background
  ctx.fillStyle = cssVar("--panel-2");
  ctx.fillRect(0, 0, cssW, cssH);

  const pad = { top: 10, bottom: 24, left: 14, right: 92 };
  const plotW = cssW - pad.left - pad.right;
  const plotH = cssH - pad.top  - pad.bottom;
  const zeroY = pad.top + plotH / 2;

  // zero line
  ctx.strokeStyle = cssVar("--line");
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, zeroY + 0.5);
  ctx.lineTo(cssW - pad.right, zeroY + 0.5);
  ctx.stroke();

  if (!pts.length) {
    ctx.fillStyle = cssVar("--muted");
    ctx.font      = "11px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Click Track to start recording net GEX every minute", cssW / 2, cssH / 2 + 4);
    ctx.restore();
    return;
  }

  const chartDomain = visibleTimeDomain();
  const localDomain = pts[pts.length - 1].time === pts[0].time
    ? { start: pts[0].time, end: pts[0].time + 1 }
    : { start: pts[0].time, end: pts[pts.length - 1].time };
  const domain = chartDomain || localDomain;
  const visiblePts = pts.filter((p) => p.time >= domain.start && p.time <= domain.end);
  const scalePts = visiblePts.length ? visiblePts : pts;
  const maxAbs = Math.max(...scalePts.map((p) => Math.abs(p.netGex)), 1);

  const px = (t)   => pad.left + ((t - domain.start) / (domain.end - domain.start)) * plotW;
  const py = (gex) => zeroY - (gex / maxAbs) * (plotH / 2);

  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.left, pad.top, plotW, plotH);
  ctx.clip();

  // Regime flip markers (vertical lines)
  for (const flip of gexHist.flips) {
    if (flip.time < domain.start || flip.time > domain.end) continue;
    const x = px(flip.time);
    ctx.strokeStyle = flip.to > 0 ? "rgba(18,214,160,0.6)" : "rgba(255,91,103,0.6)";
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, cssH - pad.bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    // flip arrow label
    const label = flip.to > 0 ? "▲ +" : "▼ −";
    ctx.fillStyle = flip.to > 0 ? "var(--up)" : "var(--down)";
    ctx.font      = "bold 9px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(label, x, pad.top + 8);
  }

  // Filled area — split positive (green) and negative (red)
  // Build path for positive fill
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < scalePts.length; i++) {
    const x = px(scalePts[i].time);
    const y = py(Math.max(0, scalePts[i].netGex));
    if (!started) { ctx.moveTo(x, zeroY); ctx.lineTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.lineTo(px(scalePts[scalePts.length - 1].time), zeroY);
  ctx.closePath();
  ctx.fillStyle = "rgba(18,214,160,0.18)";
  ctx.fill();

  // Negative fill
  ctx.beginPath();
  started = false;
  for (let i = 0; i < scalePts.length; i++) {
    const x = px(scalePts[i].time);
    const y = py(Math.min(0, scalePts[i].netGex));
    if (!started) { ctx.moveTo(x, zeroY); ctx.lineTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.lineTo(px(scalePts[scalePts.length - 1].time), zeroY);
  ctx.closePath();
  ctx.fillStyle = "rgba(255,91,103,0.18)";
  ctx.fill();

  // Line — color by sign segment
  for (let i = 1; i < scalePts.length; i++) {
    const prev = scalePts[i - 1];
    const curr = scalePts[i];
    const isPos = curr.netGex >= 0;
    ctx.strokeStyle = isPos ? "var(--up)" : "var(--down)";
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(px(prev.time), py(prev.netGex));
    ctx.lineTo(px(curr.time), py(curr.netGex));
    ctx.stroke();
  }

  // Dots at each data point
  for (const p of scalePts) {
    ctx.beginPath();
    ctx.arc(px(p.time), py(p.netGex), 2.5, 0, Math.PI * 2);
    ctx.fillStyle = p.netGex >= 0 ? "var(--up)" : "var(--down)";
    ctx.fill();
  }

  // Latest value label on right edge
  ctx.restore();

  const last = visiblePts[visiblePts.length - 1] || pts[pts.length - 1];
  ctx.fillStyle = last.netGex >= 0 ? "var(--up)" : "var(--down)";
  ctx.font      = "bold 10px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(gexFmt(last.netGex), cssW - pad.right + 8, py(last.netGex) + 4);

  // Y-axis labels
  ctx.fillStyle = cssVar("--muted");
  ctx.font      = "9px Inter, system-ui, sans-serif";
  ctx.textAlign = "right";
  for (const frac of [1, 0.5, 0, -0.5, -1]) {
    const y = zeroY - frac * (plotH / 2);
    ctx.fillText(gexFmt(frac * maxAbs), cssW - pad.right + 6, y + 3);
  }

  // X-axis time labels (~5 ticks)
  ctx.textAlign = "center";
  const timeFmt = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false
  });
  for (const tick of timeTicks(domain, 8)) {
    const x = px(tick);
    ctx.fillStyle = cssVar("--muted");
    ctx.fillText(timeFmt.format(new Date(tick)), x, cssH - pad.bottom + 12);
  }

  ctx.restore();
}

// Resize handle drag
(function bindGexHistoryResize() {
  const handle = gexHistEls.resize;
  const wrap   = gexHistEls.wrap;
  let startY = 0;
  let startH = 0;

  handle.addEventListener("mousedown", (e) => {
    startY = e.clientY;
    startH = wrap.getBoundingClientRect().height;
    e.preventDefault();

    function onMove(ev) {
      const delta = startY - ev.clientY;
      const newH  = Math.max(80, Math.min(420, startH + delta));
      wrap.style.height = `${newH}px`;
      renderGexHistory();
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
  });

  handle.addEventListener("touchstart", (e) => {
    startY = e.touches[0].clientY;
    startH = wrap.getBoundingClientRect().height;
    e.preventDefault();

    function onMove(ev) {
      const delta = startY - ev.touches[0].clientY;
      const newH  = Math.max(80, Math.min(420, startH + delta));
      wrap.style.height = `${newH}px`;
      renderGexHistory();
    }
    function onUp() {
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend",  onUp);
    }
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend",  onUp);
  }, { passive: false });
})();

async function loadDayGexLegacy() {
  const symbol   = gexEls.symbol.value.trim().toUpperCase();
  const exchange = gexEls.exchange.value;
  const expiry   = gexEls.expiry.value;
  if (!symbol) { gexEls.status.textContent = "Enter symbol first"; return; }
  if (!expiry)  { gexEls.status.textContent = "Load GEX first to populate expiry"; return; }

  gexEls.status.textContent      = "Day GEX: fetching chain…";
  gexHistEls.wrap.hidden         = false;
  gexHistEls.symLabel.textContent = symbol;

  // ── Step 1: fetch option chain for gamma + lot_size per strike ────────────
  const chainPath = `optionchains/${encodeURIComponent(symbol)}?exchange=${exchange}&expiry=${expiry}`;
  let chain;
  try {
    const d = await nubraFetch(chainPath, { method: "GET" });
    chain = d.chain;
  } catch (err) {
    gexEls.status.textContent = `Chain error: ${err.message}`; return;
  }

  const ceItems = Array.isArray(chain.ce) ? chain.ce : [];
  const peItems = Array.isArray(chain.pe) ? chain.pe : [];

  // name → { gamma, ls, side }  (stock_name is the key used by timeseries API)
  const metaByName = new Map();
  for (const item of ceItems) {
    const name = item.stock_name;
    if (name) metaByName.set(name, { gamma: item.gamma || 0, ls: item.ls || 1, side: "CE" });
  }
  for (const item of peItems) {
    const name = item.stock_name;
    if (name) metaByName.set(name, { gamma: item.gamma || 0, ls: item.ls || 1, side: "PE" });
  }

  const allNames = [...metaByName.keys()];
  if (!allNames.length) {
    gexEls.status.textContent = "No strikes found in chain"; return;
  }

  // ── Step 2: date range — IST trading day = prev-day 18:30 UTC → istDate 18:29 UTC
  // e.g. "2026-06-11T18:30:00.000Z" → "2026-06-12T18:29:59.999Z"
  const istDate = gexHistEls.gexDate.value;   // "YYYY-MM-DD" in IST picked by user
  if (!istDate) { gexEls.status.textContent = "Pick a date first"; return; }
  const [y, m, d] = istDate.split("-").map(Number);
  const prevDay   = new Date(Date.UTC(y, m - 1, d - 1));
  const prevStr   = prevDay.toISOString().slice(0, 10);
  const startDate = `${prevStr}T18:30:00.000Z`;
  const endDate   = `${istDate}T18:29:59.999Z`;

  // ── Step 3: fetch cumulative_oi for all strikes in batches of 8 ───────────
  const oiByName = new Map();   // name → [{ ts_ms, oi }]
  const BATCH    = 8;
  const total    = Math.ceil(allNames.length / BATCH);

  for (let b = 0; b < total; b++) {
    const batch  = allNames.slice(b * BATCH, (b + 1) * BATCH);
    gexEls.status.textContent = `Day GEX: batch ${b + 1}/${total}…`;

    const payload = {
      query: [
        {
          exchange,
          type: "OPT",
          values: batch,
          fields: ["cumulative_oi"],
          startDate,
          endDate,
          interval: "1m",
          intraDay: false,
          realTime: false
        }
      ]
    };

    try {
      const data = await nubraFetch("charts/timeseries", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      const resultValues = data?.result?.[0]?.values || [];
      console.log(`[DayGEX] batch ${b + 1} sent ${batch.length} names, got ${resultValues.length} result entries`);
      for (const entry of resultValues) {
        for (const [sym, symData] of Object.entries(entry)) {
          const pts = symData?.cumulative_oi;
          if (Array.isArray(pts) && pts.length) {
            oiByName.set(sym, pts.map((p) => ({
              ts: Math.floor(Number(p.ts) / 1_000_000),
              oi: Number(p.v) || 0
            })));
          }
        }
      }
      console.log(`[DayGEX] oiByName now has ${oiByName.size} strikes`);
    } catch (err) {
      console.warn(`[DayGEX] batch ${b + 1} failed:`, err.message);
    }

    await new Promise((r) => setTimeout(r, 0));
  }

  // ── Step 4: collect all unique 1m timestamps ──────────────────────────────
  const tsSet = new Set();
  for (const pts of oiByName.values()) for (const p of pts) tsSet.add(p.ts);
  const allTs = [...tsSet].sort((a, b) => a - b);

  if (!allTs.length) {
    gexEls.status.textContent = "Day GEX: no OI data returned — check expiry & session token";
    return;
  }

  // name → (ts → oi) fast lookup
  const oiLookup = new Map();
  for (const [name, pts] of oiByName) {
    const m = new Map();
    for (const p of pts) m.set(p.ts, p.oi);
    oiLookup.set(name, m);
  }

  // ── Step 5: compute net GEX at every timestamp ────────────────────────────
  clearGexHistory();

  for (const ts of allTs) {
    let callGex = 0;
    let putGex  = 0;

    for (const [name, meta] of metaByName) {
      const series = oiLookup.get(name);
      if (!series) continue;
      const oi  = series.get(ts) ?? 0;
      const gex = meta.gamma * oi * meta.ls;
      if (meta.side === "CE") callGex += gex;
      else                    putGex  -= gex;   // puts get -1
    }

    const netGex = callGex + putGex;

    const prev = gexHist.points[gexHist.points.length - 1];
    if (prev) {
      const ps = Math.sign(prev.netGex);
      const cs = Math.sign(netGex);
      if (ps !== 0 && cs !== 0 && ps !== cs) {
        gexHist.flips.push({ time: ts, from: ps, to: cs });
      }
    }
    gexHist.points.push({ time: ts, netGex });
  }

  // ── Step 6: update badges and render ─────────────────────────────────────
  const last   = gexHist.points[gexHist.points.length - 1];
  const regime = last.netGex >= 0 ? "POSITIVE" : "NEGATIVE";
  gexHistEls.regime.textContent   = regime;
  gexHistEls.regime.className     = `gex-regime-badge ${last.netGex >= 0 ? "positive" : "negative"}`;
  gexHistEls.flipsLbl.textContent  = `${gexHist.flips.length} flip${gexHist.flips.length !== 1 ? "s" : ""}`;
  gexHistEls.pointsLbl.textContent = `${gexHist.points.length} pts`;
  gexEls.status.textContent        = `Day GEX ready — ${gexHist.points.length} mins, ${gexHist.flips.length} regime flips`;
  gexHistEls.symLabel.textContent  = `${symbol} ${expiry}`;

  renderGexHistory();
}

async function loadDayGex() {
  const symbol = gexEls.symbol.value.trim().toUpperCase();
  const exchange = gexEls.exchange.value;
  const expiry = gexEls.expiry.value;
  const istDate = gexHistEls.gexDate.value;
  if (!symbol) { gexEls.status.textContent = "Enter symbol first"; return; }
  if (!expiry) { gexEls.status.textContent = "Load GEX first to populate expiry"; return; }
  if (!istDate) { gexEls.status.textContent = "Pick a date first"; return; }

  gexEls.status.textContent = "Intraday GEX: fetching refdata";
  gexHistEls.wrap.hidden = false;
  gexHistEls.symLabel.textContent = `${symbol} ${expiry}`;

  let refRows = [];
  try {
    const data = await nubraFetch(`refdata/refdata/${istDate}?exchange=${exchange}`, { method: "GET" });
    refRows = Array.isArray(data.refdata) ? data.refdata : [];
  } catch (err) {
    gexEls.status.textContent = `Refdata error: ${err.message}`;
    return;
  }

  const expiryNum = Number(expiry);
  const fallbackLotSize = lotFallback(symbol);
  const optionRows = refRows
    .filter((row) => {
      const asset = String(row.asset || "").toUpperCase();
      const dtype = String(row.derivative_type || "").toUpperCase();
      const side = String(row.option_type || "").toUpperCase();
      return asset === symbol &&
        dtype === "OPT" &&
        Number(row.expiry) === expiryNum &&
        (side === "CE" || side === "PE") &&
        row.stock_name;
    })
    .map((row) => ({
      name: row.stock_name,
      side: String(row.option_type).toUpperCase(),
      strike: toRupees(row.strike_price) ?? Number(row.strike_price),
      lotSize: Number(row.lot_size) || fallbackLotSize
    }))
    .sort((a, b) => a.strike - b.strike || a.side.localeCompare(b.side));

  if (!optionRows.length) {
    gexEls.status.textContent = "No option symbols found in refdata for this expiry";
    return;
  }

  const metaByName = new Map(optionRows.map((row) => [row.name, row]));
  const allNames = optionRows.map((row) => row.name);
  const startDate = `${istDate}T03:45:00.000Z`;
  const endDate = `${istDate}T10:00:00.000Z`;
  const sessionEndMs = Date.parse(endDate);
  const queryEndDate = istDate === todayIstDate()
    ? new Date(Math.min(sessionEndMs, Date.now())).toISOString()
    : endDate;
  const spotByTs = new Map();
  try {
    gexEls.status.textContent = "Intraday GEX: fetching underlying spot";
    const spotData = await nubraFetch("charts/timeseries", {
      method: "POST",
      body: JSON.stringify({
        query: [{
          exchange,
          type: "INDEX",
          values: [symbol],
          fields: ["close"],
          startDate,
          endDate: queryEndDate,
          interval: "1m",
          intraDay: false,
          realTime: false
        }]
      })
    });
    const symbolData = extractSymbolData(spotData, symbol);
    for (const point of (Array.isArray(symbolData?.close) ? symbolData.close : [])) {
      const ts = pointMs(point);
      if (Number.isFinite(ts)) spotByTs.set(ts, pointNumber(point, true));
    }
  } catch (err) {
    console.warn("[IntradayGEX] underlying spot fetch failed:", err.message);
  }

  const seriesByName = new Map();
  const batchSize = 8;
  const totalBatches = Math.ceil(allNames.length / batchSize);

  for (let b = 0; b < totalBatches; b++) {
    const batch = allNames.slice(b * batchSize, (b + 1) * batchSize);
    gexEls.status.textContent = `Intraday GEX: batch ${b + 1}/${totalBatches} (${batch.length} strikes)`;
    const payload = {
      query: [{
        exchange,
        type: "OPT",
        values: batch,
        fields: ["gamma", "cumulative_oi"],
        startDate,
        endDate: queryEndDate,
        interval: "1m",
        intraDay: false,
        realTime: false
      }]
    };

    try {
      const data = await nubraFetch("charts/timeseries", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      const resultValues = data?.result?.[0]?.values || [];
      for (const entry of resultValues) {
        for (const [sym, symData] of Object.entries(entry)) {
          const gammaPts = Array.isArray(symData?.gamma) ? symData.gamma : [];
          const oiPts = Array.isArray(symData?.cumulative_oi) ? symData.cumulative_oi : [];
          if (!gammaPts.length && !oiPts.length) continue;
          seriesByName.set(sym, {
            gamma: gammaPts.map((p) => ({ ts: pointMs(p), v: pointNumber(p) })).filter((p) => Number.isFinite(p.ts)),
            oi: oiPts.map((p) => ({ ts: pointMs(p), v: pointNumber(p) })).filter((p) => Number.isFinite(p.ts))
          });
        }
      }
    } catch (err) {
      console.warn(`[IntradayGEX] batch ${b + 1} failed:`, err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const tsSet = new Set();
  for (const series of seriesByName.values()) {
    for (const p of series.gamma) tsSet.add(p.ts);
    for (const p of series.oi) tsSet.add(p.ts);
  }
  const rawTs = [...tsSet].filter(Number.isFinite).sort((a, b) => a - b);
  if (!rawTs.length) {
    gexEls.status.textContent = "Intraday GEX: no gamma/OI data returned";
    return;
  }

  const gridStart = Date.parse(startDate);
  const rawEnd = rawTs[rawTs.length - 1];
  const nowEnd = istDate === todayIstDate() ? bucketStartMs(Date.now(), 60_000) : sessionEndMs;
  const gridEnd = Math.min(sessionEndMs, rawEnd, nowEnd);
  const allTs = [];
  for (let ts = gridStart; ts <= gridEnd; ts += 60_000) {
    allTs.push(ts);
  }
  if (!allTs.length) {
    gexEls.status.textContent = "Intraday GEX: no current-session points returned";
    return;
  }

  const lookupByName = new Map();
  for (const [name, series] of seriesByName) {
    lookupByName.set(name, {
      gamma: new Map(series.gamma.map((p) => [p.ts, p.v])),
      oi: new Map(series.oi.map((p) => [p.ts, p.v]))
    });
  }

  clearGexHistory();
  const lastByName = new Map();
  let lastSpot = 0;
  let latestStrikeRows = [];
  for (const ts of allTs) {
    let callGex = 0;
    let putGex = 0;
    let grossGex = 0;
    const strikeMap = new Map();
    if (spotByTs.has(ts)) lastSpot = spotByTs.get(ts);

    for (const [name, meta] of metaByName) {
      const lookup = lookupByName.get(name);
      if (!lookup) continue;
      const prevValues = lastByName.get(name) || { gamma: 0, oi: 0 };
      const gamma = lookup.gamma.has(ts) ? lookup.gamma.get(ts) : prevValues.gamma;
      const oi = lookup.oi.has(ts) ? lookup.oi.get(ts) : prevValues.oi;
      lastByName.set(name, { gamma, oi });

      const signedGex = gexCr(gamma, oi, meta.lotSize, lastSpot) * (meta.side === "CE" ? 1 : -1);
      if (meta.side === "CE") callGex += signedGex;
      else putGex += signedGex;
      grossGex += Math.abs(signedGex);

      const row = strikeMap.get(meta.strike) || { strike: meta.strike, callGex: 0, putGex: 0, netGex: 0 };
      if (meta.side === "CE") row.callGex += signedGex;
      else row.putGex += signedGex;
      row.netGex = row.callGex + row.putGex;
      strikeMap.set(meta.strike, row);
    }

    const netGex = callGex + putGex;
    const prev = gexHist.points[gexHist.points.length - 1];
    if (prev) {
      const prevSign = Math.sign(prev.netGex);
      const currSign = Math.sign(netGex);
      if (prevSign !== 0 && currSign !== 0 && prevSign !== currSign) {
        gexHist.flips.push({ time: ts, from: prevSign, to: currSign });
      }
    }
    latestStrikeRows = [...strikeMap.values()];
    gexHist.points.push({ time: ts, netGex, callGex, putGex, grossGex, spot: lastSpot });
  }

  const last = gexHist.points[gexHist.points.length - 1];
  const flipLevel = calcFlipLevel(latestStrikeRows);
  gexHistEls.regime.textContent = last.netGex >= 0 ? "POSITIVE" : "NEGATIVE";
  gexHistEls.regime.className = `gex-regime-badge ${last.netGex >= 0 ? "positive" : "negative"}`;
  gexHistEls.flipsLbl.textContent = `${gexHist.flips.length} flip${gexHist.flips.length !== 1 ? "s" : ""}`;
  gexHistEls.pointsLbl.textContent = `${gexHist.points.length} pts`;
  gexHistEls.symLabel.textContent = `${symbol} ${expiry}`;
  gexEls.status.textContent = `Ready: ${optionRows.length} options, ${gexHist.points.length} mins, net ${gexFmt(last.netGex)}, total ${gexFmt(last.grossGex)}`;
  gexEls.meta.textContent = `Net GEX: ${gexFmt(last.netGex)} | Total exposure: ${gexFmt(last.grossGex)} | ${exchange} | ${istDate}`;
  gexEls.stats.hidden = false;
  gexEls.net.textContent = gexFmt(last.netGex);
  gexEls.net.style.color = last.netGex >= 0 ? "var(--up)" : "var(--down)";
  gexEls.call.textContent = gexFmt(last.callGex);
  gexEls.put.textContent = gexFmt(last.putGex);
  gexEls.spot.textContent = last.spot ? rupee.format(last.spot) : "--";
  gexEls.flip.textContent = flipLevel ? rupee.format(flipLevel) : "--";
  gexState.strikes = latestStrikeRows;
  gexState.spot = last.spot;
  renderGexHistory();
  setTvGexData();
  if (istDate === todayIstDate()) {
    startLiveSocket({ includeGex: true });
  }
}

gexHistEls.track.addEventListener("click", startTracking);
gexHistEls.stop.addEventListener("click",  stopTracking);
gexHistEls.clear.addEventListener("click", clearGexHistory);
bindSafe(gexHistEls.dayGex, loadDayGex);
window.addEventListener("resize", () => { if (gexHist.points.length) renderGexHistory(); });

// ─── End GEX History ─────────────────────────────────────────────────────────

// ─── End GEX ─────────────────────────────────────────────────────────────────

// Rolling Straddle

const rollEls = {
  symbol: $("rollSymbol"),
  type: $("rollType"),
  exchange: $("rollExchange"),
  expiry: $("rollExpiry"),
  start: $("rollStart"),
  end: $("rollEnd"),
  loadExpiries: $("rollLoadExpiries"),
  load: $("rollLoad"),
  chart: $("rollChart"),
  meta: $("rollMeta"),
  spot: $("rollSpot"),
  strike: $("rollStrike"),
  bid: $("rollBid"),
  ask: $("rollAsk"),
  points: $("rollPoints"),
  status: $("rollStatus")
};

function setRollStatus(text) {
  rollEls.status.textContent = text;
}

function initRollingChart() {
  if (!window.LightweightCharts || tvState.rollChart) return;
  tvState.rollChart = LightweightCharts.createChart(rollEls.chart, {
    ...tvChartOptions(),
    timeScale: {
      borderColor: cssVar("--line"),
      timeVisible: true,
      secondsVisible: true,
      rightOffset: 8,
      barSpacing: 5,
      tickMarkFormatter: formatLwIstTime
    },
    rightPriceScale: {
      borderColor: cssVar("--line"),
      scaleMargins: { top: 0.12, bottom: 0.12 }
    }
  });
  const bidOptions = { color: cssVar("--up"), lineWidth: 2, title: "Bid straddle" };
  const askOptions = { color: cssVar("--accent-2"), lineWidth: 2, title: "Ask straddle" };
  tvState.rollBidSeries = tvState.rollChart.addLineSeries
    ? tvState.rollChart.addLineSeries(bidOptions)
    : tvState.rollChart.addSeries(LightweightCharts.LineSeries, bidOptions);
  tvState.rollAskSeries = tvState.rollChart.addLineSeries
    ? tvState.rollChart.addLineSeries(askOptions)
    : tvState.rollChart.addSeries(LightweightCharts.LineSeries, askOptions);
}

function rollingRefDate() {
  return rollEls.start.value ? rollEls.start.value.slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function normalizeStrike(value) {
  const rupeeValue = toRupees(value);
  return rupeeValue == null ? Number(value) : rupeeValue;
}

function optionRowSide(row) {
  return String(row.option_type || row.ot || row.side || "").toUpperCase();
}

async function rollingOptionRows() {
  const symbol = rollEls.symbol.value.trim().toUpperCase();
  const exchange = rollEls.exchange.value;
  if (!symbol) throw new Error("Rolling Straddle symbol is required.");
  const data = await nubraFetch(`refdata/refdata/${rollingRefDate()}?exchange=${exchange}`, { method: "GET" });
  const refRows = Array.isArray(data.refdata) ? data.refdata : [];
  return refRows
    .filter((row) => {
      const asset = String(row.asset || "").toUpperCase();
      const dtype = String(row.derivative_type || "").toUpperCase();
      const side = optionRowSide(row);
      return asset === symbol && dtype === "OPT" && (side === "CE" || side === "PE") && row.stock_name;
    })
    .map((row) => ({
      name: row.stock_name,
      expiry: String(row.expiry || ""),
      side: optionRowSide(row),
      strike: normalizeStrike(row.strike_price)
    }))
    .filter((row) => Number.isFinite(row.strike) && row.expiry);
}

async function loadRollingExpiries() {
  setRollStatus("Refdata");
  const rows = await rollingOptionRows();
  const expiries = [...new Set(rows.map((row) => row.expiry))].sort();
  if (!expiries.length) throw new Error("No option expiries found for the rolling straddle symbol.");
  const current = rollEls.expiry.value;
  rollEls.expiry.innerHTML = expiries
    .map((expiry) => `<option value="${expiry}"${expiry === current ? " selected" : ""}>${expiry}</option>`)
    .join("");
  if (!rollEls.expiry.value) rollEls.expiry.value = expiries[0];
  setRollStatus(`${expiries.length} expiries`);
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

async function fetchRollingSeries(names, exchange, startDate, endDate) {
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
          exchange,
          type: "OPT",
          values: batch,
          fields: ["l1bid", "l1ask"],
          startDate,
          endDate,
          interval: "1s",
          intraDay: false,
          realTime: false
        }]
      })
    });
    for (const entry of data?.result?.[0]?.values || []) {
      for (const [name, symData] of Object.entries(entry)) {
        seriesByName.set(name, {
          bid: (Array.isArray(symData?.l1bid) ? symData.l1bid : [])
            .map((p) => ({ ts: pointMs(p), v: pointNumber(p, true) }))
            .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.v))
            .sort((a, b) => a.ts - b.ts),
          ask: (Array.isArray(symData?.l1ask) ? symData.l1ask : [])
            .map((p) => ({ ts: pointMs(p), v: pointNumber(p, true) }))
            .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.v))
            .sort((a, b) => a.ts - b.ts)
        });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return seriesByName;
}

function advanceRollingCursor(name, seriesByName, cursorByName, ts) {
  const series = seriesByName.get(name);
  if (!series) return { bid: 0, ask: 0 };
  const cursor = cursorByName.get(name) || { bidIndex: 0, askIndex: 0, bid: 0, ask: 0 };
  while (cursor.bidIndex < series.bid.length && series.bid[cursor.bidIndex].ts <= ts) {
    cursor.bid = series.bid[cursor.bidIndex].v;
    cursor.bidIndex += 1;
  }
  while (cursor.askIndex < series.ask.length && series.ask[cursor.askIndex].ts <= ts) {
    cursor.ask = series.ask[cursor.askIndex].v;
    cursor.askIndex += 1;
  }
  cursorByName.set(name, cursor);
  return cursor;
}

async function loadRollingStraddle() {
  const symbol = rollEls.symbol.value.trim().toUpperCase();
  const exchange = rollEls.exchange.value;
  const startDate = fromLocalInput(rollEls.start.value);
  const endDate = fromLocalInput(rollEls.end.value);
  if (!symbol) throw new Error("Rolling Straddle symbol is required.");
  if (!startDate || !endDate) throw new Error("Rolling Straddle start and end are required.");

  setRollStatus("Spot");
  const spotData = await nubraFetch("charts/timeseries", {
    method: "POST",
    body: JSON.stringify({
      query: [{
        exchange,
        type: rollEls.type.value,
        values: [symbol],
        fields: ["close"],
        startDate,
        endDate,
        interval: "1s",
        intraDay: false,
        realTime: false
      }]
    })
  });
  const spotSymbolData = extractSymbolData(spotData, symbol);
  const spotPoints = (Array.isArray(spotSymbolData?.close) ? spotSymbolData.close : [])
    .map((p) => ({ ts: pointMs(p), spot: pointNumber(p, true) }))
    .filter((p) => Number.isFinite(p.ts) && p.spot > 0)
    .sort((a, b) => a.ts - b.ts);
  if (!spotPoints.length) throw new Error("No 1-second spot data returned.");

  setRollStatus("Refdata");
  let rows = await rollingOptionRows();
  if (!rollEls.expiry.value) await loadRollingExpiries();
  const expiry = rollEls.expiry.value || rows[0]?.expiry;
  rows = rows.filter((row) => row.expiry === expiry);
  if (!rows.length) throw new Error("No option rows found for selected expiry.");

  const strikes = [...new Set(rows.map((row) => row.strike))].sort((a, b) => a - b);
  const step = inferStrikeStep(strikes);
  const rowByKey = new Map(rows.map((row) => [`${row.strike}|${row.side}`, row]));
  const requiredStrikes = new Set();
  for (const point of spotPoints) {
    const atm = nearestStrike(point.spot, strikes, step);
    for (let offset = -2; offset <= 2; offset++) {
      const strike = nearestStrike(atm + offset * step, strikes, step);
      requiredStrikes.add(strike);
    }
  }

  const optionNames = [];
  for (const strike of requiredStrikes) {
    const ce = rowByKey.get(`${strike}|CE`);
    const pe = rowByKey.get(`${strike}|PE`);
    if (ce) optionNames.push(ce.name);
    if (pe) optionNames.push(pe.name);
  }
  if (!optionNames.length) throw new Error("No CE/PE symbols found around ATM +/-2.");

  const seriesByName = await fetchRollingSeries([...new Set(optionNames)], exchange, startDate, endDate);
  const cursorByName = new Map();
  const bidLine = [];
  const askLine = [];
  const selected = [];

  for (const point of spotPoints) {
    const atm = nearestStrike(point.spot, strikes, step);
    let best = null;
    for (let offset = -2; offset <= 2; offset++) {
      const strike = nearestStrike(atm + offset * step, strikes, step);
      const ce = rowByKey.get(`${strike}|CE`);
      const pe = rowByKey.get(`${strike}|PE`);
      if (!ce || !pe) continue;
      const ceQuote = advanceRollingCursor(ce.name, seriesByName, cursorByName, point.ts);
      const peQuote = advanceRollingCursor(pe.name, seriesByName, cursorByName, point.ts);
      const bid = ceQuote.bid + peQuote.bid;
      const ask = ceQuote.ask + peQuote.ask;
      if (bid <= 0 || ask <= 0) continue;
      const mid = (bid + ask) / 2;
      if (!best || mid < best.mid) best = { strike, bid, ask, mid };
    }
    if (!best) continue;
    const time = tvTime(point.ts);
    bidLine.push({ time, value: best.bid });
    askLine.push({ time, value: best.ask });
    selected.push({ ...point, ...best });
  }

  if (!selected.length) throw new Error("No complete bid/ask straddle points found.");
  initRollingChart();
  tvState.rollBidSeries.setData([]);
  tvState.rollAskSeries.setData([]);

  const ANIM_MS = 1000;
  const total = bidLine.length;
  const startTs = performance.now();

  rollEls.meta.textContent = `${symbol} ${expiry} | 1s l1bid/l1ask | ${requiredStrikes.size} strikes | ${exchange}`;
  setRollStatus("Animating…");

  function animFrame(now) {
    const elapsed = now - startTs;
    const fraction = Math.min(elapsed / ANIM_MS, 1);
    const count = Math.max(1, Math.round(fraction * total));
    tvState.rollBidSeries.setData(bidLine.slice(0, count));
    tvState.rollAskSeries.setData(askLine.slice(0, count));
    if (count < total) {
      requestAnimationFrame(animFrame);
      return;
    }
    tvState.rollChart.timeScale().fitContent();
    const last = selected[selected.length - 1];
    rollEls.spot.textContent = rupee.format(last.spot);
    rollEls.strike.textContent = number.format(last.strike);
    rollEls.bid.textContent = rupee.format(last.bid);
    rollEls.ask.textContent = rupee.format(last.ask);
    rollEls.points.textContent = String(selected.length);
    setRollStatus("Ready");
  }
  requestAnimationFrame(animFrame);
}

bindSafe(rollEls.loadExpiries, loadRollingExpiries);
bindSafe(rollEls.load, loadRollingStraddle);

seedDates();
seedAuth();
bindInteractions();
render();
