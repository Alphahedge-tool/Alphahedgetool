// Volatility Surface view — 3D Plotly mesh (strike × expiry × IV) with a
// 2D heatmap-table fallback. Self-contained: owns the Plotly host, the 3D/Table
// toggle, the aggregation memo and the on-demand Plotly effect.
// Shared IV-term data + actions come from the App store via useApp().

import { createEffect, createMemo, createSignal, onCleanup, For, Show } from "solid-js";
import { number, formatPlain } from "../lib/format.js";
import { useApp } from "../state/AppContext.jsx";

function ivToColor(iv, minIv, maxIv) {
  const t = maxIv > minIv ? (iv - minIv) / (maxIv - minIv) : 0.5;
  // blue (low IV) → yellow (mid) → red (high IV)
  const r = Math.round(t < 0.5 ? 59 + (245 - 59) * t * 2 : 245 + (239 - 245) * (t - 0.5) * 2);
  const g = Math.round(t < 0.5 ? 130 + (158 - 130) * t * 2 : 158 + (68 - 158) * (t - 0.5) * 2);
  const b = Math.round(t < 0.5 ? 246 + (11 - 246) * t * 2 : 11 + (68 - 11) * (t - 0.5) * 2);
  return `rgb(${r} ${g} ${b} / ${0.15 + t * 0.55})`;
}

export function VolSurfaceView() {
  const {
    section, busy, authed,
    smileSurfaces, ivTermSymbol, ivTermExchange, ivTermStatus,
    setIvTermSymbol, setIvTermExchange,
    run, loadIvTermStructure,
  } = useApp();

  let volSurface3dHost;
  const [vsView, setVsView] = createSignal("3d"); // "3d" | "table"

  // reactive memo: aggregate smile surfaces into { strikes, rows, minIv, maxIv }
  const volSurfaceData = createMemo(() => {
    const surfaces = smileSurfaces();
    if (!surfaces.length) return null;
    const allStrikes = new Set();
    for (const surf of surfaces) { for (const row of (surf.rows || [])) allStrikes.add(row.strike); }
    const strikes = [...allStrikes].sort((a, b) => a - b);
    if (!strikes.length) return null;
    let minIv = Infinity, maxIv = 0;
    const rows = surfaces.map((surf) => {
      const ptMap = new Map();
      for (const row of (surf.rows || [])) {
        const vs = [row.ceIv, row.peIv].filter(Number.isFinite);
        if (vs.length) ptMap.set(row.strike, vs.reduce((s, v) => s + v, 0) / vs.length);
      }
      const cells = strikes.map((k) => {
        const iv = ptMap.get(k) ?? null;
        if (iv != null) { minIv = Math.min(minIv, iv); maxIv = Math.max(maxIv, iv); }
        return iv;
      });
      return { expiry: surf.expiry, cells };
    });
    if (!Number.isFinite(minIv)) return null;
    return { strikes, rows, minIv, maxIv };
  });

  // ── 3D Plotly surface — loaded on demand ──
  createEffect(() => {
    if (section() !== "vol-surface" || vsView() !== "3d") return;
    const d = volSurfaceData();
    if (!d || !volSurface3dHost) return;

    const host = volSurface3dHost;
    const yLabels = d.rows.map((r) => r.expiry);
    const yVals   = d.rows.map((_, i) => i);   // 0,1,2,… → expiry index
    const xVals   = d.strikes;                  // strike numbers
    const z = d.rows.map((row) => row.cells.map((v) => v ?? null));

    import("plotly.js-dist-min").then((Plotly) => {
      if (!host) return;
      const trace = {
        type: "surface",
        x: xVals,
        y: yVals,
        z,
        colorscale: [
          [0,    "#1e3a8a"],
          [0.25, "#3B82F6"],
          [0.5,  "#10B981"],
          [0.75, "#8B5CF6"],
          [1,    "#EF4444"],
        ],
        colorbar: {
          title: { text: "IV %", font: { color: "#9CA8B8", size: 10 } },
          tickfont: { color: "#9CA8B8", size: 10 },
          thickness: 12,
          len: 0.7,
        },
        hovertemplate: "Strike: <b>%{x}</b><br>Expiry: <b>%{text}</b><br>IV: <b>%{z:.2f}%</b><extra></extra>",
        text: z.map((row, i) => row.map(() => yLabels[i])),
        lighting: { ambient: 0.7, diffuse: 0.6, specular: 0.2, roughness: 0.5 },
        contours: {
          z: { show: true, usecolormap: true, highlightcolor: "#fff", project: { z: true } }
        },
      };

      const layout = {
        paper_bgcolor: "transparent",
        plot_bgcolor:  "transparent",
        margin: { l: 0, r: 0, t: 10, b: 0 },
        scene: {
          bgcolor: "#202A38",
          xaxis: {
            title: { text: "Strike", font: { color: "#9CA8B8", size: 10 } },
            tickfont: { color: "#9CA8B8", size: 9 },
            gridcolor: "rgba(68,80,94,0.35)",
            zerolinecolor: "rgba(68,80,94,0.55)",
            backgroundcolor: "#202A38",
          },
          yaxis: {
            title: { text: "Expiry", font: { color: "#9CA8B8", size: 10 } },
            tickfont: { color: "#9CA8B8", size: 9 },
            tickvals: yVals,
            ticktext: yLabels,
            gridcolor: "rgba(68,80,94,0.35)",
            zerolinecolor: "rgba(68,80,94,0.55)",
            backgroundcolor: "#202A38",
          },
          zaxis: {
            title: { text: "IV %", font: { color: "#9CA8B8", size: 10 } },
            tickfont: { color: "#9CA8B8", size: 9 },
            gridcolor: "rgba(68,80,94,0.35)",
            zerolinecolor: "rgba(68,80,94,0.55)",
            backgroundcolor: "#202A38",
          },
          camera: { eye: { x: 1.6, y: -1.6, z: 0.9 } },
          aspectmode: "manual",
          aspectratio: { x: 2.2, y: 1, z: 0.7 },
        },
        font: { color: "#D7DEE8", family: "system-ui,sans-serif" },
      };

      const config = { responsive: true, displayModeBar: true, displaylogo: false, modeBarButtonsToRemove: ["toImage","sendDataToCloud"], modeBarButtonsToAdd: [] };

      try { Plotly.purge(host); } catch {}
      Plotly.newPlot(host, [trace], layout, config);
    });

    onCleanup(() => {
      import("plotly.js-dist-min").then((Plotly) => { try { Plotly.purge(host); } catch {} });
    });
  });

  return (
    <section class={`view-panel ${section() === "vol-surface" ? "active" : ""}`} aria-hidden={section() !== "vol-surface"}>
      <div class="gamma-workspace">

        {/* toolbar */}
        <div class="vs-topbar">
          <div class="vs-topbar-left">
            {/* quick-select buttons */}
            <For each={["NIFTY","BANKNIFTY","FINNIFTY","MIDCPNIFTY","SENSEX"]}>
              {(sym) => (
                <button
                  class={`vs-sym-btn${ivTermSymbol() === sym ? " active" : ""}`}
                  onClick={() => { setIvTermSymbol(sym); setIvTermExchange(sym === "SENSEX" ? "BSE" : "NSE"); }}
                  disabled={busy()}
                >{sym}</button>
              )}
            </For>
            <div class="vs-topbar-divider" />
            {/* manual entry */}
            <label class="tb-field">
              <span class="tb-field-label">custom</span>
              <input
                class="tb-field-input"
                style="min-width:90px"
                placeholder="Symbol…"
                value={ivTermSymbol()}
                onInput={(e) => setIvTermSymbol(e.currentTarget.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === "Enter" && !busy() && authed()) run(loadIvTermStructure); }}
              />
            </label>
            <label class="tb-field">
              <span class="tb-field-label">exchange</span>
              <select
                class="tb-field-select"
                value={ivTermExchange()}
                onChange={(e) => setIvTermExchange(e.currentTarget.value)}
              >
                <option value="NSE">NSE</option>
                <option value="BSE">BSE</option>
                <option value="MCX">MCX</option>
              </select>
            </label>
            <div class="vs-topbar-divider" />
            <button
              data-ui="button"
              data-appearance="accent"
              disabled={busy() || !authed() || !ivTermSymbol()}
              onClick={() => run(loadIvTermStructure)}
            >
              {busy() ? ivTermStatus() : "Load Surface"}
            </button>
          </div>
          <div class="vs-topbar-right">
            <Show when={smileSurfaces().length > 0}>
              <span data-ui="badge" style="color:var(--bull)">{smileSurfaces().length} expiries</span>
            </Show>
            <Show when={busy()}>
              <span class="vs-loading-status">{ivTermStatus()}</span>
            </Show>
            {/* 3D / Table toggle */}
            <Show when={volSurfaceData()}>
              <div class="vs-view-toggle">
                <button class={vsView() === "3d" ? "active" : ""} onClick={() => setVsView("3d")}>3D</button>
                <button class={vsView() === "table" ? "active" : ""} onClick={() => setVsView("table")}>Table</button>
              </div>
            </Show>
          </div>
        </div>

        {/* surface or empty state */}
        <Show
          when={volSurfaceData()}
          fallback={
            <div class="vs-empty">
              <div class="vs-empty-inner">
                <div class="vs-empty-icon">◫</div>
                <strong>Volatility Surface</strong>
                <span>Select an underlying above and click <em>Load Surface</em></span>
                <span style="color:var(--tx-5);font-size:10px">Fetches IV across all expiries · builds 3D surface</span>
              </div>
            </div>
          }
        >
          {(d) => (
            <>
              {/* 3D Plotly surface */}
              <div
                class="vs-3d-host"
                ref={(el) => { volSurface3dHost = el; }}
                style={{ display: vsView() === "3d" ? "flex" : "none" }}
              />

              {/* 2D heatmap table fallback */}
              <Show when={vsView() === "table"}>
                <div class="vol-surface-wrap">
                  <div class="vol-surface-table-scroll">
                    <table class="vol-surface-table">
                      <thead>
                        <tr>
                          <th class="vs-expiry-head">Expiry ↓ / Strike →</th>
                          <For each={d().strikes}>{(k) => <th>{number.format(k)}</th>}</For>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={d().rows}>{(row) => (
                          <tr>
                            <td class="vs-expiry-cell">{row.expiry}</td>
                            <For each={row.cells}>{(iv) => (
                              <td
                                class="vs-iv-cell"
                                style={iv != null ? `background:${ivToColor(iv, d().minIv, d().maxIv)}` : ""}
                                title={iv != null ? `IV ${formatPlain(iv, 2)}%` : "—"}
                              >
                                {iv != null ? formatPlain(iv, 1) : ""}
                              </td>
                            )}</For>
                          </tr>
                        )}</For>
                      </tbody>
                    </table>
                  </div>
                  <div class="vs-legend">
                    <span>Low {formatPlain(d().minIv, 1)}%</span>
                    <div class="vs-legend-bar" />
                    <span>High {formatPlain(d().maxIv, 1)}%</span>
                  </div>
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>
    </section>
  );
}
