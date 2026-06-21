// IV Term Structure view — ATM IV by expiry curve + volatility smile/skew chart
// and a term-structure table. The Highcharts builders/effects stay in App and
// drive the chart hosts registered here via the store.

import { For, Show } from "solid-js";
import { number, formatPlain } from "../lib/format.js";
import { useApp } from "../state/AppContext.jsx";

export function IvTermView() {
  const {
    section, busy, authed,
    ivTermSymbol, ivTermExchange, ivTermStatus, ivTermSummary, ivTermPoints,
    smileSurfaces, smileExpiry, selectedSmile, smileSurfaceForExpiry,
    setIvTermSymbol, setIvTermExchange, setSmileExpiry,
    registerIvTermHost, registerSmileHost,
    run, loadIvTermStructure,
  } = useApp();

  return (
    <section class={`view-panel ${section() === "iv-term" ? "active" : ""}`} aria-hidden={section() !== "iv-term"}>
      <div class="iv-term-workspace">
        <div class="iv-term-toolbar">
          <div>
            <span class="iv-term-eyebrow">Option Chain Analytics</span>
            <h2>IV Term Structure</h2>
          </div>
          <label class="tb-field">
            <span class="tb-field-label">underlying</span>
            <input class="tb-field-input" value={ivTermSymbol()} onInput={(event) => setIvTermSymbol(event.currentTarget.value.toUpperCase())} placeholder="NIFTY" />
          </label>
          <label class="tb-field">
            <span class="tb-field-label">exchange</span>
            <select class="tb-field-select" value={ivTermExchange()} onInput={(event) => setIvTermExchange(event.currentTarget.value)}>
              <option value="NSE">NSE</option>
              <option value="BSE">BSE</option>
              <option value="MCX">MCX</option>
            </select>
          </label>
          <button data-ui="button" data-appearance="accent" disabled={busy() || !authed()} onClick={() => run(loadIvTermStructure)}>
            {busy() ? "Loading…" : "Load Curve"}
          </button>
          <span class="iv-term-status">{ivTermStatus()}</span>
        </div>

        <div class="iv-term-metrics">
          <div><span>Front ATM IV</span><strong>{ivTermSummary().frontIv == null ? "--" : `${formatPlain(ivTermSummary().frontIv, 2)}%`}</strong></div>
          <div><span>Back ATM IV</span><strong>{ivTermSummary().backIv == null ? "--" : `${formatPlain(ivTermSummary().backIv, 2)}%`}</strong></div>
          <div><span>Curve slope</span><strong class={ivTermSummary().slope == null ? "" : ivTermSummary().slope >= 0 ? "up" : "down"}>{ivTermSummary().slope == null ? "--" : `${ivTermSummary().slope >= 0 ? "+" : ""}${formatPlain(ivTermSummary().slope, 2)} pts`}</strong></div>
          <div><span>Structure</span><strong>{ivTermSummary().shape}</strong></div>
        </div>

        <div class="iv-term-content">
          <div class="iv-analytics-charts">
            <div class="iv-term-chart-card">
              <div class="iv-term-chart-head">
                <div><strong>ATM Implied Volatility by Expiry</strong><span>Average of nearest-strike CE and PE IV</span></div>
                <span data-ui="badge">{ivTermPoints().length} expiries</span>
              </div>
              <div class="iv-term-chart-shell">
                <div class="iv-term-chart" ref={(el) => registerIvTermHost(el)} />
                <Show when={!ivTermPoints().length}>
                  <div class="iv-term-empty">Load the curve to query ATM IV across all available expiries.</div>
                </Show>
              </div>
            </div>

            <div class="iv-term-chart-card">
              <div class="iv-term-chart-head smile-chart-head">
                <div><strong>Volatility Smile / Skew</strong><span>Call and put IV across strikes · 25Δ analytics</span></div>
                <select value={smileExpiry()} onInput={(event) => setSmileExpiry(event.currentTarget.value)} aria-label="Smile expiry">
                  <For each={smileSurfaces()}>{(surface) => <option value={surface.expiry}>{surface.expiry}</option>}</For>
                </select>
              </div>
              <div class="smile-metrics">
                <span>25Δ RR <strong class={selectedSmile()?.rr25 == null ? "" : selectedSmile().rr25 >= 0 ? "up" : "down"}>{selectedSmile()?.rr25 == null ? "--" : `${selectedSmile().rr25 >= 0 ? "+" : ""}${formatPlain(selectedSmile().rr25, 2)}`}</strong></span>
                <span>25Δ BF <strong>{selectedSmile()?.bf25 == null ? "--" : `${selectedSmile().bf25 >= 0 ? "+" : ""}${formatPlain(selectedSmile().bf25, 2)}`}</strong></span>
                <span>25Δ Call <strong>{selectedSmile()?.call25Iv == null ? "--" : `${formatPlain(selectedSmile().call25Iv, 2)}%`}</strong></span>
                <span>25Δ Put <strong>{selectedSmile()?.put25Iv == null ? "--" : `${formatPlain(selectedSmile().put25Iv, 2)}%`}</strong></span>
              </div>
              <div class="iv-term-chart-shell">
                <div class="iv-term-chart" ref={(el) => registerSmileHost(el)} />
                <Show when={!selectedSmile()}><div class="iv-term-empty">Load the curve to calculate smile and skew.</div></Show>
              </div>
            </div>
          </div>

          <div class="iv-term-table-wrap">
            <table class="iv-term-table">
              <thead><tr><th>Expiry</th><th>DTE</th><th>ATM Strike</th><th>CE IV</th><th>PE IV</th><th>ATM IV</th><th>25Δ RR</th><th>25Δ BF</th></tr></thead>
              <tbody>
                <For each={ivTermPoints()} fallback={<tr><td colspan="8">No term-structure data loaded</td></tr>}>
                  {(point) => (
                    <tr>
                      <td>{point.expiry}</td>
                      <td>{point.dte ?? "--"}</td>
                      <td>{number.format(point.strike)}</td>
                      <td>{point.ceIv == null ? "--" : `${formatPlain(point.ceIv, 2)}%`}</td>
                      <td>{point.peIv == null ? "--" : `${formatPlain(point.peIv, 2)}%`}</td>
                      <td><strong>{formatPlain(point.atmIv, 2)}%</strong></td>
                      <td>{smileSurfaceForExpiry(point.expiry)?.rr25 == null ? "--" : formatPlain(smileSurfaceForExpiry(point.expiry).rr25, 2)}</td>
                      <td>{smileSurfaceForExpiry(point.expiry)?.bf25 == null ? "--" : formatPlain(smileSurfaceForExpiry(point.expiry).bf25, 2)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}
