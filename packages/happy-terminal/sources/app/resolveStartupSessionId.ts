import type { HappyAgentClient } from "@slopus/happy-agent-client";

import { loadAgentCatalog, type AgentCatalogEntry } from "../client/loadAgentCatalog.js";
import { HappyTerminalUserError } from "../HappyTerminalUserError.js";
import type { SessionCommandOptions } from "./parseSessionCommand.js";
import { shortenHomePath } from "./shortenHomePath.js";
import type { StartupStatusApp } from "./StartupStatusApp.js";

export interface StartupSessionSelection {
    command: "fork" | "resume";
    selection: SessionCommandOptions;
}

/** Enough history to find the session you meant, few enough to scroll through. */
const MAX_OFFERED_SESSIONS = 50;

/**
 * Turns a `happy-terminal resume` or `happy-terminal fork` invocation into the session the TUI should open, asking the
 * user on the startup screen when the command did not name one. Returns undefined when the user
 * dismisses the picker, which is a decision rather than a failure.
 */
export async function resolveStartupSessionId(options: {
    client: HappyAgentClient;
    cwd: string;
    selection: StartupSessionSelection;
    startup: StartupStatusApp;
}): Promise<string | undefined> {
    const forking = options.selection.command === "fork";
    const { all, last, sessionId: requestedSessionId } = options.selection.selection;
    let sessionId = requestedSessionId;
    if (sessionId === undefined) {
        options.startup.setStatus("Loading saved agents.");
        const listed = await loadAgentCatalog(options.client);
        const matching = all
            ? listed.entries
            : listed.entries.filter((entry) => entry.cwd === options.cwd);
        const agents = [...matching]
            .sort((left, right) => lastActivity(right) - lastActivity(left))
            .slice(0, MAX_OFFERED_SESSIONS);
        if (agents.length === 0) {
            throw all
                ? new HappyTerminalUserError("Happy Terminal has no saved agents yet.", {
                      hint: "Run happy-terminal to start one.",
                  })
                : new HappyTerminalUserError(
                      `Happy Terminal has no saved agents in ${shortenHomePath(options.cwd)}.`,
                      {
                          hint: "Use --all to pick an agent from another directory.",
                      },
                  );
        }
        if (last) {
            sessionId = agents[0]?.agent.id;
            if (sessionId === undefined) {
                throw new HappyTerminalUserError("Happy Terminal has no saved agents yet.", {
                    hint: "Run happy-terminal to start one.",
                });
            }
        } else {
            sessionId = await options.startup.selectSession({
                confirmVerb: forking ? "fork" : "resume",
                agents,
                showDirectory: all,
                subtitle: all
                    ? `${countLabel(agents.length, matching.length)} across every directory.`
                    : `${countLabel(agents.length, matching.length)} in ${shortenHomePath(
                          options.cwd,
                      )}.`,
                title: forking ? "Fork an agent" : "Resume an agent",
            });
            if (sessionId === undefined) return undefined;
        }
    }

    if (!forking) return sessionId;
    throw new HappyTerminalUserError("The Happy Agent API does not expose agent forking.", {
        hint: "Resume the agent or start a new one.",
    });
}

function lastActivity(entry: AgentCatalogEntry): number {
    return entry.agent.updatedAt;
}

/** Says so plainly when older sessions exist beyond the ones being offered. */
function countLabel(shown: number, available: number): string {
    if (shown < available) return `${shown} most recent of ${available} saved agents`;
    return `${shown} saved agent${shown === 1 ? "" : "s"}`;
}
