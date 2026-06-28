// Shared constant tables and config — no app state.

export const CHAIN_COLUMNS = [
  { key: "delta", label: "Delta" },
  { key: "oi", label: "OI" },
  { key: "oi_change", label: "OI Change %" },
  { key: "volume", label: "Volume" },
  { key: "ltp", label: "LTP" },
  { key: "iv", label: "IV (%)" },
  { key: "gamma", label: "Gamma" },
  { key: "theta", label: "Theta" },
  { key: "vega", label: "Vega" }
];

export const CALL_COLUMN_ORDER = ["delta", "oi", "oi_change", "volume", "vega", "theta", "gamma", "iv", "ltp"];
export const PUT_COLUMN_ORDER = ["ltp", "iv", "gamma", "theta", "vega", "volume", "oi_change", "oi", "delta"];
export const DEFAULT_CHAIN_COLUMNS = Object.fromEntries(CHAIN_COLUMNS.map((column) => [column.key, true]));

export const MARKET_STRIP_SYMBOLS = [
  { label: "NIFTY", instrument: "NIFTY", exchange: "NSE" },
  { label: "BANKNIFTY", instrument: "BANKNIFTY", exchange: "NSE" },
  { label: "SENSEX", instrument: "SENSEX", exchange: "BSE" },
  { label: "CRUDE", instrument: "CRUDEOIL", exchange: "MCX", unit: "₹/bbl" },
  { label: "NAT GAS", instrument: "NATURALGAS", exchange: "MCX", unit: "₹/mmBtu" }
];

export const INSTRUMENT_EXCHANGES = ["NSE", "BSE", "MCX"];

export const SYMBOL_CATEGORIES = [
  { key: "all", label: "All" },
  { key: "index", label: "Index" },
  { key: "stock", label: "Stocks" },
  { key: "future", label: "Futures" },
  { key: "option", label: "Options" },
  { key: "commodity", label: "Commodity" }
];

export const INSTRUMENT_DB = "nubra-instrument-cache-v1";
export const INSTRUMENT_STORE = "masters";
export const ROLLING_INTERVALS = ["1s", "1m"];
export const ROLLING_BATCH_SIZE = 8;
// Keep concurrency low: Nubra's gateway returns 403 (nginx) when too many
// charts/timeseries requests arrive in a burst. One batch of 8 at a time, with
// a short pause between batches, stays under that limit.
export const ROLLING_FETCH_CONCURRENCY = 1;
export const ROLLING_BATCH_DELAY_MS = 220;
// Nubra rejects history older than this many days with HTTP 400.
export const ROLLING_MAX_HISTORY_DAYS = 7;

// Rolling Straddle live feed: how often (ms) incoming WS ticks are flushed to
// the chart. 0 = per-tick (every message drawn, no coalescing). Higher values
// coalesce bursts to at most one draw per window (e.g. 250 = ~4 draws/sec).
export const ROLL_LIVE_THROTTLE_OPTIONS = [
  { value: 0,   label: "Tick" },
  { value: 250, label: "250ms" },
  { value: 1000, label: "1s" }
];
export const ROLL_LIVE_THROTTLE_DEFAULT = 0;

// OIE chart styling tokens (uPlot).
export const OIE_AXIS_FONT = "11px Inter, system-ui, sans-serif";
export const OIE_GRID     = "rgba(68,80,94,0.32)";
export const OIE_TICK     = "rgba(68,80,94,0.50)";
export const OIE_BORDER   = "rgba(68,80,94,0.45)";
export const OIE_TEXT     = "rgba(160,180,200,0.85)";
export const OIE_BG       = "#202A38";
