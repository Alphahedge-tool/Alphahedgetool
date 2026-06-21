// Gamma Density view — intraday and to-expiry Γ×OI hedging-pressure charts.
// The Highcharts builders/effects stay in App and drive the hosts registered
// here via the store.

import { Show } from "solid-js";
import * as KSelect from "@kobalte/core/select";
import { number, formatPlain } from "../lib/format.js";
import { useApp } from "../state/AppContext.jsx";

export function GammaView() {
  const {
    section, busy, authed,
    chainData, chainSymbol, chainExchange, chainStatus, chainExpiry, chainExpiries,
    gammaRange, chainDerivedStats, gammaDensity, chainSearchRows,
    setChainSearchOpen, setGammaRange, setScriptStatus,
    selectChainExpiry, loadChainSearchRows,
    registerGammaIntradayHost, registerGammaExpiryHost,
    run, loadOptionChain,
  } = useApp();

  return (
    <section class={`view-panel ${section() === "gamma" ? "active" : ""}`} aria-hidden={section() !== "gamma"}>
      <div class="gamma-workspace">

        {/* Underlying search auto-loads the nearest expiry; expiry remains user-selectable. */}
        <div class="chain-toolbar">
          <div class="chain-toolbar-scroll">
            <button class="chain-search-btn" type="button" onClick={() => {
              setChainSearchOpen(true);
              if (authed() && !chainSearchRows().length) {
                loadChainSearchRows().catch((error) => setScriptStatus(error.message || "Search scripts unavailable"));
              }
            }} disabled={busy()}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
              <span class="chain-search-btn-text">{chainData()?.asset || chainSymbol() || "Search underlying"}</span>
              <span class="chain-search-btn-sub">{chainExchange()} · {chainStatus()}</span>
            </button>

            <KSelect.Root
              class="tb-field"
              value={chainExpiry() || ""}
              onChange={(expiry) => {
                if (expiry == null || String(expiry) === String(chainExpiry() || "")) return;
                selectChainExpiry(expiry);
                run(loadOptionChain);
              }}
              options={chainExpiries()}
              disabled={busy() || !chainExpiries().length}
              itemComponent={(props) => (
                <KSelect.Item item={props.item} class="kb-select-item">
                  <KSelect.ItemLabel>{props.item.rawValue}</KSelect.ItemLabel>
                </KSelect.Item>
              )}
            >
              <KSelect.Label class="tb-field-label">expiry</KSelect.Label>
              <KSelect.Trigger class="kb-select-trigger tb-field-select" aria-label="Gamma expiry">
                <KSelect.Value fallback="Auto">
                  {(state) => state.selectedOption() || "Auto"}
                </KSelect.Value>
                <KSelect.Icon class="kb-select-icon">▾</KSelect.Icon>
              </KSelect.Trigger>
              <KSelect.Portal>
                <KSelect.Content class="kb-select-content">
                  <KSelect.Listbox class="kb-select-listbox" />
                </KSelect.Content>
              </KSelect.Portal>
            </KSelect.Root>

            <KSelect.Root
              class="tb-field"
              value={gammaRange()}
              onChange={(range) => { if (range != null) setGammaRange(range); }}
              options={["10", "20", "30", "40", "full"]}
              itemComponent={(props) => (
                <KSelect.Item item={props.item} class="kb-select-item">
                  <KSelect.ItemLabel>{props.item.rawValue === "full" ? "Full" : `ATM ±${props.item.rawValue}`}</KSelect.ItemLabel>
                </KSelect.Item>
              )}
            >
              <KSelect.Label class="tb-field-label">strikes</KSelect.Label>
              <KSelect.Trigger class="kb-select-trigger tb-field-select" aria-label="Gamma strike range">
                <KSelect.Value>
                  {(state) => state.selectedOption() === "full" ? "Full" : `ATM ±${state.selectedOption()}`}
                </KSelect.Value>
                <KSelect.Icon class="kb-select-icon">▾</KSelect.Icon>
              </KSelect.Trigger>
              <KSelect.Portal>
                <KSelect.Content class="kb-select-content">
                  <KSelect.Listbox class="kb-select-listbox" />
                </KSelect.Content>
              </KSelect.Portal>
            </KSelect.Root>
          </div>
          <div class="chain-toolbar-right">
            <Show when={chainDerivedStats().pcr != null}>
              <span data-ui="badge" style={chainDerivedStats().pcr >= 1 ? "color:var(--bull)" : "color:var(--bear)"}>
                PCR {formatPlain(chainDerivedStats().pcr, 2)}
              </span>
            </Show>
            <span data-ui="badge">{gammaDensity().hasData ? `${gammaDensity().chain.length} strikes` : "no data"}</span>
          </div>
        </div>

        <div class="gamma-metrics">
          <div><span>Spot</span><strong>{gammaDensity().spot == null ? "--" : number.format(gammaDensity().spot)}</strong></div>
          <div><span>ATM IV</span><strong class="iv">{gammaDensity().atmIv == null ? "--" : `${formatPlain(gammaDensity().atmIv, 2)}%`}</strong></div>
          <div>
            <span>σ Move (1d)</span>
            <strong>{gammaDensity().intradayBand ? `±${number.format(gammaDensity().intradayBand.sigma_move)}` : "--"}</strong>
            <span class="gamma-metric-sub">{gammaDensity().dteDays == null ? "" : `${formatPlain(gammaDensity().dteDays, 0)}d to expiry`}</span>
          </div>
          <div><span>1σ Low</span><strong class="down">{gammaDensity().intradayBand ? number.format(gammaDensity().intradayBand.one_sigma_low) : "--"}</strong></div>
          <div><span>1σ High</span><strong class="up">{gammaDensity().intradayBand ? number.format(gammaDensity().intradayBand.one_sigma_high) : "--"}</strong></div>
          <div><span>2σ Low</span><strong class="down">{gammaDensity().intradayBand ? number.format(gammaDensity().intradayBand.two_sigma_low) : "--"}</strong></div>
          <div><span>2σ High</span><strong class="up">{gammaDensity().intradayBand ? number.format(gammaDensity().intradayBand.two_sigma_high) : "--"}</strong></div>
          <div><span>Gamma Peak</span><strong>{gammaDensity().peakExpiryStrike == null ? "--" : number.format(gammaDensity().peakExpiryStrike)}</strong></div>
        </div>

        <div class="gamma-content">
          <div class="gamma-chart-card">
            <div class="gamma-chart-head">
              <div><strong>Intraday</strong><span>1-day hedging pressure · sharper ATM wall</span></div>
              <Show when={gammaDensity().peakIntradayStrike != null}>
                <span class="gamma-peak-chip">Peak {number.format(gammaDensity().peakIntradayStrike)}</span>
              </Show>
            </div>
            <div class="gamma-chart-shell">
              <div class="gamma-chart" ref={(el) => registerGammaIntradayHost(el)} />
              <Show when={!gammaDensity().hasData}>
                <div class="gamma-empty">Open an option chain with live Greeks to plot Γ×OI density.</div>
              </Show>
            </div>
          </div>

          <div class="gamma-chart-card">
            <div class="gamma-chart-head">
              <div><strong>To Expiry</strong><span>Terminal pin / gravity zone</span></div>
              <Show when={gammaDensity().peakExpiryStrike != null}>
                <span class="gamma-peak-chip">Peak {number.format(gammaDensity().peakExpiryStrike)}</span>
              </Show>
            </div>
            <div class="gamma-chart-shell">
              <div class="gamma-chart" ref={(el) => registerGammaExpiryHost(el)} />
              <Show when={!gammaDensity().hasData}>
                <div class="gamma-empty">Open an option chain with live Greeks to plot Γ×OI density.</div>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
