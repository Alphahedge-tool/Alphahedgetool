// Single option-chain table cell with money/compact/plain formatting + OI tag.

import { Show } from "solid-js";
import { formatMoney, formatCompact, formatPlain, number } from "../lib/format.js";

export function OptionCell(props) {
  const n = Number(props.value);
  const hasValue = Number.isFinite(n);
  const display = () => {
    if (props.text != null) return props.text;
    if (!hasValue) return "--";
    if (props.money) return formatMoney(n);
    if (props.indian) return number.format(Math.round(n));
    if (props.compact) return formatCompact(n);
    return `${formatPlain(n, props.digits ?? 2)}${props.suffix || ""}`;
  };
  const className = () => [props.class, props.tone ? `chain-cell-${props.tone}` : ""].filter(Boolean).join(" ");
  // tag may be a plain string ("LB") or { label, strong }
  const tagLabel = () => (typeof props.tag === "object" ? props.tag?.label : props.tag);
  const tagStrong = () => (typeof props.tag === "object" ? props.tag?.strong : false);
  return (
    <td class={className()} style={props.style || ""}>
      {display()}
      <Show when={tagLabel()}>
        <span class={`oi-tag oi-tag-${tagLabel()?.toLowerCase()}${tagStrong() ? " oi-tag-strong" : ""}`}>{tagLabel()}</span>
      </Show>
    </td>
  );
}
