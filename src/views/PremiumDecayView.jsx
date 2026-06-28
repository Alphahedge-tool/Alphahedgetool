// Premium Decay view — per-leg decay vs 9:15 open with a left settings sidebar.
//
// Left sidebar: symbol, Live/Historical, Expiry, and three strike-pick modes —
// ATM ± range, Fixed Strike ± range, and Custom Strikes (hand-picked from the
// CALL / STRIKE / PUT chain table). Each plotted line is ONE option leg
// ({strike, side}): its LTP as % of its own 9:15 open. CE legs draw solid/green,
// PE legs dashed/red, so you can compare whether the call or put side at each
// strike is bleeding faster. Spot overlays on a right axis. The uPlot instance
// lives in App and binds to the host registered here.

import { For, Show, createMemo } from "solid-js";
import { useApp } from "../state/AppContext.jsx";
import { number } from "../lib/format.js";

const STATE = {
  0: { txt: "decaying", cls: "ok", mark: "✓" },
  1: { txt: "stalled", cls: "warn", mark: "⚠" },
  2: { txt: "rising", cls: "bad", mark: "⚠⚠" },
};

export function PremiumDecayView() {
  const {
    section, busy, authed, run,
    leftSettingsCollapsed, toggleSettingsPanel,
    rollSymbol, rollExpiry, rollExchange, rollExpiries, rollStart, rollEnd,
    setRollExpiry, setRollStart, setRollEnd,
    pdStatus, pdCells, pdLiveOn, pdSpotVisible, pdLegVisibility,
    pdPickMode, pdAtmRange, pdFixedCenter, pdFixedRange, pdCustomLegs,
    pdChainRows, pdLegendLegs,
    setPdPickMode, setPdAtmRange, setPdFixedCenter, setPdFixedRange,
    pdToggleCustomLeg, pdRemoveCustomLeg, pdClearCustomLegs, pdSelectAllCustom,
    togglePdLeg, togglePdSpot,
    loadPdChainRows, loadPremiumDecay, startPdLive, stopPdLive, loadRollingExpiries,
    openSymbolSearch, registerPdChartHost,
  } = useApp();

  const chain = createMemo(() => pdChainRows() || { strikes: [], step: 0, atm: null });
  const hasData = () => !!pdCells()?.hasData;

  // Strike rows for the table: ATM-centered window so the table opens usefully.
  const tableStrikes = createMemo(() => {
    const { strikes, step, atm } = chain();
    if (!strikes.length) return [];
    if (atm == null || !step) return strikes;
    const atmIdx = strikes.indexOf(atm);
    if (atmIdx < 0) return strikes;
    const span = 16; // ±16 strikes around ATM
    return strikes.slice(Math.max(0, atmIdx - span), atmIdx + span + 1);
  });

  const customHas = (strike, side) =>
    pdCustomLegs().some((l) => l.strike === strike && l.side === side);

  return (
    <section class={`view-panel ${section() === "premiumdecay" ? "active" : ""}`} aria-hidden={section() !== "premiumdecay"}>
      <div class={`pd-layout ${leftSettingsCollapsed().premiumdecay ? "settings-collapsed" : ""}`}>

        {/* ── Left settings sidebar ── */}
        <aside class="pd-sidebar">
          <div class="pd-side-head pd-side-head-empty">
            <span class="pd-side-title">Settings</span>
            <Show when={pdStatus()}><span class="pd-side-status">{pdStatus()}</span></Show>
            <button
              type="button"
              class="settings-collapse-btn"
              aria-label={leftSettingsCollapsed().premiumdecay ? "Open settings" : "Close settings"}
              title={leftSettingsCollapsed().premiumdecay ? "Open settings" : "Close settings"}
              onClick={() => toggleSettingsPanel("premiumdecay")}
            />
          </div>

          {/* Underlying — opens the global symbol-search picker */}
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

          {/* Live / Historical */}
          <div class="pd-side-block">
            <div class="pd-seg" role="tablist" aria-label="Data source">
              <button class={`pd-seg-btn ${!pdLiveOn() ? "active" : ""}`} onClick={() => { stopPdLive(); }}>Historical</button>
              <button class={`pd-seg-btn ${pdLiveOn() ? "active" : ""}`} disabled={!authed()} onClick={() => { if (hasData()) startPdLive(); }}>Live</button>
            </div>
          </div>

          {/* Expiry */}
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

          {/* Time window (historical) */}
          <Show when={!pdLiveOn()}>
            <div class="pd-side-block">
              <label class="pd-section-label">Window</label>
              <input class="pd-input" type="datetime-local" value={rollStart()} onInput={(e) => setRollStart(e.currentTarget.value)} />
              <input class="pd-input mt-1" type="datetime-local" value={rollEnd()} onInput={(e) => setRollEnd(e.currentTarget.value)} />
            </div>
          </Show>

          {/* Plot / Live actions */}
          <div class="pd-side-block pd-actions">
            <button class="pd-btn pd-btn-accent pd-grow" disabled={busy() || !authed()} onClick={() => run(loadPremiumDecay)}>
              {busy() ? "Loading..." : "Plot"}
            </button>
            <Show
              when={pdLiveOn()}
              fallback={<button class="pd-btn" disabled={busy() || !authed() || !hasData()} onClick={() => startPdLive()}>Live</button>}
            >
              <button class="pd-btn" onClick={() => stopPdLive()}>Stop</button>
            </Show>
          </div>

          {/* Pick mode tabs */}
          <div class="pd-side-block">
            <label class="pd-section-label">Strikes to plot</label>
            <div class="pd-mode-tabs">
              <button class={`pd-mode-tab ${pdPickMode() === "atm" ? "active" : ""}`} onClick={() => setPdPickMode("atm")}>ATM ± range</button>
              <button class={`pd-mode-tab ${pdPickMode() === "fixed" ? "active" : ""}`} onClick={() => setPdPickMode("fixed")}>Fixed ± range</button>
              <button class={`pd-mode-tab ${pdPickMode() === "custom" ? "active" : ""}`} onClick={() => setPdPickMode("custom")}>Custom</button>
            </div>

            {/* ATM ± range */}
            <Show when={pdPickMode() === "atm"}>
              <div class="pd-mode-body">
                <span class="pd-hint">Rolls with ATM ({chain().atm ?? "—"})</span>
                <div class="pd-row">
                  <label class="pd-field-label pd-grow">± strikes</label>
                  <input class="pd-input pd-num" type="number" min="0" max="20" value={pdAtmRange()} onInput={(e) => setPdAtmRange(Number(e.currentTarget.value) || 0)} />
                </div>
                <span class="pd-hint">{(pdAtmRange() * 2 + 1)} strikes · {(pdAtmRange() * 2 + 1) * 2} legs</span>
              </div>
            </Show>

            {/* Fixed strike ± range */}
            <Show when={pdPickMode() === "fixed"}>
              <div class="pd-mode-body">
                <div class="pd-row">
                  <label class="pd-field-label pd-grow">center</label>
                  <input class="pd-input pd-num pd-num-wide" type="number" value={pdFixedCenter()} placeholder={String(chain().atm ?? "")} onInput={(e) => setPdFixedCenter(e.currentTarget.value)} />
                </div>
                <div class="pd-row">
                  <label class="pd-field-label pd-grow">± strikes</label>
                  <input class="pd-input pd-num" type="number" min="0" max="20" value={pdFixedRange()} onInput={(e) => setPdFixedRange(Number(e.currentTarget.value) || 0)} />
                </div>
                <span class="pd-hint">Fixed strikes — won't roll with spot</span>
              </div>
            </Show>

            {/* Custom strikes */}
            <Show when={pdPickMode() === "custom"}>
              <div class="pd-mode-body">
                <div class="pd-custom-head">
                  <span class="pd-hint">{pdCustomLegs().length} legs selected</span>
                  <Show when={pdCustomLegs().length}>
                    <button class="pd-link" onClick={() => pdClearCustomLegs()}>Clear</button>
                  </Show>
                </div>
                <div class="pd-bulk-row">
                  <button class="pd-bulk-btn" disabled={!chain().strikes.length} onClick={() => pdSelectAllCustom("both")} title="Add every strike (CE + PE)">All</button>
                  <button class="pd-bulk-btn ce" disabled={!chain().strikes.length} onClick={() => pdSelectAllCustom("CE")} title="Add all calls">All CE</button>
                  <button class="pd-bulk-btn pe" disabled={!chain().strikes.length} onClick={() => pdSelectAllCustom("PE")} title="Add all puts">All PE</button>
                  <Show when={!chain().strikes.length}><span class="pd-hint">load strikes first</span></Show>
                </div>
                <div class="pd-chips">
                  <For each={pdCustomLegs()} fallback={<span class="pd-hint">Add legs from the table below.</span>}>
                    {(leg) => (
                      <span class={`pd-chip ${leg.side === "CE" ? "ce" : "pe"}`}>
                        {leg.strike} {leg.side}
                        <button class="pd-chip-x" onClick={() => pdRemoveCustomLeg(leg.strike, leg.side)}>✕</button>
                      </span>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </div>

          {/* Plot / Live actions */}
          <div class="pd-side-block pd-actions">
            <button class="pd-btn pd-btn-accent pd-grow" disabled={busy() || !authed()} onClick={() => run(loadPremiumDecay)}>
              {busy() ? "Loading…" : "Plot"}
            </button>
            <Show
              when={pdLiveOn()}
              fallback={<button class="pd-btn" disabled={busy() || !authed() || !hasData()} onClick={() => startPdLive()}>Live</button>}
            >
              <button class="pd-btn" onClick={() => stopPdLive()}>Stop</button>
            </Show>
          </div>

          {/* CALL / STRIKE / PUT table (for custom picking) */}
          <div class="pd-side-block pd-table-block">
            <div class="pd-row pd-table-tools">
              <button class="pd-btn pd-grow" disabled={busy() || !authed()} onClick={() => run(loadPdChainRows)}>Load strikes</button>
            </div>
            <Show when={tableStrikes().length} fallback={<div class="pd-table-empty">Load strikes to build the chain table.</div>}>
              <div class="pd-table-wrap">
                <table class="pd-table">
                  <thead>
                    <tr><th class="ce-col">CALL</th><th>STRIKE</th><th class="pe-col">PUT</th></tr>
                  </thead>
                  <tbody>
                    <For each={tableStrikes()}>
                      {(strike) => (
                        <tr class={strike === chain().atm ? "atm-row" : ""}>
                          <td class="ce-col">
                            <button class={`pd-add ce ${customHas(strike, "CE") ? "on" : ""}`} onClick={() => pdToggleCustomLeg(strike, "CE")}>
                              {customHas(strike, "CE") ? "✓ CE" : "Add CE"}
                            </button>
                          </td>
                          <td class="strike-col">{number.format(strike)}</td>
                          <td class="pe-col">
                            <button class={`pd-add pe ${customHas(strike, "PE") ? "on" : ""}`} onClick={() => pdToggleCustomLeg(strike, "PE")}>
                              {customHas(strike, "PE") ? "✓ PE" : "Add PE"}
                            </button>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </Show>
          </div>
        </aside>

        {/* ── Right: chart + legend ── */}
        <div class="pd-main">
          <div class="pd-main-head">
            <span class="pd-main-title">Premium Decay</span>
            <span class="pd-main-sub">Each leg's LTP as % of its 9:15 open · CE solid · PE dashed · ✓ decaying · ⚠ stalled · ⚠⚠ rising</span>
          </div>

          {/* Legend: one chip per plotted leg with live %, IV, decay flag */}
          <div class="pd-legend">
            <For each={pdLegendLegs()}>
              {(leg) => {
                const st = createMemo(() => STATE[leg.state] ?? null);
                return (
                  <button
                    type="button"
                    class={`pd-legend-side ${pdLegVisibility()[leg.key] === false ? "muted" : ""}`}
                    onClick={() => togglePdLeg(leg.key)}
                    title={`Toggle ${leg.strike} ${leg.side}`}
                  >
                    <span class={`pd-legend-line ${leg.side === "PE" ? "dashed" : ""}`} style={`border-top-color:${leg.color}`} />
                    {leg.strike} {leg.side}
                    <span class="pd-legend-vals">
                      <b>{fmtPct(leg.pct)}</b>
                      <Show when={leg.iv != null}><span class="pd-iv">IV {leg.iv.toFixed(1)}</span></Show>
                      <Show when={st()}><span class={`pd-flag ${st().cls}`}>{st().mark}</span></Show>
                    </span>
                  </button>
                );
              }}
            </For>
            <Show when={pdLegendLegs().length}>
              <span class="pd-legend-sep" />
              <button type="button" class={`pd-legend-side ${pdSpotVisible() ? "" : "muted"}`} onClick={() => togglePdSpot()}>
                <span class="pd-legend-line spot" /> Spot
              </button>
            </Show>
          </div>

          <div class="pd-chart-card">
            <div class="pd-chart-shell">
              <div class="pd-chart" ref={(el) => registerPdChartHost(el)} />
              <Show when={!hasData()}>
                <div class="pd-chart-empty">Select strikes on the left and press <b>Plot</b> to see per-leg decay.</div>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}
