import type { ProtocolSession } from "../protocol/index.js";
import { HappyTerminalUserError } from "../HappyTerminalUserError.js";

export function ensureSessionCanResume(session: ProtocolSession): void {
    if (session.agent.type === "subagent") {
        throw new HappyTerminalUserError("Subagent histories are read-only.", {
            hint: "Open the parent session to see this work.",
        });
    }
}
