// Multi Spread view — a grid of "rolling" OTM strangle charts.
//
// Each slot is an OTM strangle: OTM N = CE at (ATM + N steps) + PE at (ATM − N
// steps), combined the same way the Rolling Straddle chart combines its legs.
// As the ATM strike shifts intraday each chart rolls to the new offset strikes.
// Every mini chart plots Bid + Ask (right ₹ axis) and IV % (left axis), mirroring
// the straddle chart. Each slot has a dropdown to pick which OTM it shows; picks
// are unique across slots. The uPlot instances are created in App and bound to
// the hosts registered here via the store.

import { For, Index, Show, createMemo, createEffect, onCleanup } from "solid-js";
import * as KSelect from "@kobalte/core/select";
import { useApp } from "../state/AppContext.jsx";

const LAYOUTS = [
  { id: "2x2", label: "2×2", cols: 2 },
  { id: "3x3", label: "3×3", cols: 3 },
  { id: "4x4", label: "4×4", cols: 4 },
  { id: "side", label: "Side by side", cols: 0 },
];

const MAX_OTM = 10;
const OTM_OPTIONS = Array.from({ length: MAX_OTM }, (_, i) => i + 1);

// One chart slot. The host re-registers under the slot's selected offset
// whenever the dropdown changes, so the uPlot chart for that OTM moves here.
function SlotCard(props) {
  const { msCells, registerMsChartHost, setMsSlot } = useApp();
  let hostEl;

  const offset = () => props.offset;
  const cell = createMemo(() => msCells()[offset()] || {});

  // Bind/rebind the chart host to the current offset, cleaning up the previous.
  createEffect((prevOffset) => {
    const current = offset();
    if (hostEl) {
      if (prevOffset != null && prevOffset !== current) registerMsChartHost(prevOffset, null);
      registerMsChartHost(current, hostEl);
    }
    return current;
  });
  onCleanup(() => { if (hostEl) registerMsChartHost(offset(), null); });

  return (
    <div class="ms-chart-card">
      <div class="ms-chart-head">
        <div class="ms-chart-title">
          <KSelect.Root
            class="ms-otm-select"
            value={offset()}
            onChange={(val) => { if (val != null) setMsSlot(props.slotIndex, val); }}
            options={OTM_OPTIONS}
            itemComponent={(itemProps) => (
              <KSelect.Item item={itemProps.item} class="kb-select-item">
                <KSelect.ItemLabel>OTM {itemProps.item.rawValue}</KSelect.ItemLabel>
              </KSelect.Item>
            )}
          >
            <KSelect.Trigger class="kb-select-trigger ms-otm-trigger" aria-label="Choose OTM for this slot">
              <KSelect.Value>
                {(state) => <strong>OTM {state.selectedOption()}</strong>}
              </KSelect.Value>
              <KSelect.Icon class="kb-select-icon">▾</KSelect.Icon>
            </KSelect.Trigger>
            <KSelect.Portal>
              <KSelect.Content class="kb-select-content">
                <KSelect.Listbox class="kb-select-listbox" />
              </KSelect.Content>
            </KSelect.Portal>
          </KSelect.Root>
          <span class="ms-chart-strikes">
            {cell().ceStrike != null && cell().peStrike != null
              ? `CE ${cell().ceStrike} · PE ${cell().peStrike}`
              : "CE — · PE —"}
          </span>
        </div>
        <div class="ms-chart-stats">
          <Show when={cell().bid != null}>
            <span class="ms-stat bid">B {cell().bid}</span>
          </Show>
          <Show when={cell().ask != null}>
            <span class="ms-stat ask">A {cell().ask}</span>
          </Show>
          <Show when={cell().iv != null}>
            <span class="ms-stat iv">{cell().iv}%</span>
          </Show>
        </div>
      </div>
      <div class="ms-chart-shell">
        <div class="ms-chart" ref={(el) => (hostEl = el)} />
        <Show when={!cell().hasData}>
          <div class="ms-empty">Plot to load OTM {offset()}</div>
        </Show>
      </div>
    </div>
  );
}

export function MultiSpreadView() {
  const {
    section,
    msLayout, setMsLayout,
    msSeriesVisibility, toggleMsSeries,
    msStatus, msSlots, msSlotCount,
  } = useApp();

  const layoutCols = createMemo(() => {
    const layout = LAYOUTS.find((l) => l.id === msLayout()) || LAYOUTS[0];
    return layout.cols;
  });

  // One entry per visible slot: { slotIndex, offset }. Indexed by position so
  // SlotCards persist across dropdown changes (only the offset accessor updates).
  const slots = createMemo(() => {
    const count = msSlotCount();
    const picks = msSlots();
    return Array.from({ length: count }, (_, i) => ({ slotIndex: i, offset: picks[i] }));
  });

  return (
    <section class={`view-panel ${section() === "multispread" ? "active" : ""}`} aria-hidden={section() !== "multispread"}>
      <div class="ms-workspace">
        <div class="ms-toolbar">
          <div class="ms-toolbar-left">
            <span class="ms-title">Multi Spread</span>
            <span class="ms-sub">Rolling OTM strangles · CE ATM+N / PE ATM−N · pick OTM per slot</span>
          </div>
          <div class="ms-toolbar-right">
            {/* Layout toggle */}
            <div data-ui="tabs" class="shrink-0" data-activeid={msLayout()} aria-label="Grid layout">
              <For each={LAYOUTS}>
                {(layout) => (
                  <button data-ui="tab" id={layout.id} onClick={() => setMsLayout(layout.id)}>
                    {layout.label}
                  </button>
                )}
              </For>
            </div>
            {/* Series toggles — shared across every mini chart */}
            <button data-ui="button"
              data-appearance="stealth"
              type="button"
              class={msSeriesVisibility().bid ? "" : "opacity-40 line-through"}
              aria-pressed={msSeriesVisibility().bid}
              title={msSeriesVisibility().bid ? "Mute Bid series" : "Show Bid series"}
              onClick={() => toggleMsSeries("bid", 1)}
            >
              <span class="inline-block h-2 w-4 rounded-sm" style="background:#10B981"></span>
              <span style="color:var(--text-muted)">Bid ₹</span>
            </button>
            <button data-ui="button"
              data-appearance="stealth"
              type="button"
              class={msSeriesVisibility().ask ? "" : "opacity-40 line-through"}
              aria-pressed={msSeriesVisibility().ask}
              title={msSeriesVisibility().ask ? "Mute Ask series" : "Show Ask series"}
              onClick={() => toggleMsSeries("ask", 2)}
            >
              <span class="inline-block h-2 w-4 rounded-sm" style="background:#EF4444"></span>
              <span style="color:var(--text-muted)">Ask ₹</span>
            </button>
            <button data-ui="button"
              data-appearance="stealth"
              type="button"
              class={msSeriesVisibility().iv ? "" : "opacity-40 line-through"}
              aria-pressed={msSeriesVisibility().iv}
              title={msSeriesVisibility().iv ? "Mute IV series" : "Show IV series"}
              onClick={() => toggleMsSeries("iv", 3)}
            >
              <span class="inline-block h-px w-4" style="background:#3B82F6;border-top:2px solid #3B82F6"></span>
              <span style="color:var(--text-muted)">IV % (left)</span>
            </button>
            <Show when={msStatus()}>
              <span class="ms-status">{msStatus()}</span>
            </Show>
          </div>
        </div>

        <div
          class={`ms-grid ${msLayout() === "side" ? "ms-grid-side" : ""}`}
          style={layoutCols() ? `--ms-cols:${layoutCols()}` : ""}
        >
          <Index each={slots()}>
            {(slot) => <SlotCard slotIndex={slot().slotIndex} offset={slot().offset} />}
          </Index>
        </div>
      </div>
    </section>
  );
}
