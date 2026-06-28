// OIE analytics charts — GEX Profile and OI Buildup (uPlot, self-contained).
// Each takes a `strikes` array prop and re-mounts when it changes.

import { onMount, onCleanup } from "solid-js";
import uPlot from "uplot";
import { OIE_AXIS_FONT, OIE_GRID, OIE_TICK, OIE_TEXT } from "../lib/constants.js";
import { fmtOICompact, fmtGEX, strikePx } from "../lib/format.js";

// ── GEX Profile — vertical bars, reactive ────────────────────────────────────
export function OieGEXProfileChart({ strikes }) {
  let host;
  let uRef = null;

  onMount(() => {
    if (!host || !strikes?.length) return;

    const withGex = strikes
      .map(s => ({
        ...s,
        net_gex: (s.ce_gamma != null && s.pe_gamma != null)
          ? (s.ce_gamma * (s.ce_oi ?? 0) - s.pe_gamma * (s.pe_oi ?? 0))
          : null,
      }))
      .filter(s => s.net_gex != null);
    if (!withGex.length) return;

    const sorted  = [...withGex].sort((a, b) => a.strike_price - b.strike_price);
    const atmIdx  = sorted.findIndex(s => s.is_atm);
    const center  = atmIdx >= 0 ? atmIdx : Math.floor(sorted.length / 2);
    const visible = sorted.slice(Math.max(0, center - 9), Math.min(sorted.length, center + 10));
    if (!visible.length) return;

    const xs   = visible.map((_, i) => i);
    const gexs = visible.map(s => s.net_gex);
    const w    = host.clientWidth || 520;

    uRef = new uPlot({
      width: w,
      height: 240,
      padding: [16, 12, 4, 58],
      legend: { show: false },
      cursor: { show: false },
      scales: {
        x: { time: false, range: [-0.5, visible.length - 0.5] },
        y: { auto: true },
      },
      axes: [
        {
          font: OIE_AXIS_FONT, stroke: OIE_TEXT,
          border: { show: false },
          grid: { show: false },
          ticks: { show: true, stroke: OIE_TICK, width: 1, size: 3 },
          values: (_u, vs) => vs.map(v => {
            const row = visible[Math.round(v)];
            return row ? String(strikePx(row.strike_price)) : "";
          }),
          space: 54, gap: 4,
        },
        {
          font: OIE_AXIS_FONT, stroke: OIE_TEXT,
          border: { show: false },
          grid: { show: true, stroke: OIE_GRID, width: 1 },
          ticks: { show: true, stroke: OIE_TICK, width: 1, size: 3 },
          values: (_u, vs) => vs.map(v => v == null ? "" : fmtGEX(v)),
          size: 54, gap: 4,
        },
      ],
      series: [
        {},
        { label: "net gex", stroke: "#34d399", fill: "rgba(52,211,153,0.1)", points: { show: false }, paths: uPlot.paths.bars({ size: [0.65, 100] }) },
      ],
      hooks: {
        drawSeries: [u => {
          const ctx = u.ctx;
          ctx.save();
          const y0 = u.valToPos(0, "y", true);
          visible.forEach((s, i) => {
            const gex   = s.net_gex;
            const isAtm = s.is_atm;
            const xPx   = u.valToPos(i, "x", true);
            const yPx   = u.valToPos(gex, "y", true);
            const bw    = Math.max(6, (u.bbox.width / visible.length) * 0.58);
            const bh    = Math.abs(yPx - y0);
            ctx.fillStyle = gex >= 0 ? "rgba(52,211,153,0.75)" : "rgba(248,113,113,0.75)";
            ctx.fillRect(xPx - bw / 2, Math.min(yPx, y0), bw, Math.max(bh, 2));
            if (isAtm) {
              ctx.strokeStyle = "rgba(34,211,238,0.7)";
              ctx.lineWidth   = 1.5;
              ctx.setLineDash([3, 3]);
              ctx.strokeRect(xPx - bw / 2 - 2, Math.min(yPx, y0) - 2, bw + 4, Math.max(bh, 2) + 4);
              ctx.setLineDash([]);
            }
          });
          ctx.strokeStyle = "rgba(255,255,255,0.12)";
          ctx.lineWidth   = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(u.bbox.left, y0);
          ctx.lineTo(u.bbox.left + u.bbox.width, y0);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
        }],
      },
    }, [xs, gexs], host);

    onCleanup(() => { uRef?.destroy(); uRef = null; });
  });

  if (!strikes?.length) return <div class="oie-chart-empty">no gex data</div>;
  return <div ref={host} class="oie-uplot-host" />;
}

// ── OI Buildup — vertical grouped bars, reactive ──────────────────────────────
export function OieOIBuildupChart({ strikes }) {
  let host;
  let uRef = null;

  onMount(() => {
    if (!host || !strikes?.length) return;

    const atmSt   = strikes.find(s => s.is_atm)?.strike_price;
    const sorted  = [...strikes].sort((a, b) => a.strike_price - b.strike_price);
    const atmI    = atmSt != null ? sorted.findIndex(s => s.strike_price === atmSt) : Math.floor(sorted.length / 2);
    const visible = sorted.slice(Math.max(0, atmI - 9), Math.min(sorted.length, atmI + 10));
    if (!visible.length) return;

    const xs     = visible.map((_, i) => i);
    const ceOI   = visible.map(s => s.ce_oi ?? 0);
    const peOI   = visible.map(s => s.pe_oi ?? 0);
    const atmIdx = visible.findIndex(s => s.is_atm || s.strike_price === atmSt);
    const w      = host.clientWidth || 520;

    uRef = new uPlot({
      width: w,
      height: 240,
      padding: [16, 12, 4, 58],
      legend: { show: false },
      cursor: { show: false },
      scales: {
        x: { time: false, range: [-0.5, visible.length - 0.5] },
        y: { auto: true },
      },
      axes: [
        {
          font: OIE_AXIS_FONT, stroke: OIE_TEXT,
          border: { show: false },
          grid: { show: false },
          ticks: { show: true, stroke: OIE_TICK, width: 1, size: 3 },
          values: (_u, vs) => vs.map(v => {
            const row = visible[Math.round(v)];
            return row ? String(strikePx(row.strike_price)) : "";
          }),
          space: 54, gap: 4,
        },
        {
          font: OIE_AXIS_FONT, stroke: OIE_TEXT,
          border: { show: false },
          grid: { show: true, stroke: OIE_GRID, width: 1 },
          ticks: { show: true, stroke: OIE_TICK, width: 1, size: 3 },
          values: (_u, vs) => vs.map(v => v == null ? "" : fmtOICompact(v)),
          size: 54, gap: 4,
        },
      ],
      series: [
        {},
        { label: "ce oi", stroke: "#EF4444", fill: "rgba(248,113,113,0.18)", points: { show: false }, paths: uPlot.paths.bars({ size: [0.35, 100], align: -1 }) },
        { label: "pe oi", stroke: "#34d399", fill: "rgba(52,211,153,0.18)",  points: { show: false }, paths: uPlot.paths.bars({ size: [0.35, 100], align:  1 }) },
      ],
      hooks: {
        draw: [u => {
          if (atmIdx < 0) return;
          const ctx = u.ctx;
          const xPx = u.valToPos(atmIdx, "x", true);
          ctx.save();
          ctx.strokeStyle = "rgba(34,211,238,0.4)";
          ctx.lineWidth   = 1;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(xPx, u.bbox.top);
          ctx.lineTo(xPx, u.bbox.top + u.bbox.height);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font      = OIE_AXIS_FONT;
          ctx.fillStyle = "rgba(34,211,238,0.6)";
          ctx.textAlign = "center";
          ctx.fillText("atm", xPx, u.bbox.top - 4);
          ctx.restore();
        }],
      },
    }, [xs, ceOI, peOI], host);

    onCleanup(() => { uRef?.destroy(); uRef = null; });
  });

  if (!strikes?.length) return <div class="oie-chart-empty">no oi data</div>;
  return <div ref={host} class="oie-uplot-host" />;
}
