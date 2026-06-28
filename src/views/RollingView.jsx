// Rolling Straddle view - settings sidebar + Bid/Ask/Avg/IV chart.

import { For, Show, createEffect, createMemo } from "solid-js";
import { number, rupee } from "../lib/format.js";
import { useApp } from "../state/AppContext.jsx";

export function RollingView() {
  const {
    section, busy, authed, run,
    leftSettingsCollapsed, toggleSettingsPanel,
    rollSymbol, rollExpiry, rollExchange, rollExpiries, rollStart, rollEnd,
    setRollExpiry, setRollStart, setRollEnd,
    rollStats, rollStatus, rollDrawnLines, rollWindowMode, rollSeriesVisibility,
    rollLive, rollLineName, rollLineValue, rollLineTarget, rollExportData,
    rollSelectedStrikes, rollChainRows,
    rollIndicatorMenuOpen, rollIndicatorPane, rollIndicatorPaneHeight,
    setRollLineName, setRollLineValue, setRollLineTarget,
    setRollIndicatorMenuOpen, setRollIndicatorPaneHeight,
    removeRollLine, rollLineColor, setRollChartWindowMode, toggleRollSeries,
    removeRollSelectedStrike, clearRollSelectedStrikes, toggleRollSelectedStrike,
    registerRollChartHost, registerRollIndicatorHost,
    openRollIndicatorPane, closeRollIndicatorPane,
    loadRollingExpiries, loadRollingStraddle, loadRollChainRows,
    startRollLive, stopRollLive, addRollLine, downloadCSV, downloadParquet,
    handleImport, openSymbolSearch,
    straddleMonitor, setStraddleMonitor, straddleAlerts,
  } = useApp();

  const chain = createMemo(() => rollChainRows() || { strikes: [], step: 0, atm: null });
  const tableStrikes = createMemo(() => {
    const { strikes, step, atm } = chain();
    if (!strikes.length) return [];
    if (atm == null || !step) return strikes;
    const atmIdx = strikes.indexOf(atm);
    if (atmIdx < 0) return strikes;
    const span = 16;
    return strikes.slice(Math.max(0, atmIdx - span), atmIdx + span + 1);
  });
  const strikeSelected = (strike) => rollSelectedStrikes().some((item) => Number(item) === Number(strike));
  const indicatorTitle = createMemo(() => rollIndicatorPane() === "vega" ? "Vega Decay" : "Premium Decay");
  let strikeTableWrap;
  let indicatorHost;

  createEffect(() => {
    tableStrikes();
    chain().atm;
    window.setTimeout(() => {
      strikeTableWrap?.querySelector(".atm-row")?.scrollIntoView({ block: "center" });
    }, 0);
  });

  createEffect(() => {
    const pane = rollIndicatorPane();
    if (pane !== "none" && indicatorHost) registerRollIndicatorHost(indicatorHost, pane);
  });

  const startIndicatorResize = (event) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = rollIndicatorPaneHeight();
    const onMove = (moveEvent) => {
      setRollIndicatorPaneHeight(startHeight + startY - moveEvent.clientY);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  };

  return (
    <section class={`view-panel ${section() === "rolling" ? "active" : ""}`} aria-hidden={section() !== "rolling"}>
      <div class={`pd-layout roll-layout ${leftSettingsCollapsed().rolling ? "settings-collapsed" : ""}`}>
        <aside class="pd-sidebar roll-settings">
          <div class="pd-side-head roll-side-head pd-side-head-empty">
            <span class="pd-side-title roll-side-title">Settings</span>
            <Show when={rollStatus()}><span class="roll-side-status">{rollStatus()}</span></Show>
            <button
              type="button"
              class="settings-collapse-btn"
              aria-label={leftSettingsCollapsed().rolling ? "Open settings" : "Close settings"}
              title={leftSettingsCollapsed().rolling ? "Open settings" : "Close settings"}
              onClick={() => toggleSettingsPanel("rolling")}
            />
          </div>

          <div class="pd-side-block roll-side-block">
            <label class="pd-section-label roll-section-label">Underlying</label>
            <button type="button" class="pd-underlying" disabled={!authed()} onClick={() => openSymbolSearch()} title="Choose underlying">
              <span class="pd-underlying-main">
                <span class="pd-underlying-sym">{rollSymbol() || "Select symbol"}</span>
                <span class="pd-underlying-exch">{rollExchange()}</span>
              </span>
              <svg class="pd-underlying-caret" width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>

          <div class="pd-side-block roll-side-block">
            <div class="pd-seg" role="tablist" aria-label="Data source">
              <button class={`pd-seg-btn ${!rollLive() ? "active" : ""}`} onClick={() => stopRollLive()}>Historical</button>
              <button class={`pd-seg-btn ${rollLive() ? "active" : ""}`} disabled={!authed()} onClick={() => startRollLive()}>Live</button>
            </div>
          </div>

          <div class="pd-side-block roll-side-block">
            <label class="pd-section-label roll-section-label">Expiry</label>
            <div class="pd-row">
              <select class="pd-select pd-grow" value={rollExpiry()} onChange={(e) => setRollExpiry(e.currentTarget.value)}>
                <option value="">Auto</option>
                <For each={rollExpiries()}>{(ex) => <option value={ex}>{ex}</option>}</For>
              </select>
              <button class="pd-btn pd-btn-icon" disabled={busy() || !authed()} onClick={() => run(loadRollingExpiries)} title="Reload expiries">↻</button>
            </div>
          </div>

          <Show when={!rollLive()}>
            <div class="pd-side-block roll-side-block">
              <label class="pd-section-label roll-section-label">Window</label>
              <input class="pd-input" type="datetime-local" value={rollStart()} onInput={(e) => setRollStart(e.currentTarget.value)} />
              <input class="pd-input mt-1" type="datetime-local" value={rollEnd()} onInput={(e) => setRollEnd(e.currentTarget.value)} />
            </div>
          </Show>

          <div class="pd-side-block roll-side-block pd-actions roll-actions">
            <button class="pd-btn pd-btn-accent pd-grow" disabled={busy() || !authed()} onClick={() => run(loadRollingStraddle)}>
              {busy() ? "Loading..." : "Plot"}
            </button>
            <Show
              when={rollLive()}
              fallback={<button class="pd-btn" disabled={busy() || !authed()} onClick={() => startRollLive()}>Live</button>}
            >
              <button class="pd-btn" onClick={() => stopRollLive()}>Stop</button>
            </Show>
          </div>

          <div class="pd-side-block roll-side-block">
            <label class="pd-section-label roll-section-label">Series</label>
            <div class="roll-chip-grid">
              <button class={`roll-series-chip ${rollSeriesVisibility().bid ? "on" : ""}`} onClick={() => toggleRollSeries("bid", 1)}>
                <span style="background:#10B981"></span>Bid
              </button>
              <button class={`roll-series-chip ${rollSeriesVisibility().ask ? "on" : ""}`} onClick={() => toggleRollSeries("ask", 2)}>
                <span style="background:#EF4444"></span>Ask
              </button>
              <button class={`roll-series-chip ${rollSeriesVisibility().avg ? "on" : ""}`} onClick={() => toggleRollSeries("avg", 4)}>
                <span class="dash" style="border-top-color:#8B5CF6"></span>Avg
              </button>
              <button class={`roll-series-chip ${rollSeriesVisibility().iv ? "on" : ""}`} onClick={() => toggleRollSeries("iv", 3)}>
                <span style="background:#3B82F6"></span>IV
              </button>
            </div>
          </div>

          <div class="pd-side-block roll-side-block">
            <label class="pd-section-label roll-section-label">Strike price</label>
            <div class="roll-strike-list">
              <For each={rollSelectedStrikes()} fallback={<span class="pd-hint">Auto uses lowest ATM +/-2 straddle.</span>}>
                {(strike) => (
                  <button type="button" class="roll-strike-chip" onClick={() => removeRollSelectedStrike(strike)} title="Remove strike">
                    {number.format(strike)} <span>×</span>
                  </button>
                )}
              </For>
            </div>
            <Show when={rollSelectedStrikes().length}>
              <button type="button" class="pd-link roll-clear-strikes" onClick={clearRollSelectedStrikes}>Use Auto ATM +/-2</button>
            </Show>
            <div class="pd-row pd-table-tools">
              <button class="pd-btn pd-grow" disabled={busy() || !authed()} onClick={() => run(loadRollChainRows)}>Load strikes</button>
            </div>
            <Show when={tableStrikes().length} fallback={<div class="pd-table-empty">Load strikes to pick strike prices.</div>}>
              <div class="pd-table-wrap roll-strike-table-wrap" ref={(el) => { strikeTableWrap = el; }}>
                <table class="pd-table">
                  <thead>
                    <tr><th>SELECT</th><th>STRIKE</th><th>ATM</th></tr>
                  </thead>
                  <tbody>
                    <For each={tableStrikes()}>
                      {(strike) => (
                        <tr class={strike === chain().atm ? "atm-row" : ""}>
                          <td>
                            <button class={`pd-add ${strikeSelected(strike) ? "on" : ""}`} onClick={() => toggleRollSelectedStrike(strike)}>
                              {strikeSelected(strike) ? "Selected" : "Select"}
                            </button>
                          </td>
                          <td class="strike-col">{number.format(strike)}</td>
                          <td>{strike === chain().atm ? "ATM" : ""}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </Show>
          </div>

          <div class="pd-side-block roll-side-block">
            <label class="pd-section-label roll-section-label">Range</label>
            <div data-ui="tabs" class="roll-window-tabs" data-activeid={rollWindowMode()} aria-label="Chart time window">
              <button data-ui="tab" id="full" onClick={() => setRollChartWindowMode("full")}>Full</button>
              <button data-ui="tab" id="3h" onClick={() => setRollChartWindowMode("3h")}>3H</button>
              <button data-ui="tab" id="1h" onClick={() => setRollChartWindowMode("1h")}>1H</button>
              <button data-ui="tab" id="30m" onClick={() => setRollChartWindowMode("30m")}>30M</button>
            </div>
          </div>

          <div class="pd-side-block roll-side-block">
            <label class="pd-section-label roll-section-label">Draw line</label>
            <input class="pd-input" value={rollLineName()} onInput={(e) => setRollLineName(e.currentTarget.value)} placeholder="Line name" />
            <div class="pd-row">
              <input class="pd-input" value={rollLineValue()} onInput={(e) => setRollLineValue(e.currentTarget.value)} placeholder="Value" inputmode="decimal" />
              <select class="pd-select roll-target-select" value={rollLineTarget()} onChange={(e) => setRollLineTarget(e.currentTarget.value)}>
                <option value="bid">Bid</option>
                <option value="ask">Ask</option>
                <option value="iv">IV</option>
              </select>
            </div>
            <button class="pd-btn" onClick={addRollLine}>Add line</button>
          </div>

          <div class="pd-side-block roll-side-block">
            <label class="pd-section-label roll-section-label">Export</label>
            <div class="pd-row">
              <label class="pd-btn pd-grow roll-import-btn" title="Import CSV or Parquet file">
                Import
                <input type="file" accept=".csv,.parquet" class="sr-only" onChange={handleImport} />
              </label>
              <button class="pd-btn" disabled={!rollExportData().length} onClick={downloadCSV}>CSV</button>
              <button class="pd-btn" disabled={!rollExportData().length} onClick={downloadParquet}>Parquet</button>
            </div>
          </div>

          <div class="pd-side-block roll-side-block">
            <label class="pd-section-label roll-section-label">Metrics</label>
            <div class="roll-metric-grid">
              <Metric label="Spot" value={rollStats().spot} />
              <Metric label="Strike" value={rollStats().strike} />
              <Metric label="Bid" value={rollStats().bid} tone="bid" />
              <Metric label="Ask" value={rollStats().ask} tone="ask" />
              <Metric label="IV Mid" value={rollStats().iv} tone="iv" />
            </div>
          </div>

          <div class="pd-side-block roll-side-block">
            <div class="roll-monitor-row">
              <span>
                <label class="pd-section-label roll-section-label">Monitor</label>
                <small>{straddleMonitor() ? "Alerts enabled" : "Alerts off"}</small>
              </span>
              <button class={`roll-toggle ${straddleMonitor() ? "on" : ""}`} onClick={() => {
                setStraddleMonitor(!straddleMonitor());
                if (!straddleMonitor() === false && typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission();
              }}>
                {straddleMonitor() ? "ON" : "OFF"}
              </button>
            </div>
          </div>

          <Show when={straddleAlerts().length}>
            <div class="pd-side-block roll-side-block">
              <label class="pd-section-label roll-section-label">Alerts</label>
              <div class="roll-alert-list">
                <For each={straddleAlerts().slice(0, 5)}>
                  {(a) => (
                    <div class="roll-alert-item">
                      <strong>{a.title}</strong>
                      <span>{a.body}</span>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <Show when={rollDrawnLines().length}>
            <div class="pd-side-block roll-side-block">
              <label class="pd-section-label roll-section-label">Lines</label>
              <div class="line-list">
                <For each={rollDrawnLines()}>
                  {(line) => (
                    <button data-ui="button" data-appearance="stealth" class="w-full" onClick={() => removeRollLine(line.id)} title="Remove line">
                      <span class="line-list-color" style={`background:${rollLineColor(line.target)}`}></span>
                      <span class="line-list-name">{line.name}</span>
                      <span class="line-list-value">{line.target === "iv" ? `${line.value}%` : rupee.format(line.value)}</span>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </aside>

        <main class="pd-main roll-main">
          <div class="pd-main-head">
            <div>
              <span class="pd-main-title">Rolling Straddle</span>
              <span class="pd-main-sub">Lowest ATM +/-2 straddle, sampled every second.</span>
            </div>
            <div class="roll-indicator-tools">
              <button
                type="button"
                class={`pd-btn roll-indicator-btn ${rollIndicatorMenuOpen() ? "active" : ""}`}
                onClick={() => setRollIndicatorMenuOpen(!rollIndicatorMenuOpen())}
              >
                Indicator
              </button>
              <Show when={rollIndicatorMenuOpen()}>
                <div class="roll-indicator-menu">
                  <button type="button" onClick={() => run(() => openRollIndicatorPane("vega"))}>Vega Decay</button>
                  <button type="button" onClick={() => run(() => openRollIndicatorPane("premium"))}>Premium Decay</button>
                </div>
              </Show>
            </div>
          </div>
          <div class={`pd-chart-card roll-main-chart ${rollIndicatorPane() !== "none" ? "has-indicator" : ""}`}>
            <div class="pd-chart-shell roll-primary-shell">
              <div class="pd-chart" ref={(el) => registerRollChartHost(el)} />
            </div>
            <Show when={rollIndicatorPane() !== "none"}>
              <div class="roll-pane-divider">
                <button
                  type="button"
                  class="roll-indicator-resize"
                  aria-label="Resize indicator pane"
                  title="Resize indicator pane"
                  onPointerDown={startIndicatorResize}
                />
              </div>
              <div class="roll-indicator-pane" style={{ height: `${rollIndicatorPaneHeight()}px` }}>
                <div class="roll-indicator-chipbar">
                  <span class="roll-indicator-chip-title">{indicatorTitle()}</span>
                  <button type="button" class="roll-indicator-icon" title="Close indicator" aria-label="Close indicator" onClick={closeRollIndicatorPane}>x</button>
                </div>
                <div class="pd-chart-shell roll-indicator-shell">
                  <div class="pd-chart" ref={(el) => { indicatorHost = el; registerRollIndicatorHost(el, rollIndicatorPane()); }} />
                </div>
              </div>
            </Show>
          </div>
        </main>
      </div>
    </section>
  );
}

function Metric(props) {
  return (
    <div class="roll-metric">
      <span>{props.label}</span>
      <strong class={props.tone || ""}>{props.value}</strong>
    </div>
  );
}
