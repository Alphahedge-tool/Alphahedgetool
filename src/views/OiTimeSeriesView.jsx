// OI Time Series view — multi-strike total-OI line chart with zoom/pan/tooltip.
// Self-contained: owns its uPlot instance, host ref, x-range and effects.
// Shared data + actions come from the App store via useApp().

import { createEffect, onCleanup, For, Show } from "solid-js";
import * as KSelect from "@kobalte/core/select";
import uPlot from "uplot";
import { number, compactNumber } from "../lib/format.js";
import { formatIstTime, dateKey } from "../lib/datetime.js";
import { useApp } from "../state/AppContext.jsx";

const OI_TS_COLORS = ["#22c55e", "#ef4444", "#3b82f6", "#f59e0b", "#a78bfa", "#06b6d4", "#f97316", "#ec4899", "#84cc16", "#14b8a6"];
const oiTsColor = (index, count) => count <= OI_TS_COLORS.length
  ? OI_TS_COLORS[index % OI_TS_COLORS.length]
  : `hsl(${Math.round((index * 360) / count)}, 72%, 58%)`;

const clampOiTsRange = (min, max, dataMin, dataMax) => {
  const dataSpan = dataMax - dataMin;
  const span = Math.min(Math.max(60, max - min), dataSpan);
  if (!Number.isFinite(span) || span >= dataSpan) return { min: dataMin, max: dataMax };
  let nextMin = min;
  let nextMax = min + span;
  if (nextMin < dataMin) { nextMin = dataMin; nextMax = dataMin + span; }
  if (nextMax > dataMax) { nextMax = dataMax; nextMin = dataMax - span; }
  return { min: nextMin, max: nextMax };
};

export function OiTimeSeriesView() {
  const app = useApp();
  const {
    section, busy, authed,
    chainData, chainSymbol, chainExchange, chainExpiry, chainStatus, chainLive,
    oiTsStrikes, oiTsHistory, oiTsStartDate, oiTsEndDate, oiTsRange,
    setOiTsRange, setOiTsHistory, setOiTsStartDate, setOiTsEndDate, setChainSearchOpen,
    run, loadOiTsSeries, startChainLive, stopChainLive,
  } = app;

  // local chart state (was App closure scope)
  let oiTsHost;
  let oiTsChart;
  let oiTsXRange = null;

  const oiTsSelectedWindow = () => {
    const start = new Date(`${oiTsStartDate()}T03:45:00.000Z`).getTime();
    const requestedEnd = new Date(`${oiTsEndDate()}T10:00:00.000Z`).getTime();
    const end = oiTsEndDate() === dateKey(new Date()) ? Math.min(requestedEnd, Date.now()) : requestedEnd;
    return { start, end };
  };

  const latestOiForStrike = (strike) => {
    const { start, end } = oiTsSelectedWindow();
    const points = (oiTsHistory()[strike] || []).filter((point) => point.t >= start && point.t <= end);
    const point = points[points.length - 1];
    if (!point) return null;
    const ceOi = Number(point.ceOi);
    const peOi = Number(point.peOi);
    return (Number.isFinite(ceOi) ? ceOi : 0) + (Number.isFinite(peOi) ? peOi : 0);
  };

  function resetOiTsZoom() {
    oiTsXRange = null;
    const xs = oiTsChart?.data?.[0] || [];
    if (xs.length > 1) oiTsChart.setScale("x", { min: xs[0], max: xs[xs.length - 1] });
  }

  function createOiTsInteractionPlugin(xValues) {
    let removeListeners = () => {};
    return {
      hooks: {
        ready: [(u) => {
          const over = u.over;
          const dataMin = xValues[0];
          const dataMax = xValues[xValues.length - 1];
          if (!over || !Number.isFinite(dataMin) || !Number.isFinite(dataMax) || dataMax <= dataMin) return;

          if (oiTsXRange) {
            oiTsXRange = clampOiTsRange(oiTsXRange.min, oiTsXRange.max, dataMin, dataMax);
            u.setScale("x", oiTsXRange);
          }

          let dragStart = null;
          const wheel = (event) => {
            event.preventDefault();
            const rect = over.getBoundingClientRect();
            const scale = u.scales.x;
            if (!Number.isFinite(scale.min) || !Number.isFinite(scale.max)) return;
            const span = scale.max - scale.min;

            if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
              const delta = event.shiftKey ? event.deltaY : event.deltaX;
              const shift = (delta / Math.max(1, rect.width)) * span;
              oiTsXRange = clampOiTsRange(scale.min + shift, scale.max + shift, dataMin, dataMax);
            } else {
              const pct = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
              const anchor = scale.min + span * pct;
              const nextSpan = span * (event.deltaY < 0 ? 0.8 : 1.25);
              oiTsXRange = clampOiTsRange(anchor - nextSpan * pct, anchor + nextSpan * (1 - pct), dataMin, dataMax);
            }
            u.setScale("x", oiTsXRange);
          };
          const pointerDown = (event) => {
            if (event.button !== 0) return;
            dragStart = { x: event.clientX, min: u.scales.x.min, max: u.scales.x.max };
            over.classList.add("is-panning");
            over.setPointerCapture?.(event.pointerId);
          };
          const pointerMove = (event) => {
            if (!dragStart) return;
            event.preventDefault();
            const width = Math.max(1, over.getBoundingClientRect().width);
            const span = dragStart.max - dragStart.min;
            const shift = -((event.clientX - dragStart.x) / width) * span;
            oiTsXRange = clampOiTsRange(dragStart.min + shift, dragStart.max + shift, dataMin, dataMax);
            u.setScale("x", oiTsXRange);
          };
          const pointerUp = (event) => {
            dragStart = null;
            over.classList.remove("is-panning");
            over.releasePointerCapture?.(event.pointerId);
          };
          const doubleClick = () => {
            oiTsXRange = null;
            u.setScale("x", { min: dataMin, max: dataMax });
          };

          over.addEventListener("wheel", wheel, { passive: false });
          over.addEventListener("pointerdown", pointerDown);
          over.addEventListener("pointermove", pointerMove);
          over.addEventListener("pointerup", pointerUp);
          over.addEventListener("pointercancel", pointerUp);
          over.addEventListener("dblclick", doubleClick);
          removeListeners = () => {
            over.removeEventListener("wheel", wheel);
            over.removeEventListener("pointerdown", pointerDown);
            over.removeEventListener("pointermove", pointerMove);
            over.removeEventListener("pointerup", pointerUp);
            over.removeEventListener("pointercancel", pointerUp);
            over.removeEventListener("dblclick", doubleClick);
          };
        }],
        destroy: [() => removeListeners()],
      },
    };
  }

  function createOiTsTooltipPlugin(strikes) {
    let tooltip = null;
    return {
      hooks: {
        ready: [(u) => {
          tooltip = document.createElement("div");
          tooltip.className = "oi-ts-tooltip";
          tooltip.hidden = true;
          u.over.appendChild(tooltip);
        }],
        setCursor: [(u) => {
          if (!tooltip) return;
          const idx = u.cursor.idx;
          if (idx == null || idx < 0 || !Number.isFinite(u.cursor.left) || !Number.isFinite(u.cursor.top)) {
            tooltip.hidden = true;
            return;
          }

          let nearest = null;
          for (let seriesIndex = 1; seriesIndex < u.data.length; seriesIndex += 1) {
            const value = u.data[seriesIndex]?.[idx];
            if (!Number.isFinite(value)) continue;
            const y = u.valToPos(value, "y");
            const distance = Math.abs(y - u.cursor.top);
            if (!nearest || distance < nearest.distance) {
              nearest = { seriesIndex, value, distance, y };
            }
          }
          const time = u.data[0]?.[idx];
          if (!nearest || !Number.isFinite(time)) {
            tooltip.hidden = true;
            return;
          }

          const strike = strikes[nearest.seriesIndex - 1];
          const color = u.series[nearest.seriesIndex]?.stroke || "#8c8ca0";
          tooltip.style.setProperty("--oi-tip-color", color);
          tooltip.innerHTML = `
            <span class="oi-ts-tip-time">${formatIstTime(time)} IST</span>
            <span class="oi-ts-tip-strike"><i></i>Strike ${number.format(strike)}</span>
            <span class="oi-ts-tip-value">Total OI <strong>${compactNumber.format(nearest.value)}</strong></span>
          `;
          tooltip.hidden = false;
          const left = Math.min(u.over.clientWidth - tooltip.offsetWidth - 10, Math.max(8, u.cursor.left + 14));
          const top = Math.min(u.over.clientHeight - tooltip.offsetHeight - 10, Math.max(8, nearest.y - tooltip.offsetHeight / 2));
          tooltip.style.left = `${left}px`;
          tooltip.style.top = `${top}px`;
        }],
        destroy: [() => { tooltip?.remove(); tooltip = null; }],
      },
    };
  }

  function buildOiTsChart(host, w, h) {
    const strikes = oiTsStrikes();
    const history = oiTsHistory();
    if (!strikes.length || !host) return null;
    const { start: windowStart, end: windowEnd } = oiTsSelectedWindow();
    const allTs = new Set();
    for (const k of strikes) {
      for (const pt of (history[k] || [])) {
        const t = Number(pt.t);
        if (t >= windowStart && t <= windowEnd) allTs.add(t);
      }
    }
    const IST_MS = (5 * 60 + 30) * 60000;
    const isMarketTime = (ms) => {
      const utc = ms + IST_MS;
      const hh = Math.floor((utc % 86400000) / 3600000);
      const mm = Math.floor((utc % 3600000) / 60000);
      const mins = hh * 60 + mm;
      return mins >= 555 && mins <= 930; // 9:15 AM to 3:30 PM IST
    };
    const tArr = [...allTs].filter((t) => Number.isFinite(t) && isMarketTime(t)).sort((a, b) => a - b);
    if (!tArr.length) return null;
    // uPlot x-axis needs unix seconds
    const tsSeconds = tArr.map((t) => t / 1000);
    const uData = [new Float64Array(tsSeconds)];
    const series = [{ label: "Time" }];
    for (let i = 0; i < strikes.length; i++) {
      const k = strikes[i];
      const points = (history[k] || [])
        .map((pt) => {
          const t = Number(pt.t);
          const ceOi = Number(pt.ceOi);
          const peOi = Number(pt.peOi);
          return { t, total: (Number.isFinite(ceOi) ? ceOi : 0) + (Number.isFinite(peOi) ? peOi : 0) };
        })
        .filter((pt) => Number.isFinite(pt.t) && Number.isFinite(pt.total) && pt.t >= windowStart && pt.t <= windowEnd)
        .sort((a, b) => a.t - b.t);
      const map = new Map(points.map((pt) => [pt.t, pt.total]));
      const firstT = points[0]?.t;
      const lastT = points[points.length - 1]?.t;
      let carried = null;
      const values = tArr.map((t) => {
        if (firstT == null || t < firstT || t > lastT) return null;
        if (map.has(t)) carried = map.get(t);
        return carried;
      });
      uData.push(values);
      series.push({
        label: number.format(k),
        stroke: oiTsColor(i, strikes.length),
        width: 2,
        spanGaps: true,
        points: { show: true, size: 4 },
        value: (_u, value) => value == null ? "--" : compactNumber.format(value),
      });
    }
    const width  = w || host.clientWidth  || 800;
    const height = h || host.clientHeight || 340;

    // IST offset = UTC+5:30 = 19800 seconds
    const IST_OFFSET = 19800;
    const fmtIST = (_, secs) => {
      const d = new Date((secs + IST_OFFSET) * 1000);
      const hh = String(d.getUTCHours()).padStart(2, "0");
      const mm = String(d.getUTCMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    };
    const fmtISTDate = (_, secs) => {
      const d = new Date((secs + IST_OFFSET) * 1000);
      return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
    };

    const opts = {
      width, height,
      cursor: { show: true, sync: {}, drag: { x: false, y: false } },
      legend: { show: false },
      scales: { x: { time: true }, y: { auto: true } },
      axes: [
        {
          stroke: "#8c8ca0",
          ticks: { stroke: "rgba(255,255,255,0.1)", size: 4 },
          grid: { stroke: "rgba(255,255,255,0.06)" },
          font: "10px system-ui",
          values: (u, splits) => splits.map((s) => {
            const spansDays = tArr.length > 1 && (tArr[tArr.length - 1] - tArr[0]) >= 86400000;
            return spansDays ? `${fmtISTDate(u, s)} ${fmtIST(u, s)}` : fmtIST(u, s);
          }),
          space: 60,
        },
        {
          stroke: "#8c8ca0",
          ticks: { stroke: "rgba(255,255,255,0.1)", size: 4 },
          grid: { stroke: "rgba(255,255,255,0.06)" },
          font: "10px system-ui",
          values: (u, vals) => vals.map((v) => compactNumber.format(v)),
          size: 52,
        }
      ],
      series,
      hooks: { drawAxes: [] },
      plugins: [createOiTsInteractionPlugin(tsSeconds), createOiTsTooltipPlugin(strikes)],
    };
    return new uPlot(opts, uData, host);
  }

  // ResizeObserver effect — rebuild on size change while section is active.
  createEffect(() => {
    if (section() !== "oi-timeseries" || !oiTsHost) return;

    const host = oiTsHost;
    let lastW = 0, lastH = 0;

    const rebuild = () => {
      const w = Math.floor(host.clientWidth);
      const h = Math.floor(host.clientHeight);
      if (w < 10 || h < 10) return;
      if (w === lastW && h === lastH) return;
      lastW = w; lastH = h;
      oiTsChart?.destroy();
      host.innerHTML = "";
      oiTsChart = buildOiTsChart(host, w, h) ?? null;
    };

    const ro = new ResizeObserver(rebuild);
    ro.observe(host);
    rebuild();

    onCleanup(() => { ro.disconnect(); oiTsChart?.destroy(); oiTsChart = null; });
  });

  // Data effect — rebuild when history/strikes/date window change.
  createEffect(() => {
    if (section() !== "oi-timeseries") return;
    oiTsHistory(); oiTsStrikes(); oiTsStartDate(); oiTsEndDate();
    if (!oiTsHost) return;
    const w = Math.floor(oiTsHost.clientWidth);
    const h = Math.floor(oiTsHost.clientHeight);
    if (w < 10 || h < 10) return;
    oiTsChart?.destroy();
    oiTsHost.innerHTML = "";
    oiTsChart = buildOiTsChart(oiTsHost, w, h) ?? null;
  });

  return (
    <section class={`view-panel ${section() === "oi-timeseries" ? "active" : ""}`} aria-hidden={section() !== "oi-timeseries"}>
      <div class="gamma-workspace">
        <div class="chain-toolbar">
          <div class="chain-toolbar-scroll">
            <button class="chain-search-btn" type="button" onClick={() => setChainSearchOpen(true)}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
              <span class="chain-search-btn-text">{chainData()?.asset || chainSymbol() || "Search"}</span>
              <span class="chain-search-btn-sub">{chainExchange()} · {chainExpiry() || "Auto"} · {chainStatus()}</span>
            </button>
            <div class="chain-toolbar-divider" />
            <KSelect.Root class="tb-field" value={oiTsRange()} onChange={(val) => { if (val != null) setOiTsRange(val); }}
              options={["3","5","7","10"]}
              itemComponent={(props) => <KSelect.Item item={props.item} class="kb-select-item"><KSelect.ItemLabel>ATM ±{props.item.rawValue}</KSelect.ItemLabel></KSelect.Item>}
            >
              <KSelect.Label class="tb-field-label">strikes tracked</KSelect.Label>
              <KSelect.Trigger class="kb-select-trigger tb-field-select" aria-label="Strikes tracked">
                <KSelect.Value>{(state) => `ATM ±${state.selectedOption()}`}</KSelect.Value>
                <KSelect.Icon class="kb-select-icon">▾</KSelect.Icon>
              </KSelect.Trigger>
              <KSelect.Portal><KSelect.Content class="kb-select-content"><KSelect.Listbox class="kb-select-listbox" /></KSelect.Content></KSelect.Portal>
            </KSelect.Root>
            <div class="chain-toolbar-divider" />
            <button data-ui="button" data-appearance="accent" onClick={() => run(loadOiTsSeries)} disabled={busy()}>Load OI</button>
            <Show when={chainLive()} fallback={<button data-ui="button" data-appearance="outline" onClick={startChainLive} disabled={busy() || !authed()}>Live</button>}>
              <button data-ui="button" data-appearance="outline" onClick={stopChainLive} style="border-color:rgba(240,79,79,0.4);color:var(--bear)">Stop</button>
            </Show>
          </div>
          <div class="chain-toolbar-right">
            <label class="tb-field">
              <span class="tb-field-label">from</span>
              <input type="date" class="tb-field-input" style="width:120px"
                value={oiTsStartDate()}
                onInput={(e) => { oiTsXRange = null; setOiTsStartDate(e.currentTarget.value); }} />
            </label>
            <label class="tb-field">
              <span class="tb-field-label">to</span>
              <input type="date" class="tb-field-input" style="width:120px"
                value={oiTsEndDate()}
                onInput={(e) => { oiTsXRange = null; setOiTsEndDate(e.currentTarget.value); }} />
            </label>
            <button data-ui="button" data-appearance="outline"
              disabled={busy() || !authed()}
              onClick={() => run(loadOiTsSeries)}>Reload series</button>
            <span data-ui="badge">1m interval</span>
            <span data-ui="badge">{oiTsStrikes().length} strikes</span>
            <button data-ui="button" data-appearance="stealth" title="Clear history" onClick={() => setOiTsHistory({})}>✕</button>
          </div>
        </div>
        <div class="gamma-content" style="grid-template-columns:1fr;grid-template-rows:1fr">
          <div class="gamma-chart-card" style="min-height:0">
            <div class="gamma-chart-head">
              <div><strong>OI Time Series · 1m</strong><span>Mouse wheel to zoom · drag to pan · double-click to reset</span></div>
              <div class="oi-ts-strike-strip">
                <button type="button" class="oi-ts-reset" onClick={resetOiTsZoom}>Reset</button>
                <For each={oiTsStrikes()}>{(k, i) => {
                  const color = () => oiTsColor(i(), oiTsStrikes().length);
                  const latest = () => latestOiForStrike(k);
                  return (
                    <span class="gamma-peak-chip" style={`background:color-mix(in srgb, ${color()} 14%, transparent);border-color:color-mix(in srgb, ${color()} 40%, transparent);color:${color()}`}>
                      {number.format(k)}{latest() == null ? "" : ` · ${compactNumber.format(latest())}`}
                    </span>
                  );
                }}</For>
              </div>
            </div>
            <div class="gamma-chart-shell">
              <div class="gamma-chart oi-ts-chart" ref={(el) => { oiTsHost = el; }} />
              <Show when={!oiTsStrikes().length}>
                <div class="gamma-empty">Click <strong>Load OI</strong> to load REST history first, then append the latest option-chain data.</div>
              </Show>
              <Show when={oiTsStrikes().length > 0 && !Object.keys(oiTsHistory()).length}>
                <div class="gamma-empty">Strikes tracked — click <strong>Live</strong> to start recording OI over time.</div>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
