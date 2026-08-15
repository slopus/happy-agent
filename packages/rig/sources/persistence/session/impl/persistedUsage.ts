import type { Usage } from "../../../protocol/index.js";

import type { EventId } from "../../../protocol/index.js";
import type { PersistedSessionState } from "../../../session/InMemorySession.js";
import type { SessionUsageSummary } from "../../../session/usage/index.js";

export interface PersistedUsageEnvelope {
    committed: Usage;
    permissionReviews?: PersistedSessionState["permissionReviews"];
    summary?: SessionUsageSummary;
    throughEventId?: EventId;
}

export function parsePersistedUsage(value: string | undefined): PersistedUsageEnvelope | undefined {
    if (value === undefined) return undefined;
    const parsed = JSON.parse(value) as Usage | PersistedUsageEnvelope;
    return "committed" in parsed ? parsed : { committed: parsed };
}
