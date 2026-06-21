// Option Chain view — full strike table (CE | Strike | PE) with a search dialog,
// exchange/expiry/filter controls, column menu and a Dhan-style stats bar.
// All data, memos and loaders live in App and are read via the store.

import { For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import * as KSelect from "@kobalte/core/select";
import { formatPlain, formatStrike, formatIndexValue, formatPercent } from "../lib/format.js";
import { chainStrikeInRupees } from "../lib/chain.js";
import { CHAIN_COLUMNS, SYMBOL_CATEGORIES } from "../lib/constants.js";
import { OptionCell } from "../components/OptionCell.jsx";
import { useApp } from "../state/AppContext.jsx";

export function ChainView() {
  const {
    section, busy, authed, run,
    chainData, chainSymbol, chainExchange, chainExpiry, chainStatus, chainLive, chainExpiries,
    chainSearchOpen, chainSearchText, chainSearchCategory, chainScriptMatches, groupedChainScriptMatches,
    chainSearchRows, chainFilterMode, chainAtmRange, chainPremiumMin, chainPremiumMax,
    chainColumnMenuOpen, chainVisibleColumns, chainRefMetrics, chainDerivedStats, chainIvChange, chainIvChangePercent,
    visibleOptionRows, visibleCallColumns, visiblePutColumns,
    setChainSearchOpen, setChainSearchText, setChainSearchQuery, setChainSearchCategory,
    setChainSymbol, setChainExchange, setChainData, setChainExpiry, setChainExpiries,
    setChainFilterMode, setChainAtmRange, setChainPremiumMin, setChainPremiumMax,
    setChainColumnMenuOpen, setScriptStatus,
    chooseChainScript, chainColumnLabel, optionCellProps, showPremiumSide,
    toggleChainColumn, showAllChainColumns, oieTagRow, selectChainExpiry,
    loadChainSearchRows, loadOptionChainExpiries, loadOptionChain, startChainLive, stopChainLive,
    registerChainExpiryMenuHost,
  } = useApp();

  return (
    <section class={`view-panel ${section() === "chain" ? "active" : ""}`} aria-hidden={section() !== "chain"}>
      <div class="option-chain-workspace">

        <Show when={chainSearchOpen()}>
          <Portal>
          <div class="chain-search-overlay fixed inset-0 grid place-items-center bg-black/60 p-4" onClick={() => setChainSearchOpen(false)}>
            <div data-ui="card" class="chain-search-dialog w-11/12 max-w-5xl p-5" onClick={(event) => event.stopPropagation()}>
              <div class="flex items-center justify-between">
                <h2 class="text-lg font-bold">Option Chain Search</h2>
                <button data-ui="button" data-appearance="stealth" onClick={() => setChainSearchOpen(false)}>x</button>
              </div>
              <div class="chain-search-input-row flex w-full items-center gap-2">
                <span class="text-xs opacity-60">Search</span>
                <input data-ui="input"
                  class="grow"
                  value={chainSearchText()}
                  placeholder="Search index, cash, futures, options, commodity..."
                  onInput={(e) => setChainSearchText(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      setChainSearchQuery(chainSearchText());
                      const first = chainScriptMatches()[0];
                      if (first) run(() => chooseChainScript(first));
                    }
                    if (e.key === "Escape") setChainSearchOpen(false);
                  }}
                  autofocus
                />
                <button data-ui="button" data-appearance="stealth" onClick={() => {
                  setChainSearchText("");
                  setChainSearchQuery("");
                }}>x</button>
              </div>
              <div data-ui="tabs" class="chain-search-tabs shrink-0 overflow-x-auto" data-activeid={chainSearchCategory()} aria-label="Option chain category">
                <For each={SYMBOL_CATEGORIES}>
                  {(category) => (
                    <button data-ui="tab" id={category.key} aria-selected={chainSearchCategory() === category.key} onClick={() => setChainSearchCategory(category.key)}>
                      {category.key === "stock" ? "Cash" : category.label}
                    </button>
                  )}
                </For>
              </div>
              <div class="symbol-result-list chain-modal-result-list">
                <For each={groupedChainScriptMatches()} fallback={<div class="symbol-empty">No matching instruments</div>}>
                  {(group) => (
                    <div class="chain-modal-group">
                      <div class="chain-script-group-title">{group.label}</div>
                      <For each={group.items}>
                        {(item) => (
                          <button
                            type="button"
                            class="chain-modal-result-row"
                            onClick={() => run(() => chooseChainScript(item))}
                          >
                            <span class={`chain-script-tag ${item.exchange.toLowerCase()}`}>{item.exchange}</span>
                            <span class="chain-modal-code">{item.asset}</span>
                            <span class="chain-modal-name">{item.displayName || item.asset}</span>
                            <span class="chain-script-tag">{item.typesText}</span>
                            <Show when={item.expiryText} fallback={<span class="chain-script-expiry-spacer"></span>}>
                              <span class="chain-script-expiry">Exp {item.expiryText}</span>
                            </Show>
                          </button>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </div>
          </Portal>
        </Show>

        <section class="chain-table-card">
          {/* ── single toolbar row ── */}
          <div class="chain-toolbar">
            <div class="chain-toolbar-scroll">
            {/* left: symbol search trigger */}
            <button class="chain-search-btn" type="button" onClick={() => {
              setChainSearchOpen(true);
              if (authed() && !chainSearchRows().length) {
                loadChainSearchRows().catch((error) => setScriptStatus(error.message || "Search scripts unavailable"));
              }
            }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
              <span class="chain-search-btn-text">{chainData()?.asset || chainSymbol() || "Search"}</span>
              <span class="chain-search-btn-sub">{chainExchange()} · {chainExpiry() || "Auto"} · {chainStatus()}</span>
            </button>

            <div class="chain-toolbar-divider" />

            {/* controls */}
            <label class="tb-field">
              <span class="tb-field-label">underlying</span>
              <input class="tb-field-input" style="min-width:80px" value={chainSymbol()} onInput={(e) => {
                stopChainLive();
                setChainSymbol(e.currentTarget.value.toUpperCase());
                setChainData(null); setChainExpiry(""); setChainExpiries([]);
              }} />
            </label>
            <KSelect.Root
              class="tb-field"
              value={chainExchange()}
              onChange={(val) => {
                if (val == null) return;
                stopChainLive();
                setChainExchange(val);
                setChainData(null); setChainExpiry(""); setChainExpiries([]);
              }}
              options={["NSE", "BSE", "MCX"]}
              itemComponent={(props) => (
                <KSelect.Item item={props.item} class="kb-select-item">
                  <KSelect.ItemLabel>{props.item.rawValue}</KSelect.ItemLabel>
                </KSelect.Item>
              )}
            >
              <KSelect.Label class="tb-field-label">exchange</KSelect.Label>
              <KSelect.Trigger class="kb-select-trigger tb-field-select" aria-label="Exchange">
                <KSelect.Value>{(state) => state.selectedOption()}</KSelect.Value>
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
              value={chainExpiry() || ""}
              onChange={selectChainExpiry}
              options={["", ...chainExpiries()]}
              itemComponent={(props) => (
                <KSelect.Item item={props.item} class="kb-select-item">
                  <KSelect.ItemLabel>{props.item.rawValue === "" ? "Auto" : props.item.rawValue}</KSelect.ItemLabel>
                </KSelect.Item>
              )}
            >
              <KSelect.Label class="tb-field-label">expiry</KSelect.Label>
              <KSelect.Trigger class="kb-select-trigger tb-field-select" aria-label="Expiry">
                <KSelect.Value fallback="Auto">
                  {(state) => state.selectedOption() === "" ? "Auto" : state.selectedOption()}
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
              value={chainFilterMode()}
              onChange={(val) => { if (val != null) setChainFilterMode(val); }}
              options={["atm", "premium"]}
              itemComponent={(props) => (
                <KSelect.Item item={props.item} class="kb-select-item">
                  <KSelect.ItemLabel>{props.item.rawValue === "atm" ? "ATM distance" : "Premium range"}</KSelect.ItemLabel>
                </KSelect.Item>
              )}
            >
              <KSelect.Label class="tb-field-label">filter</KSelect.Label>
              <KSelect.Trigger class="kb-select-trigger tb-field-select" aria-label="Filter">
                <KSelect.Value>{(state) => state.selectedOption() === "atm" ? "ATM distance" : "Premium range"}</KSelect.Value>
                <KSelect.Icon class="kb-select-icon">▾</KSelect.Icon>
              </KSelect.Trigger>
              <KSelect.Portal>
                <KSelect.Content class="kb-select-content">
                  <KSelect.Listbox class="kb-select-listbox" />
                </KSelect.Content>
              </KSelect.Portal>
            </KSelect.Root>
            <Show when={chainFilterMode() === "atm"}>
              <KSelect.Root
                class="tb-field"
                value={chainAtmRange()}
                onChange={(val) => { if (val != null) setChainAtmRange(val); }}
                options={["10", "20", "30", "40", "full"]}
                itemComponent={(props) => (
                  <KSelect.Item item={props.item} class="kb-select-item">
                    <KSelect.ItemLabel>{props.item.rawValue === "full" ? "Full" : `±${props.item.rawValue}`}</KSelect.ItemLabel>
                  </KSelect.Item>
                )}
              >
                <KSelect.Label class="tb-field-label">range</KSelect.Label>
                <KSelect.Trigger class="kb-select-trigger tb-field-select" aria-label="Range">
                  <KSelect.Value>{(state) => state.selectedOption() === "full" ? "Full" : `±${state.selectedOption()}`}</KSelect.Value>
                  <KSelect.Icon class="kb-select-icon">▾</KSelect.Icon>
                </KSelect.Trigger>
                <KSelect.Portal>
                  <KSelect.Content class="kb-select-content">
                    <KSelect.Listbox class="kb-select-listbox" />
                  </KSelect.Content>
                </KSelect.Portal>
              </KSelect.Root>
            </Show>
            <Show when={chainFilterMode() === "premium"}>
              <label class="tb-field">
                <span class="tb-field-label">min ₹</span>
                <input class="tb-field-input" style="min-width:60px" inputmode="decimal" value={chainPremiumMin()} placeholder="100" onInput={(e) => setChainPremiumMin(e.currentTarget.value)} />
              </label>
              <label class="tb-field">
                <span class="tb-field-label">max ₹</span>
                <input class="tb-field-input" style="min-width:60px" inputmode="decimal" value={chainPremiumMax()} placeholder="300" onInput={(e) => setChainPremiumMax(e.currentTarget.value)} />
              </label>
            </Show>

            <div class="chain-toolbar-divider" />

            <button data-ui="button" data-appearance="outline" onClick={() => run(loadOptionChainExpiries)} disabled={busy()}>Expiries</button>
            <button data-ui="button" data-appearance="accent" onClick={() => run(loadOptionChain)} disabled={busy()}>Load</button>
            <Show
              when={chainLive()}
              fallback={<button data-ui="button" data-appearance="outline" onClick={startChainLive} disabled={busy() || !authed()}>Live</button>}
            >
              <button data-ui="button" data-appearance="outline" onClick={stopChainLive} style="border-color:rgba(240,79,79,0.4);color:var(--bear)">Stop</button>
            </Show>
            </div>{/* end chain-toolbar-scroll */}
            <div class="chain-toolbar-right">
              <span data-ui="badge">{chainData()?.all_expiries?.length || chainExpiries().length || 0} expiries</span>
              <button data-ui="button" data-appearance="stealth" title="Reload" onClick={() => run(loadOptionChain)} disabled={busy()}>↻</button>
              <div class="chain-col-wrap" ref={(el) => registerChainExpiryMenuHost(el)}>
                <button data-ui="button" data-appearance="stealth" title="Columns" onClick={() => setChainColumnMenuOpen((open) => !open)}>⚙</button>
                <Show when={chainColumnMenuOpen()}>
                  <div class="chain-col-popover">
                    <button data-ui="button" data-appearance="stealth" class="w-full" onClick={showAllChainColumns}>All columns</button>
                    <For each={CHAIN_COLUMNS}>
                      {(column) => (
                        <label class="chain-check-row">
                          <input data-ui="checkbox" type="checkbox" checked={chainVisibleColumns()[column.key]} onInput={() => toggleChainColumn(column.key)} />
                          <span>{column.label}</span>
                        </label>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </div>
          </div>

          {/* ── stats bar — Dhan style ── */}
          <div class="chain-stats-bar">
            <div class="chain-stats-left">
              <span class="chain-stats-symbol">{chainData()?.asset || chainSymbol() || "—"}<span class="chain-stats-exch">{chainExchange()}</span></span>
              <div class="chain-stats-price-row">
                <span class="chain-stats-price">{formatIndexValue(chainData()?.cp) || "--"}</span>
                <Show when={chainData()?.ch != null}>
                  <span class={`chain-stats-change ${chainData()?.ch >= 0 ? "up" : "dn"}`}>
                    {chainData()?.ch >= 0 ? "+" : ""}{formatPlain(chainData()?.ch, 2)} ({chainData()?.chp >= 0 ? "+" : ""}{formatPlain(chainData()?.chp, 2)}%)
                  </span>
                </Show>
              </div>
            </div>
            <div class="chain-stats-chips">
              <span class="chain-pill chain-pill--accent">
                <span class="chain-pill-label">ATM IV</span>
                <strong class="chain-pill-value">{chainDerivedStats().atmIv != null ? formatPlain(chainDerivedStats().atmIv, 2) : "--"}</strong>
              </span>
              <span
                class={`chain-pill ${chainIvChangePercent() == null ? "" : chainIvChangePercent() >= 0 ? "chain-pill--up" : "chain-pill--dn"}`}
                title={chainIvChange().baseIv != null
                  ? `vs ${chainIvChange().baseDate} 10:00 ATM IV ${formatPlain(chainIvChange().baseIv, 2)}`
                  : "Waiting for the latest prior-session 10:00 ATM IV"}
              >
                <span class="chain-pill-label">IV Chg</span>
                <strong class="chain-pill-value">{chainIvChangePercent() != null ? formatPercent(chainIvChangePercent()) : "--"}</strong>
              </span>
              <span class={`chain-pill ${chainDerivedStats().pcr == null ? "" : chainDerivedStats().pcr >= 1 ? "chain-pill--up" : "chain-pill--dn"}`}>
                <span class="chain-pill-label">PCR</span>
                <strong class="chain-pill-value">{chainDerivedStats().pcr != null ? formatPlain(chainDerivedStats().pcr, 2) : "--"}</strong>
              </span>
              <span class="chain-pill">
                <span class="chain-pill-label">Lot</span>
                <strong class="chain-pill-value">{chainRefMetrics().marketLot ?? "--"}</strong>
              </span>
              <span class="chain-pill">
                <span class="chain-pill-label">DTE</span>
                <strong class="chain-pill-value">{chainRefMetrics().daysForExpiry ?? "--"}</strong>
              </span>
            </div>
          </div>

          <div class="chain-table-wrap">
            <Show
              when={visibleOptionRows().length}
              fallback={
                <div class="chain-empty">
                  {chainStatus() === "Idle"
                    ? "Load the option chain to view strikes, prices, OI, volume and Greeks."
                    : chainStatus()}
                </div>
              }
            >
              <table class="table table-xs chain-table">
                <thead>
                  <tr class="chain-group-row">
                    <th class="chain-group-call" colspan={visibleCallColumns().length}>CALLS</th>
                    <th class="chain-group-strike">Strike</th>
                    <th class="chain-group-put" colspan={visiblePutColumns().length}>PUTS</th>
                  </tr>
                  <tr>
                    <For each={visibleCallColumns()}>
                      {(key) => {
                        const extra = key === "iv" ? "chain-head-iv" : key === "ltp" ? "chain-head-ltp" : key === "oi_change" ? "chain-head-oi-change" : "";
                        return (
                          <th class={["chain-th-call", extra].filter(Boolean).join(" ")}>
                            {chainColumnLabel(key)}
                          </th>
                        );
                      }}
                    </For>
                    <th class="strike-head">Strike Price</th>
                    <For each={visiblePutColumns()}>
                      {(key) => {
                        const extra = key === "iv" ? "chain-head-iv" : key === "ltp" ? "chain-head-ltp" : key === "oi_change" ? "chain-head-oi-change" : "";
                        return (
                          <th class={["chain-th-put", extra].filter(Boolean).join(" ")}>
                            {chainColumnLabel(key)}
                          </th>
                        );
                      }}
                    </For>
                  </tr>
                </thead>
                <tbody>
                  <For each={visibleOptionRows()}>
                    {(row) => {
                      const tags = oieTagRow(row);
                      return (
                      <tr class={Number(row.strike) === chainStrikeInRupees(chainData()?.atm ?? chainData()?.at_the_money_strike, chainData()) ? "atm-row" : ""}>
                        <For each={visibleCallColumns()}>
                          {(key) => {
                            const showSide = showPremiumSide(row.ce);
                            const props = optionCellProps(showSide ? row.ce : null, key);
                            return (
                              <OptionCell {...props} tone={props.tone === "oi" ? "oi-call" : props.tone}
                                class={["chain-td-call", key === "oi" ? "chain-call-bar" : "", showSide ? "" : "chain-cell-filtered"].filter(Boolean).join(" ")}
                                tag={key === "oi" && tags.ce ? tags.ce : null}
                              />
                            );
                          }}
                        </For>
                        <td class="strike-cell">
                          <span class="strike-val">{formatStrike(row.strike)}</span>
                          <Show when={Number(row.strike) === chainStrikeInRupees(chainData()?.atm ?? chainData()?.at_the_money_strike, chainData()) && chainData()?.cp}>
                            <span class="atm-spot-pill">{formatIndexValue(chainData()?.cp)}</span>
                          </Show>
                        </td>
                        <For each={visiblePutColumns()}>
                          {(key) => {
                            const showSide = showPremiumSide(row.pe);
                            const props = optionCellProps(showSide ? row.pe : null, key);
                            return (
                              <OptionCell {...props} tone={props.tone === "oi" ? "oi-put" : props.tone}
                                class={["chain-td-put", key === "oi" ? "chain-put-bar" : "", showSide ? "" : "chain-cell-filtered"].filter(Boolean).join(" ")}
                                tag={key === "oi" && tags.pe ? tags.pe : null}
                              />
                            );
                          }}
                        </For>
                      </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </Show>
          </div>
        </section>
      </div>
    </section>
  );
}
