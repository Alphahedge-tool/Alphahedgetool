// Lightweight-charts factory with the app's active theme defaults.

import { formatIstTime } from "./datetime.js";

function cssVar(name, fallback) {
  const root = document.querySelector(".app-root") || document.documentElement;
  const value = getComputedStyle(root).getPropertyValue(name).trim();
  return value || fallback;
}

export function chartThemeOptions() {
  const chartBg = cssVar("--chart-bg", cssVar("--bg-0", "#080b10"));
  const chartText = cssVar("--chart-text", cssVar("--tx-3", "#9ca3af"));
  const chartGrid = cssVar("--chart-grid", "rgba(255,255,255,0.045)");
  const chartBorder = cssVar("--chart-border", "rgba(255,255,255,0.09)");
  const chartCrosshair = cssVar("--chart-crosshair", cssVar("--gold", "#ff8a3d"));

  return {
    layout: {
      background: { type: "solid", color: chartBg },
      textColor: chartText,
      fontFamily: "Inter, system-ui, sans-serif"
    },
    grid: {
      vertLines: { color: chartGrid },
      horzLines: { color: chartGrid }
    },
    rightPriceScale: {
      borderColor: chartBorder,
      scaleMargins: { top: 0.1, bottom: 0.12 }
    },
    timeScale: {
      borderColor: chartBorder,
      timeVisible: true,
      secondsVisible: true,
      rightOffset: 8,
      barSpacing: 7,
      tickMarkFormatter: formatIstTime
    },
    crosshair: {
      mode: window.LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: chartCrosshair, style: 2, width: 1 },
      horzLine: { color: chartCrosshair, style: 2, width: 1 }
    }
  };
}

export function makeChart(host, options = {}) {
  if (!window.LightweightCharts || !host) return null;
  return window.LightweightCharts.createChart(host, {
    ...chartThemeOptions(),
    localization: {
      locale: "en-IN",
      timeFormatter: formatIstTime
    },
    ...options
  });
}
