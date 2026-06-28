// Vega Analysis view — total Call & Put vega across a DELTA BAND, vs 9:15 open.
//
// Legs are picked by delta: CE legs with delta∈[min,max] and PE legs with
// |delta|∈[min,max] (default 0.05–0.60 = the OTM range). The band rolls as spot
// moves, so the same OTM region is always summed. For each side we plot
// Σ(current vega − each strike's own 9:15 open vega): above 0 = vega building,
// below 0 = vega bleeding. A Time | Call | Put | Diff table sits beside the chart.

import { For, Show, createMemo } from "solid-js";
import { useApp } from "../state/AppContext.jsx";
import { formatIstTime } from "../lib/datetime.js";

export function VegaAnalysisView() {
  const {
    section, busy, authed, run,
    leftSettingsCollapsed, toggleSettingsPanel,
    rollSymbol, rollExpiry, rollExchange, rollExpiries, rollStart, rollEnd,
    setRollExpiry, setRollStart, setRollEnd,
    vgStatus, vgCells, vgLiveOn, vgSpotVisible, vgLegVisibility,
    vgDeltaMin, vgDeltaMax, setVgDeltaMin, setVgDeltaMax,
    toggleVgLeg, toggleVgSpot,
    loadVegaAnalysis, startVgLive, stopVgLive, loadRollingExpiries,
    openSymbolSearch, registerVgChartHost,
  } = useApp();

  const hasData = () => !!vgCells()?.hasData;
  const summary = createMemo(() => vgCells()?.summary || {});

  return (
    <section class={`view-panel ${section() === "vega" ? "active" : ""}`} aria-hidden={section() !== "vega"}>
      <div class={`pd-layout ${leftSettingsCollapsed().vega ? "settings-collapsed" : ""}`}>

        {/* Left settings sidebar */}
        <aside class="pd-sidebar">
          <div class="pd-side-head">
            <span class="pd-side-title">Settings</span>
            <Show when={vgStatus()}><span class="pd-side-status">{vgStatus()}</span></Show>
            <button
              type="button"
              class="settings-collapse-btn"
              aria-label={leftSettingsCollapsed().vega ? "Open settings" : "Close settings"}
              title={leftSettingsCollapsed().vega ? "Open settings" : "Close settings"}
              onClick={() => toggleSettingsPanel("vega")}
            />
          </div>

          <div class="pd-side-block">
            <label class="pd-section-label">Underlying</label>
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

          <div class="pd-side-block">
            <div class="pd-seg" role="tablist" aria-label="Data source">
              <button class={`pd-seg-btn ${!vgLiveOn() ? "active" : ""}`} onClick={() => { stopVgLive(); }}>Historical</button>
              <button class={`pd-seg-btn ${vgLiveOn() ? "active" : ""}`} disabled={!authed()} onClick={() => { if (hasData()) startVgLive(); }}>Live</button>
            </div>
          </div>

          <div class="pd-side-block">
            <label class="pd-section-label">Expiry</label>
            <div class="pd-row">
              <select class="pd-select pd-grow" value={rollExpiry()} onChange={(e) => setRollExpiry(e.currentTarget.value)}>
                <Show when={!rollExpiries().length}><option value="">—</option></Show>
                <For each={rollExpiries()}>{(ex) => <option value={ex}>{ex}</option>}</For>
              </select>
              <button class="pd-btn pd-btn-icon" disabled={busy() || !authed()} onClick={() => run(loadRollingExpiries)} title="Reload expiries">↻</button>
            </div>
          </div>

          <Show when={!vgLiveOn()}>
            <div class="pd-side-block">
              <label class="pd-section-label">Window</label>
              <input class="pd-input" type="datetime-local" value={rollStart()} onInput={(e) => setRollStart(e.currentTarget.value)} />
              <input class="pd-input mt-1" type="datetime-local" value={rollEnd()} onInput={(e) => setRollEnd(e.currentTarget.value)} />
            </div>
          </Show>

          {/* Delta band — the only strike selector */}
          <div class="pd-side-block">
            <label class="pd-section-label">Delta band (OTM)</label>
            <div class="pd-row">
              <label class="pd-field-label pd-grow">min Δ</label>
              <input class="pd-input pd-num" type="number" step="0.05" min="0" max="1" value={vgDeltaMin()} onInput={(e) => setVgDeltaMin(e.currentTarget.value)} />
            </div>
            <div class="pd-row">
              <label class="pd-field-label pd-grow">max Δ</label>
              <input class="pd-input pd-num" type="number" step="0.05" min="0" max="1" value={vgDeltaMax()} onInput={(e) => setVgDeltaMax(e.currentTarget.value)} />
            </div>
            <span class="pd-hint">Rolling CE Δ and PE -Δ within {vgDeltaMin()}-{vgDeltaMax()}</span>
            <Show when={summary().callCnt != null}>
              <span class="pd-hint">{summary().callCnt} CE · {summary().putCnt} PE in band</span>
            </Show>
          </div>

          <div class="pd-side-block pd-actions">
            <button class="pd-btn pd-btn-accent pd-grow" disabled={busy() || !authed()} onClick={() => run(loadVegaAnalysis)}>
              {busy() ? "Loading…" : "Plot"}
            </button>
            <Show
              when={vgLiveOn()}
              fallback={<button class="pd-btn" disabled={busy() || !authed() || !hasData()} onClick={() => startVgLive()}>Live</button>}
            >
              <button class="pd-btn" onClick={() => stopVgLive()}>Stop</button>
            </Show>
          </div>
        </aside>

        {/* Right: chart + legend + table */}
        <div class="pd-main vg-main">
          <div class="pd-main-head">
            <span class="pd-main-title">Vega Analysis</span>
            <span class="pd-main-sub">Rolling delta-band Vega (Δ {vgDeltaMin()}-{vgDeltaMax()}) vs entry baseline · above 0 = building · below 0 = bleeding</span>
          </div>

          <div class="pd-legend">
            <button type="button" class={`pd-legend-side ${vgLegVisibility().call === false ? "muted" : ""}`} onClick={() => toggleVgLeg("call")}>
              <span class="pd-legend-line" style="border-top-color:#10B981" /> Call Vega
              <span class="pd-legend-vals"><b>{fmtVega(summary().call)}</b></span>
            </button>
            <button type="button" class={`pd-legend-side ${vgLegVisibility().put === false ? "muted" : ""}`} onClick={() => toggleVgLeg("put")}>
              <span class="pd-legend-line" style="border-top-color:#EF4444" /> Put Vega
              <span class="pd-legend-vals"><b>{fmtVega(summary().put)}</b></span>
            </button>
            <button type="button" class={`pd-legend-side ${vgLegVisibility().diff === true ? "" : "muted"}`} onClick={() => toggleVgLeg("diff")}>
              <span class="pd-legend-line dashed" style="border-top-color:#9aa1aa" /> Put−Call Diff
              <span class="pd-legend-vals"><b>{fmtVega(summary().diff)}</b></span>
            </button>
            <span class="pd-legend-sep" />
            <button type="button" class={`pd-legend-side ${vgSpotVisible() ? "" : "muted"}`} onClick={() => toggleVgSpot()}>
              <span class="pd-legend-line spot" /> Spot
            </button>
          </div>

          <div class="vg-body">
            <div class="pd-chart-card vg-chart-card">
              <div class="pd-chart-shell">
                <div class="pd-chart" ref={(el) => registerVgChartHost(el)} />
                <Show when={!hasData()}>
                  <div class="pd-chart-empty">Pick a symbol &amp; delta band, then press <b>Plot</b> to see total Call/Put vega change vs each strike's entry baseline.</div>
                </Show>
              </div>
            </div>

            <div class="vg-table-wrap">
              <table class="vg-table">
                <thead>
                  <tr><th>Time</th><th class="ce-col">Call ΔVega</th><th class="pe-col">Put ΔVega</th><th class="diff-col">Diff</th></tr>
                </thead>
                <tbody>
                  <For each={vgCells().rows || []} fallback={<tr><td colspan="4" class="vg-table-empty">No data — press Plot</td></tr>}>
                    {(r) => (
                      <tr>
                        <td>{tLabel(r.t)}</td>
                        <td class="ce-col">{fmtRaw(r.call)}</td>
                        <td class="pe-col">{fmtRaw(r.put)}</td>
                        <td class={`diff-col ${r.diff >= 0 ? "up" : "down"}`}>{fmtRaw(r.diff)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function fmtVega(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}`;
}
function fmtRaw(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(2);
}
function tLabel(t) {
  if (!Number.isFinite(t)) return "—";
  return formatIstTime(t).slice(0, 5);
}
