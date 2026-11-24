import type { AgentModel } from "@slopus/happy-agent-base";

/** One model a new agent can run, with the choices its creation takes. */
export interface AgentOptionsModel {
    readonly id: string;
    readonly name: string;
    readonly efforts: readonly string[];
    readonly defaultEffort: string;
    readonly serviceTiers?: readonly string[];
}

/** One account a harness runs on. */
export interface AgentOptionsProvider {
    readonly id: string;
    readonly name: string;
    readonly models: readonly AgentOptionsModel[];
    /** Quota windows the account's agent reports, when it reports any. */
    readonly usage?: readonly AgentOptionsUsageWindow[];
}

/** Share of one quota window left, as the agent itself reports it. */
export interface AgentOptionsUsageWindow {
    /** Which models the window covers, in the agent's words, such as "Gemini Models". */
    readonly scope: string;
    /** The window, in the agent's words, such as "Weekly Limit Remaining". */
    readonly window: string;
    readonly remainingPercent: number;
    /** ISO time the window resets, or null when unreported. */
    readonly resetsAt: string | null;
    /** The window reset after it was last read, so its share left is not known yet. */
    readonly unconfirmed?: boolean;
}

/** One harness and the accounts it runs on. */
export interface AgentOptionsHarness {
    readonly id: string;
    readonly name: string;
    readonly providers: readonly AgentOptionsProvider[];
}

/** The harnesses, accounts, and models one agent can create sub-agents with. */
export interface AgentOptions {
    readonly current: { readonly harness: string; readonly provider: string };
    readonly harnesses: readonly AgentOptionsHarness[];
}

export interface AgentOptionsSources {
    readonly harnessOf: (providerId: string, modelId: string) => string;
    readonly harnessName: (harnessId: string) => string;
    readonly providerName: (providerId: string) => string;
}

/** Group `models` by harness and account, in catalog order. */
export function buildAgentOptions(
    models: readonly AgentModel[],
    current: AgentOptions["current"],
    sources: AgentOptionsSources,
): AgentOptions {
    const harnesses = new Map<string, Map<string, AgentOptionsModel[]>>();
    for (const model of models) {
        const harnessId = sources.harnessOf(model.providerId, model.id);
        let providers = harnesses.get(harnessId);
        if (providers === undefined) harnesses.set(harnessId, (providers = new Map()));
        let entries = providers.get(model.providerId);
        if (entries === undefined) providers.set(model.providerId, (entries = []));
        entries.push({
            id: model.id,
            name: model.name,
            efforts: [...model.effortLevels],
            defaultEffort: model.defaultEffort,
            ...(model.serviceTiers === undefined || model.serviceTiers.length === 0
                ? {}
                : { serviceTiers: [...model.serviceTiers] }),
        });
    }
    const listed: AgentOptionsHarness[] = [...harnesses].map(([id, providers]) => ({
        id,
        name: sources.harnessName(id),
        providers: [...providers].map(([providerId, entries]) => ({
            id: providerId,
            name: sources.providerName(providerId),
            models: entries,
        })),
    }));
    return { current, harnesses: listed };
}

/**
 * The options as the text a model reads: one line per model, each complete on its own, so a
 * change is just the lines that differ.
 */
export function formatAgentOptions(options: AgentOptions): string {
    // No line names the agent's own route, so switching models changes nothing here unless
    // what the agent can reach changes.
    const lines = ["Models you can start agents on (* = default effort):"];
    for (const harness of options.harnesses) {
        const models = new Map<string, { model: AgentOptionsModel; providers: string[] }>();
        for (const provider of harness.providers) {
            for (const model of provider.models) {
                const entry = models.get(model.id);
                if (entry === undefined) models.set(model.id, { model, providers: [provider.id] });
                else entry.providers.push(provider.id);
            }
        }
        for (const { model, providers } of models.values()) {
            const efforts = model.efforts
                .map((effort) => (effort === model.defaultEffort ? `${effort}*` : effort))
                .join(", ");
            const tiers =
                model.serviceTiers === undefined ? "" : `; tiers ${model.serviceTiers.join(", ")}`;
            lines.push(
                `${model.id} (${model.name}) on ${harness.id} via ${providers.join(", ")}: ${efforts}${tiers}`,
            );
        }
    }
    if (lines.length === 1) lines.push("None.");
    return lines.join("\n");
}

/**
 * The quota each account reports, one line per account. A window that is out says when it
 * resets; once a weekly or monthly window is out, nothing shorter in its scope matters. A window
 * that reset after it was last read says its share is unknown rather than repeating the old one.
 */
export function formatAgentOptionsUsage(options: AgentOptions): string {
    // An account several harnesses run on, such as a Claude account under Happy and Claude Code,
    // reports once.
    const reported = new Set<string>();
    const lines = options.harnesses.flatMap((harness) =>
        harness.providers.flatMap((provider) => {
            if (reported.has(provider.id)) return [];
            reported.add(provider.id);
            const scopes = new Map<string, AgentOptionsUsageWindow[]>();
            for (const window of provider.usage ?? []) {
                const windows = scopes.get(window.scope) ?? [];
                scopes.set(window.scope, [...windows, window]);
            }
            if (scopes.size === 0) return [];
            const parts = [...scopes].map(([scope, windows]) => {
                const long = windows.filter((window) => /week|month/iu.test(window.window));
                const out = long.filter(
                    (window) => window.remainingPercent <= 0 && window.unconfirmed !== true,
                );
                const shown = (out.length > 0 ? out : windows).toSorted(
                    (a, b) => Number(long.includes(a)) - Number(long.includes(b)),
                );
                return `${scope === "" ? "" : `${scope} `}${shown.map(formatWindow).join(", ")}`;
            });
            return [`${provider.id}: ${parts.join("; ")}`];
        }),
    );
    return lines.length === 0 ? "No account reports usage." : lines.join("\n");
}

function formatWindow(window: AgentOptionsUsageWindow): string {
    const name = /month/iu.test(window.window)
        ? "monthly"
        : /week/iu.test(window.window)
          ? "weekly"
          : /five hour|5-hour/iu.test(window.window)
            ? "5-hour"
            : window.window;
    const resetsAt = window.resetsAt?.replace(/:\d{2}(\.\d+)?Z$/u, "Z") ?? null;
    if (window.unconfirmed === true) return `${name} unknown since its reset at ${resetsAt ?? "?"}`;
    if (window.remainingPercent > 0) return `${name} ${String(window.remainingPercent)}%`;
    return resetsAt === null ? `${name} out` : `${name} out until ${resetsAt}`;
}

/** What changed between two listings, as the lines removed and added. */
export function formatAgentOptionsChange(before: string, after: string): string {
    const old = new Set(before.split("\n"));
    const now = new Set(after.split("\n"));
    return [
        "Your sub-agent options changed:",
        ...[...old].filter((line) => !now.has(line)).map((line) => `- ${line}`),
        ...[...now].filter((line) => !old.has(line)).map((line) => `+ ${line}`),
    ].join("\n");
}
