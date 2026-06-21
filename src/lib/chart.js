// Lightweight-charts factory with the app's dark theme defaults.

import { formatIstTime } from "./datetime.js";

export function makeChart(host, options = {}) {
  if (!window.LightweightCharts || !host) return null;
  return window.LightweightCharts.createChart(host, {
    layout: {
      background: { type: "solid", color: "#080b10" },
      textColor: "#9ca3af",
      fontFamily: "Inter, system-ui, sans-serif"
    },
    grid: {
      vertLines: { color: "rgba(255,255,255,0.045)" },
      horzLines: { color: "rgba(255,255,255,0.045)" }
    },
    rightPriceScale: {
      borderColor: "rgba(255,255,255,0.09)",
      scaleMargins: { top: 0.1, bottom: 0.12 }
    },
    timeScale: {
      borderColor: "rgba(255,255,255,0.09)",
      timeVisible: true,
      secondsVisible: true,
      rightOffset: 8,
      barSpacing: 7,
      tickMarkFormatter: formatIstTime
    },
    crosshair: {
      mode: window.LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: "#ff8a3d", style: 2, width: 1 },
      horzLine: { color: "#ff8a3d", style: 2, width: 1 }
    },
    localization: {
      locale: "en-IN",
      timeFormatter: formatIstTime
    },
    ...options
  });
}
