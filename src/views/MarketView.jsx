// Market view — generic instrument price-candle chart with symbol/type/exchange/
// interval/date controls and a spot/change/candles sidebar. The lightweight-chart
// is created in App and bound to the host registered here via the store.

import { useApp } from "../state/AppContext.jsx";

export function MarketView() {
  const {
    section, busy, authed,
    symbol, instrumentType, exchange, interval, startDate, endDate,
    spot, change, candleCount, chartStatus,
    smartOiIndicatorEnabled,
    setSymbol, setInstrumentType, setExchange, setIntervalValue, setStartDate, setEndDate,
    run, loadSpotPrice, loadPriceChart, toggleSmartOiIndicator, registerPriceChartHost,
  } = useApp();

  return (
    <section class={`view-panel ${section() === "market" ? "active" : ""}`} aria-hidden={section() !== "market"}>
      {/* ── Toolbar ── */}
      <div class="control-panel">
        <label class="terminal-label">
          Symbol
          <input data-ui="input" class="w-24" value={symbol()} onInput={(e) => setSymbol(e.currentTarget.value.toUpperCase())} />
        </label>
        <label class="terminal-label">
          Type
          <select data-ui="select" value={instrumentType()} onChange={(e) => setInstrumentType(e.currentTarget.value)}>
            <option value="INDEX">INDEX</option>
            <option value="STOCK">STOCK</option>
            <option value="FUT">FUT</option>
            <option value="OPT">OPT</option>
          </select>
        </label>
        <label class="terminal-label">
          Exchange
          <select data-ui="select" value={exchange()} onChange={(e) => setExchange(e.currentTarget.value)}>
            <option value="NSE">NSE</option>
            <option value="BSE">BSE</option>
            <option value="MCX">MCX</option>
          </select>
        </label>
        <label class="terminal-label">
          Interval
          <select data-ui="select" value={interval()} onChange={(e) => setIntervalValue(e.currentTarget.value)}>
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
          <input data-ui="input" class="w-40" type="datetime-local" value={startDate()} onInput={(e) => setStartDate(e.currentTarget.value)} />
        </label>
        <label class="terminal-label">
          End
          <input data-ui="input" class="w-40" type="datetime-local" value={endDate()} onInput={(e) => setEndDate(e.currentTarget.value)} />
        </label>
        <div class="ml-auto flex items-center gap-2">
          <button data-ui="button" data-appearance="outline" onClick={() => run(loadSpotPrice)} disabled={busy()}>Spot</button>
          <button data-ui="button" data-appearance="accent" onClick={() => run(loadPriceChart)} disabled={busy()}>Load Chart</button>
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
          <div class="chart-card-header flex-wrap gap-3">
            <div>
              <h2 class="chart-card-title">{symbol()}</h2>
              <p class="chart-card-meta">{interval()} · Price candles · IST</p>
            </div>
            <div class="flex items-center gap-2 text-[10px] font-semibold" style="letter-spacing:0">
              <button
                data-ui="button"
                data-appearance={smartOiIndicatorEnabled() ? "accent" : "outline"}
                onClick={() => run(toggleSmartOiIndicator)}
                disabled={busy() || !authed()}
                title="Add/remove Smart OI indicator"
              >
                Smart OI
              </button>
              <span class={`h-1.5 w-1.5 rounded-full ${authed() ? "bg-emerald-400" : "bg-amber-400"}`}></span>
              <span style={`color:${authed() ? "#34d399" : "#8B5CF6"}`}>{authed() ? "Live" : "No session"}</span>
            </div>
          </div>
          <div class="chart-card-body" ref={(el) => registerPriceChartHost(el)}></div>
        </div>
      </div>
    </section>
  );
}
