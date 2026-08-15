import type { Applet } from "@slopus/happy-agent-features";

import type { SlotScope } from "../protocol/SlotProtocol.js";

/** Human-readable rejection shared by write-time slot validation and open-time resolution. */
export function describeAppletScopeNotAllowed(applet: Applet, scope: SlotScope): string {
    const allowed =
        applet.allowedScopes.length === 1
            ? `the ${applet.allowedScopes[0]} scope`
            : `the ${formatList(applet.allowedScopes)} scopes`;
    return `The applet ${JSON.stringify(applet.name)} does not allow the ${scope} scope. It allows only ${allowed}.`;
}

function formatList(values: readonly string[]): string {
    if (values.length === 2) return `${values[0]} and ${values[1]}`;
    return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}