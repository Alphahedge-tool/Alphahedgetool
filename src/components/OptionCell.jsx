// Single option-chain table cell with money/compact/plain formatting + OI tag.

import { Show } from "solid-js";
import { formatMoney, formatCompact, formatPlain } from "../lib/format.js";

export function OptionCell(props) {
  const n = Number(props.value);
  const hasValue = Number.isFinite(n);
  const display = () => {
    if (props.text != null) return props.text;
    if (!hasValue) return "--";
    if (props.money) return formatMoney(n);
    if (props.compact) return formatCompact(n);
    return `${formatPlain(n, props.digits ?? 2)}${props.suffix || ""}`;
  };
  const className = () => [props.class, props.tone ? `chain-cell-${props.tone}` : ""].filter(Boolean).join(" ");
  return (
    <td class={className()} style={props.style || ""}>
      {display()}
      <Show when={props.tag}>
        <span class={`oi-tag oi-tag-${props.tag?.toLowerCase()}`}>{props.tag}</span>
      </Show>
    </td>
  );
}
