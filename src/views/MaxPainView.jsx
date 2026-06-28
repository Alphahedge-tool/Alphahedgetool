// Max Pain view — stacked call-pain + put-pain columns per strike; the minimum
// total marks max pain. Owns its Highcharts instance/host/effect; the maxPain()
// memo is derived in App and read from the store.

import { createEffect, onCleanup, Show } from "solid-js";
import Highcharts from "highcharts";
import { number, compactNumber } from "../lib/format.js";
import { useApp } from "../state/AppContext.jsx";

export function MaxPainView() {
  const {
    section, busy, authed,
    chainData, chainSymbol, chainExchange, chainExpiry, chainStatus, chainLive,
    maxPain, setChainSearchOpen,
    run, loadOptionChain, startChainLive, stopChainLive,
  } = useApp();

  let maxPainHost;
  let maxPainChart;

  function buildMaxPainChart(host) {
    const d = maxPain();
    if (!d.hasData || !host) return null;
    const categories = d.pain.map((p) => number.format(p.strike));
    const mpIdx = d.pain.findIndex((p) => p.strike === d.maxPainStrike);
    const spotIdx = d.spot != null ? d.pain.reduce((best, p, i) => Math.abs(p.strike - d.spot) < Math.abs(d.pain[best].strike - d.spot) ? i : best, 0) : -1;
    const plotLines = [];
    if (mpIdx >= 0) plotLines.push({ value: mpIdx, color: "rgba(139,92,246,0.8)", dashStyle: "ShortDash", width: 2, label: { text: `Max Pain ${number.format(d.maxPainStrike)}`, style: { color: "#8B5CF6", fontSize: "10px" }, align: "right" } });
    if (spotIdx >= 0) plotLines.push({ value: spotIdx, color: "rgba(68,80,94,0.90)", dashStyle: "Dot", width: 1, label: { text: "Spot", style: { color: "#D7DEE8", fontSize: "10px" } } });
    return Highcharts.chart(host, {
      chart: { type: "column", backgroundColor: "transparent", animation: false, spacing: [12, 16, 8, 8] },
      title: { text: undefined }, credits: { enabled: false },
      legend: { itemStyle: { color: "#D7DEE8", fontSize: "10px" }, itemHoverStyle: { color: "#D7DEE8" } },
      xAxis: { categories, plotLines, labels: { style: { color: "#9CA8B8", fontSize: "10px" }, rotation: -45 } },
      yAxis: { title: { text: undefined }, labels: { style: { color: "#9CA8B8", fontSize: "10px" }, formatter: function () { return compactNumber.format(this.value); } }, gridLineColor: "rgba(68,80,94,0.35)" },
      tooltip: { shared: true, useHTML: true, formatter: function () { const rows = this.points.map((pt) => `<span style="color:${pt.color}">●</span> ${pt.series.name}: <b>${compactNumber.format(pt.y)}</b>`).join("<br>"); return `<b>${this.x}</b><br>${rows}`; } },
      plotOptions: { series: { animation: false, borderWidth: 0 }, column: { stacking: "normal", groupPadding: 0, pointPadding: 0.01 } },
      series: [
        { name: "Call Pain", data: d.pain.map((p) => p.callPain), color: "rgba(16,185,129,0.65)", stack: "pain" },
        { name: "Put Pain", data: d.pain.map((p) => p.putPain), color: "rgba(239,68,68,0.65)", stack: "pain" },
      ]
    });
  }

  createEffect(() => {
    if (section() !== "max-pain" || !maxPainHost) return;
    maxPain(); // reactivity track
    maxPainChart?.destroy();
    maxPainChart = buildMaxPainChart(maxPainHost);
    onCleanup(() => { maxPainChart?.destroy(); maxPainChart = null; });
  });

  return (
    <section class={`view-panel ${section() === "max-pain" ? "active" : ""}`} aria-hidden={section() !== "max-pain"}>
      <div class="gamma-workspace">
        <div class="chain-toolbar">
          <div class="chain-toolbar-scroll">
            <button class="chain-search-btn" type="button" onClick={() => setChainSearchOpen(true)}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
              <span class="chain-search-btn-text">{chainData()?.asset || chainSymbol() || "Search"}</span>
              <span class="chain-search-btn-sub">{chainExchange()} · {chainExpiry() || "Auto"} · {chainStatus()}</span>
            </button>
            <div class="chain-toolbar-divider" />
            <button data-ui="button" data-appearance="accent" onClick={() => run(loadOptionChain)} disabled={busy()}>Load</button>
            <Show when={chainLive()} fallback={<button data-ui="button" data-appearance="outline" onClick={startChainLive} disabled={busy() || !authed()}>Live</button>}>
              <button data-ui="button" data-appearance="outline" onClick={stopChainLive} style="border-color:rgba(239,68,68,0.4);color:var(--bear)">Stop</button>
            </Show>
          </div>
          <div class="chain-toolbar-right">
            <Show when={maxPain().maxPainStrike != null}>
              <span data-ui="badge" style="color:var(--warn)">Max Pain {number.format(maxPain().maxPainStrike)}</span>
            </Show>
            <Show when={maxPain().spot != null && maxPain().maxPainStrike != null}>
              <span data-ui="badge">Δ {number.format(Math.abs(maxPain().spot - maxPain().maxPainStrike))}</span>
            </Show>
          </div>
        </div>
        <div class="gamma-metrics" style="grid-template-columns:repeat(4,minmax(0,1fr))">
          <div><span>Max Pain Strike</span><strong style="color:var(--warn)">{maxPain().maxPainStrike != null ? number.format(maxPain().maxPainStrike) : "--"}</strong></div>
          <div><span>Spot</span><strong>{maxPain().spot != null ? number.format(maxPain().spot) : "--"}</strong></div>
          <div><span>Distance</span><strong>{maxPain().spot != null && maxPain().maxPainStrike != null ? number.format(Math.abs(maxPain().spot - maxPain().maxPainStrike)) : "--"}</strong></div>
          <div><span>Strikes</span><strong>{maxPain().strikes.length || "--"}</strong></div>
        </div>
        <div class="gamma-content" style="grid-template-columns:1fr">
          <div class="gamma-chart-card">
            <div class="gamma-chart-head">
              <div><strong>Max Pain Distribution</strong><span>Call pain + Put pain per expiry strike · Min total = Max Pain</span></div>
              <Show when={maxPain().maxPainStrike != null}>
                <span class="gamma-peak-chip" style="background:rgba(139,92,246,0.12);border-color:rgba(139,92,246,0.3);color:var(--warn)">
                  Pain @ {number.format(maxPain().maxPainStrike)}
                </span>
              </Show>
            </div>
            <div class="gamma-chart-shell">
              <div class="gamma-chart" ref={(el) => { maxPainHost = el; }} />
              <Show when={!maxPain().hasData}>
                <div class="gamma-empty">Load or start Live on the Option Chain to compute max pain.</div>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
