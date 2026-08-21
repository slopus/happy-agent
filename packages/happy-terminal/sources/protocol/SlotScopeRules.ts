import type { SlotName, SlotScope } from "./SlotProtocol.js";

export const allowedSlotScopes = {
    sidebar: ["everywhere"],
    title: ["project", "workspace"],
    "status-line": ["everywhere", "project", "workspace", "session"],
    "above-composer": ["everywhere", "project", "workspace", "session"],
} as const satisfies Record<SlotName, readonly SlotScope[]>;

const slotLabels = {
    sidebar: "sidebar",
    title: "title",
    "status-line": "status line",
    "above-composer": "above composer",
} as const satisfies Record<SlotName, string>;

export const slotScopeMatrixDescription = `Allowed scopes by slot: ${Object.entries(
    allowedSlotScopes,
)
    .map(([slot, scopes]) => `${slotLabels[slot as SlotName]} — ${formatList(scopes, "or")}`)
    .join("; ")}.`;

export function describeAllowedScopesForSlot(slot: SlotName): string {
    const scopes = allowedSlotScopes[slot];
    return scopes.length === 1
        ? `The ${slotLabels[slot]} slot allows only the ${scopes[0]} scope.`
        : `The ${slotLabels[slot]} slot allows only the ${formatList(scopes, "and")} scopes.`;
}

function formatList(values: readonly string[], conjunction: "and" | "or"): string {
    if (values.length < 2) return values.join("");
    if (values.length === 2) return `${values[0]} ${conjunction} ${values[1]}`;
    return `${values.slice(0, -1).join(", ")}, ${conjunction} ${values.at(-1)}`;
}
