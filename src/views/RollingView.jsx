// Rolling Straddle view — Bid/Ask (right axis) + IV (left axis) lightweight-chart
// with a metrics sidebar and series/window controls. The chart is created in App
// and bound to the host registered here via the store.

import { For, Show } from "solid-js";
import { rupee } from "../lib/format.js";
import { useApp } from "../state/AppContext.jsx";

export function RollingView() {
  const {
    section,
    rollStats, rollStatus, rollDrawnLines, rollWindowMode, rollSeriesVisibility,
    removeRollLine, rollLineColor, setRollChartWindowMode, toggleRollSeries,
    registerRollChartHost,
    straddleMonitor, setStraddleMonitor, straddleAlerts,
  } = useApp();

  return (
    <section class={`view-panel ${section() === "rolling" ? "active" : ""}`} aria-hidden={section() !== "rolling"}>
      <div class="chart-workspace">
        {/* Metrics sidebar */}
        <aside class="chart-sidebar">
          <div class="sidebar-metric">
            <span class="sidebar-label">Spot</span>
            <strong class="sidebar-value">{rollStats().spot}</strong>
          </div>
          <div class="sidebar-divider" />
          <div class="sidebar-metric">
            <span class="sidebar-label">Strike</span>
            <strong class="sidebar-value">{rollStats().strike}</strong>
          </div>
          <div class="sidebar-divider" />
          <div class="sidebar-metric">
            <span class="sidebar-label">Bid</span>
            <strong class="sidebar-value bid">{rollStats().bid}</strong>
          </div>
          <div class="sidebar-divider" />
          <div class="sidebar-metric">
            <span class="sidebar-label">Ask</span>
            <strong class="sidebar-value ask">{rollStats().ask}</strong>
          </div>
          <div class="sidebar-divider" />
          <div class="sidebar-metric">
            <span class="sidebar-label">IV Mid</span>
            <strong class="sidebar-value iv">{rollStats().iv}</strong>
          </div>
          <div class="mt-auto sidebar-divider" />
          <div class="sidebar-status">
            <span class="sidebar-label">Status</span>
            <span class="sidebar-status-value">{rollStatus()}</span>
          </div>
          <div class="sidebar-divider" />
          <div class="sidebar-metric" style="padding:6px 4px">
            <span class="sidebar-label">Monitor</span>
            <button
              style={`font-size:10px;padding:3px 8px;border-radius:4px;border:1px solid ${straddleMonitor() ? "#22c55e" : "rgba(255,255,255,0.15)"};background:${straddleMonitor() ? "rgba(34,197,94,0.15)" : "transparent"};color:${straddleMonitor() ? "#22c55e" : "var(--tx-3)"};cursor:pointer`}
              onClick={() => {
                setStraddleMonitor(!straddleMonitor());
                if (!straddleMonitor() === false && typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission();
              }}
            >
              {straddleMonitor() ? "ON" : "OFF"}
            </button>
          </div>
          <Show when={straddleAlerts().length}>
            <div class="sidebar-divider" />
            <div style="padding:4px;max-height:120px;overflow-y:auto">
              <span class="sidebar-label">Alerts</span>
              <For each={straddleAlerts().slice(0, 5)}>
                {(a) => (
                  <div style="font-size:9px;color:var(--tx-3);padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
                    <span style="color:#f59e0b;font-weight:700">{a.title}</span>
                    <br />{a.body}
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={rollDrawnLines().length}>
            <div class="sidebar-divider" />
            <div class="line-list">
              <span class="sidebar-label">Lines</span>
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
          </Show>
        </aside>

        {/* Single chart card — Bid/Ask on right axis, IV on left axis */}
        <div class="chart-card">
          <div class="chart-card-header flex-wrap gap-3">
            <div>
              <h2 class="chart-card-title">Rolling Straddle</h2>
              <p class="chart-card-meta">{rollStats().meta}</p>
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-2 text-[10px]">
              <div data-ui="tabs" class="shrink-0" data-activeid={rollWindowMode()} aria-label="Chart time window">
                <button data-ui="tab" id="full" onClick={() => setRollChartWindowMode("full")}>Full</button>
                <button data-ui="tab" id="3h" onClick={() => setRollChartWindowMode("3h")}>3H</button>
                <button data-ui="tab" id="1h" onClick={() => setRollChartWindowMode("1h")}>1H</button>
                <button data-ui="tab" id="30m" onClick={() => setRollChartWindowMode("30m")}>30M</button>
              </div>
              <button data-ui="button"
                data-appearance="stealth"
                type="button"
                class={rollSeriesVisibility().bid ? "" : "opacity-40 line-through"}
                aria-pressed={rollSeriesVisibility().bid}
                title={rollSeriesVisibility().bid ? "Mute Bid series" : "Show Bid series"}
                onClick={() => toggleRollSeries("bid", 1)}
              >
                <span class="inline-block h-2 w-4 rounded-sm" style="background:#21d19f"></span>
                <span style="color:var(--text-muted)">Bid ₹</span>
              </button>
              <button data-ui="button"
                data-appearance="stealth"
                type="button"
                class={rollSeriesVisibility().ask ? "" : "opacity-40 line-through"}
                aria-pressed={rollSeriesVisibility().ask}
                title={rollSeriesVisibility().ask ? "Mute Ask series" : "Show Ask series"}
                onClick={() => toggleRollSeries("ask", 2)}
              >
                <span class="inline-block h-2 w-4 rounded-sm" style="background:#ffb15c"></span>
                <span style="color:var(--text-muted)">Ask ₹</span>
              </button>
              <button data-ui="button"
                data-appearance="stealth"
                type="button"
                class={rollSeriesVisibility().avg ? "" : "opacity-40 line-through"}
                aria-pressed={rollSeriesVisibility().avg}
                title={rollSeriesVisibility().avg ? "Mute Avg series" : "Show Avg straddle price"}
                onClick={() => toggleRollSeries("avg", 4)}
              >
                <span class="inline-block h-px w-4" style="border-top:2px dashed #facc15"></span>
                <span style="color:var(--text-muted)">Avg ₹</span>
              </button>
              <button data-ui="button"
                data-appearance="stealth"
                type="button"
                class={rollSeriesVisibility().iv ? "" : "opacity-40 line-through"}
                aria-pressed={rollSeriesVisibility().iv}
                title={rollSeriesVisibility().iv ? "Mute IV series" : "Show IV series"}
                onClick={() => toggleRollSeries("iv", 3)}
              >
                <span class="inline-block h-px w-4" style="background:#22d3ee;border-top:2px solid #22d3ee"></span>
                <span style="color:var(--text-muted)">IV % (left)</span>
              </button>
            </div>
          </div>
          <div class="chart-card-body" ref={(el) => registerRollChartHost(el)}></div>
        </div>
      </div>
    </section>
  );
}
