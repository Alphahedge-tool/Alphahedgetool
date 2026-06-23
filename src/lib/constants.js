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
export const ROLLING_FETCH_CONCURRENCY = 4;

// OIE chart styling tokens (uPlot).
export const OIE_AXIS_FONT = "11px Inter, system-ui, sans-serif";
export const OIE_GRID     = "rgba(255,255,255,0.05)";
export const OIE_TICK     = "rgba(255,255,255,0.12)";
export const OIE_BORDER   = "rgba(255,255,255,0.08)";
export const OIE_TEXT     = "rgba(160,180,200,0.85)";
export const OIE_BG       = "#0c0f16";
