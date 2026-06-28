// OI Profile view — butterfly bar chart: CE OI (right) vs PE OI (left) with an
// OI-change overlay. Owns its Highcharts instance/host/effect; the oiProfile()
// memo is derived in App and read from the store.

import { createEffect, onCleanup, Show } from "solid-js";
import Highcharts from "highcharts";
import { number, compactNumber } from "../lib/format.js";
import { useApp } from "../state/AppContext.jsx";

export function OiProfileView() {
  const {
    section, busy, authed,
    chainData, chainSymbol, chainExchange, chainExpiry, chainStatus, chainLive,
    oiProfile, oiProfileRange, setOiProfileRange, setChainSearchOpen,
    run, loadOptionChain, startChainLive, stopChainLive,
  } = useApp();
  // KSelect is loaded lazily where used in App; re-import here.

  let oiProfileHost;
  let oiProfileChart;

  function buildOiProfileChart(host) {
    const d = oiProfile();
    if (!d.hasData || !host) return null;
    const categories = d.chain.map((r) => number.format(r.strike));
    const ceSeries = d.chain.map((r) => r.ceOi);
    const peSeries = d.chain.map((r) => -r.peOi); // negative for left butterfly
    const ceChgSeries = d.chain.map((r) => r.ceChg);
    const peChgSeries = d.chain.map((r) => -r.peChg);
    const atmIdx = d.atmStrike != null ? d.chain.findIndex((r) => r.strike === d.atmStrike) : -1;
    const plotLines = atmIdx >= 0 ? [{ value: atmIdx, color: "rgba(68,80,94,0.75)", dashStyle: "ShortDash", width: 1, label: { text: "ATM", style: { color: "#D7DEE8", fontSize: "10px" } } }] : [];
    return Highcharts.chart(host, {
      chart: { type: "bar", backgroundColor: "transparent", animation: false, spacing: [8, 16, 8, 8] },
      title: { text: undefined }, credits: { enabled: false },
      legend: { itemStyle: { color: "#D7DEE8", fontSize: "10px" }, itemHoverStyle: { color: "#D7DEE8" } },
      xAxis: [
        { categories, reversed: false, plotLines, labels: { style: { color: "#9CA8B8", fontSize: "10px" }, formatter: function () { return this.value; } } },
        { categories, reversed: false, linkedTo: 0, opposite: true, labels: { style: { color: "#9CA8B8", fontSize: "10px" } } }
      ],
      yAxis: {
        title: { text: undefined },
        labels: { style: { color: "#9CA8B8", fontSize: "10px" }, formatter: function () { return compactNumber.format(Math.abs(this.value)); } },
        gridLineColor: "rgba(68,80,94,0.35)"
      },
      tooltip: {
        shared: true, useHTML: true,
        formatter: function () {
          const rows = this.points.map((pt) => `<span style="color:${pt.color}">●</span> ${pt.series.name}: <b>${compactNumber.format(Math.abs(pt.y))}</b>`).join("<br>");
          return `<b>${this.x}</b><br>${rows}`;
        }
      },
      plotOptions: { series: { animation: false, grouping: false, borderWidth: 0 }, bar: { groupPadding: 0.05, pointPadding: 0.05 } },
      series: [
        { name: "CE OI", data: ceSeries, color: "rgba(16,185,129,0.7)", zIndex: 2 },
        { name: "PE OI", data: peSeries, color: "rgba(239,68,68,0.7)", zIndex: 2 },
        { name: "CE ΔOI", data: ceChgSeries, color: "rgba(16,185,129,0.35)", zIndex: 1 },
        { name: "PE ΔOI", data: peChgSeries, color: "rgba(239,68,68,0.35)", zIndex: 1 },
      ]
    });
  }

  createEffect(() => {
    if (section() !== "oi-profile" || !oiProfileHost) return;
    oiProfile(); // reactivity track
    oiProfileChart?.destroy();
    oiProfileChart = buildOiProfileChart(oiProfileHost);
    onCleanup(() => { oiProfileChart?.destroy(); oiProfileChart = null; });
  });

  const RANGE_OPTIONS = ["10", "20", "30", "40", "full"];
  const rangeLabel = (v) => v === "full" ? "Full" : `ATM ±${v}`;

  return (
    <section class={`view-panel ${section() === "oi-profile" ? "active" : ""}`} aria-hidden={section() !== "oi-profile"}>
      <div class="gamma-workspace">
        <div class="chain-toolbar">
          <div class="chain-toolbar-scroll">
            <button class="chain-search-btn" type="button" onClick={() => setChainSearchOpen(true)}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
              <span class="chain-search-btn-text">{chainData()?.asset || chainSymbol() || "Search"}</span>
              <span class="chain-search-btn-sub">{chainExchange()} · {chainExpiry() || "Auto"} · {chainStatus()}</span>
            </button>
            <div class="chain-toolbar-divider" />
            <label class="tb-field">
              <span class="tb-field-label">strikes</span>
              <select class="tb-field-select" value={oiProfileRange()} onChange={(e) => setOiProfileRange(e.currentTarget.value)}>
                {RANGE_OPTIONS.map((v) => <option value={v}>{rangeLabel(v)}</option>)}
              </select>
            </label>
            <div class="chain-toolbar-divider" />
            <button data-ui="button" data-appearance="accent" onClick={() => run(loadOptionChain)} disabled={busy()}>Load</button>
            <Show when={chainLive()} fallback={<button data-ui="button" data-appearance="outline" onClick={startChainLive} disabled={busy() || !authed()}>Live</button>}>
              <button data-ui="button" data-appearance="outline" onClick={stopChainLive} style="border-color:rgba(239,68,68,0.4);color:var(--bear)">Stop</button>
            </Show>
          </div>
          <div class="chain-toolbar-right">
            <Show when={oiProfile().atmStrike != null}><span data-ui="badge">ATM {number.format(oiProfile().atmStrike)}</span></Show>
            <span data-ui="badge">{oiProfile().hasData ? `${oiProfile().chain.length} strikes` : "no data"}</span>
          </div>
        </div>
        <div class="gamma-content" style="grid-template-columns:1fr">
          <div class="gamma-chart-card">
            <div class="gamma-chart-head">
              <div><strong>OI Profile — Butterfly</strong><span>CE OI (right) vs PE OI (left) · OI change overlay</span></div>
            </div>
            <div class="gamma-chart-shell" style="min-height:420px">
              <div class="gamma-chart" ref={(el) => { oiProfileHost = el; }} style="min-height:420px" />
              <Show when={!oiProfile().hasData}>
                <div class="gamma-empty">Load or start Live on the Option Chain to see the OI butterfly.</div>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
