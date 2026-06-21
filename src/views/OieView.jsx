// OIE / GEX view — Open-Interest Engine dashboard with Intelligence, Analytics,
// Signals, GEX Chain and Charts tabs. Data loaders live in App; this view reads
// the oie* signals from the store and renders the tabbed UI.

import { For, Show } from "solid-js";
import { number, formatCompact, formatStrike, strikePx } from "../lib/format.js";
import { OieGEXProfileChart, OieOIBuildupChart } from "../components/OieCharts.jsx";
import { useApp } from "../state/AppContext.jsx";

const OIE_UNDERLYINGS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];

export function OieView() {
  const {
    section, run,
    oieTab, oieSymbol, oieExpiry, oieExpiries, oieExpiryLoading,
    oieData, oieAnalytics, oieSignals, oieChain, oieStatus, oieError,
    setOieTab, setOieSymbol, setOieExpiry, setOieExpiries, setOieError,
    loadOieExpiries, loadOie,
  } = useApp();

  return (
    <section class={`view-panel ${section() === "gex" ? "active" : ""}`} aria-hidden={section() !== "gex"}>
      <div class="oie-workspace">

        {/* ── OIE top bar ── */}
        <div class="oie-topbar">
          <div class="oie-topbar-left">
            <span class="oie-logo-dot" />
            <div class="oie-symbol-row">
              <For each={OIE_UNDERLYINGS}>
                {(sym) => (
                  <button
                    class={`oie-sym-btn${oieSymbol() === sym ? " active" : ""}`}
                    onClick={() => {
                      setOieSymbol(sym);
                      setOieExpiries([]);
                      setOieExpiry("");
                      setOieError("");
                      run(() => loadOieExpiries(sym));
                    }}
                    disabled={oieStatus() === "loading" || oieExpiryLoading()}
                  >{sym}</button>
                )}
              </For>
            </div>

            {/* Expiry selector — appears once expiries are loaded */}
            <Show when={oieExpiries().length > 0}>
              <div class="oie-expiry-wrap">
                <select
                  class="oie-expiry-select"
                  value={oieExpiry()}
                  onChange={(e) => setOieExpiry(e.currentTarget.value)}
                  disabled={oieStatus() === "loading"}
                >
                  <For each={oieExpiries()}>
                    {(exp) => <option value={exp}>{exp}</option>}
                  </For>
                </select>
              </div>
            </Show>

            <Show when={oieExpiryLoading()}>
              <span class="oie-expiry-hint">Loading expiries…</span>
            </Show>
          </div>

          <div class="oie-topbar-right">
            <Show when={oieError()}>
              <span class="oie-error-badge">{oieError()}</span>
            </Show>
            <Show when={oieChain() && !oieError()}>
              <span class={`oie-status-badge oie-status-${oieStatus()}`}>
                <span class="oie-status-dot" />
                {oieStatus() === "loading" ? "Loading…" : "Computed"}
              </span>
            </Show>
            <Show when={oieExpiries().length > 0}>
              <button
                class="oie-refresh-btn"
                onClick={() => loadOie()}
                disabled={oieStatus() === "loading" || !oieExpiry()}
              >
                {oieStatus() === "loading" ? "Loading…" : "Analyse"}
              </button>
            </Show>
          </div>
        </div>

        {/* ── OIE sub-tabs ── */}
        <div class="oie-tabs">
          {[
            { id: "intelligence", label: "Intelligence" },
            { id: "analytics",    label: "Analytics" },
            { id: "signals",      label: "Signals" },
            { id: "chain",        label: "GEX Chain" },
            { id: "charts",       label: "Charts" },
          ].map(({ id, label }) => (
            <button
              class={`oie-tab${oieTab() === id ? " active" : ""}`}
              onClick={() => setOieTab(id)}
            >{label}</button>
          ))}
        </div>

        {/* ═══ INTELLIGENCE TAB ═══ */}
        <Show when={oieTab() === "intelligence"}>
          <div class="oie-panel">
            <Show when={!oieData()} fallback={
              <div class="oie-grid">
                {/* Bias card */}
                <div class={`oie-bias-card oie-bias-${String(oieData()?.market_bias || "neutral").toLowerCase()}`}>
                  <div class="oie-bias-label">Market Bias</div>
                  <div class="oie-bias-value">{oieData()?.market_bias ?? "—"}</div>
                  <div class="oie-bias-conf">Confidence: {oieData()?.confidence_score != null ? `${Math.round(oieData().confidence_score)}%` : "—"}</div>
                </div>
                {/* Spot */}
                <div class="oie-metric-card">
                  <div class="oie-mc-label">Spot Price</div>
                  <div class="oie-mc-value">{oieData()?.spot_price != null ? number.format(oieData().spot_price) : "—"}</div>
                </div>
                {/* Gamma Regime */}
                <div class="oie-metric-card">
                  <div class="oie-mc-label">Gamma Regime</div>
                  <div class="oie-mc-value oie-regime">{oieData()?.gamma_regime ?? "—"}</div>
                </div>
                {/* Vol Regime */}
                <div class="oie-metric-card">
                  <div class="oie-mc-label">Volatility Regime</div>
                  <div class="oie-mc-value">{oieData()?.volatility_regime ?? "—"}</div>
                </div>
                {/* Dealer Positioning */}
                <div class="oie-metric-card">
                  <div class="oie-mc-label">Dealer Positioning</div>
                  <div class="oie-mc-value">{oieData()?.dealer_positioning ?? "—"}</div>
                </div>
                {/* Expected Move */}
                <div class="oie-metric-card">
                  <div class="oie-mc-label">Expected Move (Day)</div>
                  <div class="oie-mc-value">{oieData()?.expected_move_daily != null ? `${oieData().expected_move_daily.toFixed(2)}%` : "—"}</div>
                </div>
                {/* Seller Edge */}
                <div class="oie-metric-card">
                  <div class="oie-mc-label">Seller Favorability</div>
                  <div class="oie-mc-value">{oieData()?.option_seller_favorability ?? "—"}</div>
                </div>
                {/* ATM IV */}
                <div class="oie-metric-card">
                  <div class="oie-mc-label">ATM IV</div>
                  <div class="oie-mc-value">{oieData()?.metric_summary?.atm_iv != null ? `${oieData().metric_summary.atm_iv.toFixed(2)}%` : "—"}</div>
                </div>
                {/* PCR */}
                <div class="oie-metric-card">
                  <div class="oie-mc-label">PCR</div>
                  <div class="oie-mc-value">{oieData()?.metric_summary?.pcr != null ? oieData().metric_summary.pcr.toFixed(2) : "—"}</div>
                </div>
                {/* IV Rank */}
                <div class="oie-metric-card">
                  <div class="oie-mc-label">IV Rank</div>
                  <div class="oie-mc-value">{oieData()?.metric_summary?.iv_rank != null ? `${Math.round(oieData().metric_summary.iv_rank)}` : "—"}</div>
                </div>
              </div>
            }>
              <div class="oie-empty">
                <div class="oie-empty-icon">⚡</div>
                <p>Select an underlying and click <strong>Load / Refresh</strong> to see live intelligence.</p>
              </div>
            </Show>
          </div>
        </Show>

        {/* ═══ ANALYTICS TAB ═══ */}
        <Show when={oieTab() === "analytics"}>
          <div class="oie-panel">
            <Show when={!oieAnalytics()} fallback={
              <div class="oie-analytics-sections">
                {/* Open Interest group */}
                <div class="oie-section">
                  <div class="oie-section-title">Open Interest</div>
                  <div class="oie-analytics-grid">
                    <For each={["pcr","dynamic_pcr","oi_momentum","oi_concentration","oi_imbalance","call_wall","put_wall","max_pain"]}>
                      {(key) => {
                        const val = oieAnalytics()?.metrics?.[key];
                        return (
                          <div class="oie-a-card">
                            <div class="oie-a-label">{key.replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase())}</div>
                            <div class="oie-a-value">{val != null ? (typeof val === "number" ? val.toFixed(2) : val) : "—"}</div>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </div>
                {/* Volatility group */}
                <div class="oie-section">
                  <div class="oie-section-title">Volatility</div>
                  <div class="oie-analytics-grid">
                    <For each={["atm_iv","iv_rank","iv_percentile","expected_move","iv_skew","vol_regime"]}>
                      {(key) => {
                        const val = oieAnalytics()?.metrics?.[key];
                        return (
                          <div class="oie-a-card">
                            <div class="oie-a-label">{key.replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase())}</div>
                            <div class="oie-a-value">{val != null ? (typeof val === "number" ? val.toFixed(2) : val) : "—"}</div>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </div>
                {/* Greeks / Dealer group */}
                <div class="oie-section">
                  <div class="oie-section-title">Dealer / Greeks</div>
                  <div class="oie-analytics-grid">
                    <For each={["gex","gamma_regime","gamma_flip","vanna_exposure","charm_exposure","hedging_pressure","pin_risk"]}>
                      {(key) => {
                        const val = oieAnalytics()?.metrics?.[key];
                        return (
                          <div class="oie-a-card">
                            <div class="oie-a-label">{key.replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase())}</div>
                            <div class="oie-a-value">{val != null ? (typeof val === "number" ? val.toFixed(2) : val) : "—"}</div>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </div>
              </div>
            }>
              <div class="oie-empty"><div class="oie-empty-icon">📊</div><p>Load data to see analytics.</p></div>
            </Show>
          </div>
        </Show>

        {/* ═══ SIGNALS TAB ═══ */}
        <Show when={oieTab() === "signals"}>
          <div class="oie-panel">
            <Show when={!oieSignals()} fallback={
              <div class="oie-signals-layout">
                {/* Score meter */}
                <div class="oie-score-row">
                  <div class="oie-score-block bullish">
                    <div class="oie-score-num">{oieSignals()?.bullish_score ?? "—"}</div>
                    <div class="oie-score-lbl">Bullish Score</div>
                  </div>
                  <div class="oie-score-bar-wrap">
                    <div class="oie-score-bar" style={`--bull:${oieSignals()?.bullish_score ?? 0}%;--bear:${oieSignals()?.bearish_score ?? 0}%`} />
                  </div>
                  <div class="oie-score-block bearish">
                    <div class="oie-score-num">{oieSignals()?.bearish_score ?? "—"}</div>
                    <div class="oie-score-lbl">Bearish Score</div>
                  </div>
                </div>
                {/* Signal list */}
                <div class="oie-signal-list">
                  <For each={oieSignals()?.signals ?? []}>
                    {(sig) => (
                      <div class={`oie-sig-row oie-sig-${String(sig.direction || "neutral").toLowerCase()}`}>
                        <span class="oie-sig-dir">{sig.direction === "Bullish" ? "▲" : sig.direction === "Bearish" ? "▼" : "●"}</span>
                        <span class="oie-sig-cat">{sig.category}</span>
                        <span class="oie-sig-name">{sig.name}</span>
                        <div class="oie-sig-bar-wrap">
                          <div class="oie-sig-bar" style={`width:${Math.min(100,(sig.strength ?? 0)*10)}%`} />
                        </div>
                        <span class="oie-sig-strength">{sig.strength ?? "—"}/10</span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            }>
              <div class="oie-empty"><div class="oie-empty-icon">📡</div><p>Load data to see composite signals.</p></div>
            </Show>
          </div>
        </Show>

        {/* ═══ GEX CHAIN TAB ═══ */}
        <Show when={oieTab() === "chain"}>
          <div class="oie-panel oie-chain-panel">
            <Show when={!oieChain()} fallback={
              <div class="oie-chain-wrap">
                <div class="oie-chain-meta">
                  <span class="oie-chain-underlying">{oieChain()?.underlying ?? oieSymbol()}</span>
                  <span class="oie-chain-spot">Spot: {oieChain()?.spot_price != null ? number.format(oieChain().spot_price) : "—"}</span>
                </div>
                <table class="oie-chain-table">
                  <thead>
                    <tr>
                      <th>CE LTP</th><th>CE IV</th><th>CE Δ</th><th>CE Γ</th><th>CE OI</th><th>CE ΔOI</th>
                      <th class="oie-strike-head">Strike</th>
                      <th>PE ΔOI</th><th>PE OI</th><th>PE Γ</th><th>PE Δ</th><th>PE IV</th><th>PE LTP</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={oieChain()?.strikes ?? []}>
                      {(row) => {
                        const isAtm = oieChain()?.atm_strike != null && Number(row.strike_price) === Number(oieChain().atm_strike);
                        return (
                          <tr class={isAtm ? "oie-atm-row" : ""}>
                            <td class="oie-ce">{row.ce_ltp != null ? row.ce_ltp.toFixed(2) : "—"}</td>
                            <td class="oie-ce">{row.ce_iv != null ? `${row.ce_iv.toFixed(1)}%` : "—"}</td>
                            <td class="oie-ce">{row.ce_delta != null ? row.ce_delta.toFixed(2) : "—"}</td>
                            <td class="oie-ce oie-gamma">{row.ce_gamma != null ? row.ce_gamma.toFixed(4) : "—"}</td>
                            <td class="oie-ce oie-oi">{row.ce_oi != null ? formatCompact(row.ce_oi) : "—"}</td>
                            <td class={`oie-ce ${(row.ce_oi_change ?? 0) >= 0 ? "oie-oi-up" : "oie-oi-dn"}`}>{row.ce_oi_change != null ? formatCompact(row.ce_oi_change) : "—"}</td>
                            <td class="oie-strike-cell">{row.strike_price != null ? formatStrike(row.strike_price) : "—"}</td>
                            <td class={`oie-pe ${(row.pe_oi_change ?? 0) >= 0 ? "oie-oi-up" : "oie-oi-dn"}`}>{row.pe_oi_change != null ? formatCompact(row.pe_oi_change) : "—"}</td>
                            <td class="oie-pe oie-oi">{row.pe_oi != null ? formatCompact(row.pe_oi) : "—"}</td>
                            <td class="oie-pe oie-gamma">{row.pe_gamma != null ? row.pe_gamma.toFixed(4) : "—"}</td>
                            <td class="oie-pe">{row.pe_delta != null ? row.pe_delta.toFixed(2) : "—"}</td>
                            <td class="oie-pe">{row.pe_iv != null ? `${row.pe_iv.toFixed(1)}%` : "—"}</td>
                            <td class="oie-pe">{row.pe_ltp != null ? row.pe_ltp.toFixed(2) : "—"}</td>
                          </tr>
                        );
                      }}
                    </For>
                  </tbody>
                </table>
              </div>
            }>
              <div class="oie-empty"><div class="oie-empty-icon">🔗</div><p>Load data to see the GEX chain with delta, gamma, and OI.</p></div>
            </Show>
          </div>
        </Show>

        {/* ═══ CHARTS TAB ═══ */}
        <Show when={oieTab() === "charts"}>
          <div class="oie-panel oie-charts-panel">
            <Show when={oieChain()} fallback={
              <div class="oie-empty">
                <div class="oie-empty-icon">📊</div>
                <p>select a symbol and click <strong>Analyse</strong> to load charts.</p>
              </div>
            }>
              {/* meta bar */}
              <div class="oie-charts-meta">
                <span class="oie-charts-meta-sym">{(oieChain()?.underlying ?? oieSymbol()).toLowerCase()}</span>
                <span class="oie-charts-meta-dot" />
                <span class="oie-charts-meta-info">spot <strong>{oieChain()?.spot_price != null ? oieChain().spot_price.toFixed(2) : "—"}</strong></span>
                <span class="oie-charts-meta-dot" />
                <span class="oie-charts-meta-info">atm <strong>{oieChain()?.atm_strike != null ? strikePx(oieChain().atm_strike) : "—"}</strong></span>
                <span class="oie-charts-meta-dot" />
                <span class="oie-charts-meta-info">{oieChain()?.strikes?.length ?? 0} strikes</span>
                <Show when={oieStatus() === "loading"}>
                  <span class="oie-charts-meta-live">updating…</span>
                </Show>
              </div>

              {/* GEX profile — re-mounts on each chain update for live refresh */}
              <div class="oie-chart-card">
                <div class="oie-chart-header">
                  <span class="oie-chart-card-title">gex profile</span>
                  <span class="oie-chart-legend">
                    <span class="oie-legend-item"><span class="oie-legend-dot" style="background:#34d399" />long γ</span>
                    <span class="oie-legend-item"><span class="oie-legend-dot" style="background:#f87171" />short γ</span>
                    <span class="oie-legend-item"><span class="oie-legend-dot" style="background:rgba(34,211,238,0.6);border-radius:2px" />atm</span>
                  </span>
                </div>
                <OieGEXProfileChart
                  key={oieChain()}
                  strikes={oieChain()?.strikes?.map(s => ({
                    ...s,
                    is_atm: oieChain()?.atm_strike != null && s.strike_price === oieChain().atm_strike,
                  }))}
                />
              </div>

              {/* OI buildup — re-mounts on each chain update */}
              <div class="oie-chart-card">
                <div class="oie-chart-header">
                  <span class="oie-chart-card-title">open interest buildup</span>
                  <span class="oie-chart-legend">
                    <span class="oie-legend-item"><span class="oie-legend-dot" style="background:#f87171" />ce oi</span>
                    <span class="oie-legend-item"><span class="oie-legend-dot" style="background:#34d399" />pe oi</span>
                  </span>
                </div>
                <OieOIBuildupChart
                  key={oieChain()}
                  strikes={oieChain()?.strikes?.map(s => ({
                    ...s,
                    is_atm: oieChain()?.atm_strike != null && s.strike_price === oieChain().atm_strike,
                  }))}
                />
              </div>
            </Show>
          </div>
        </Show>

      </div>
    </section>
  );
}
