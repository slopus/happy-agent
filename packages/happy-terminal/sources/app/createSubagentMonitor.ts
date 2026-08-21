import {
    matchesKey,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
    type Component,
} from "@earendil-works/pi-tui";

import { errorToMessage } from "../errorToMessage.js";
import type { SessionEvent, SubagentSummary } from "../protocol/index.js";
import { DEFAULT_TERMINAL_THEME } from "./defaultTerminalTheme.js";
import { formatActivityElapsedTime } from "./formatActivityElapsedTime.js";
import { formatCompactTokens } from "./formatCompactTokens.js";
import { humanizeSubagentStatus } from "./humanizeSubagentStatus.js";
import { humanizeToolName } from "./humanizeToolName.js";
import { sanitizeTerminalText } from "./sanitizeTerminalText.js";
import { sortSubagentsForDisplay } from "./sortSubagentsForDisplay.js";
import { subagentElapsedMs } from "./subagentElapsedMs.js";
import { subagentLogMessageText } from "./subagentLogMessageText.js";
import type { TerminalTheme } from "./TerminalTheme.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const MAX_LOG_ENTRIES = 64;
const MAX_LOG_ENTRY_CHARS = 4_000;
const PANEL_CHROME_ROWS = 8;

interface SubagentLogEntry {
    id: string;
    text: string;
}

export interface SubagentMonitor extends Component {
    dispose(): void;
}

export interface CreateSubagentMonitorOptions {
    getHeight(): number;
    getSubagents(): readonly SubagentSummary[];
    modelName(modelId: string): string;
    now?: () => number;
    onCancel(): void;
    onRequestRender?(): void;
    theme?: TerminalTheme;
    watchSubagent(
        sessionId: string,
        signal: AbortSignal,
        onEvent: (event: SessionEvent) => void,
    ): Promise<void>;
}

export function createSubagentMonitor(options: CreateSubagentMonitorOptions): SubagentMonitor {
    return new LiveSubagentMonitor(options);
}

class LiveSubagentMonitor implements SubagentMonitor {
    readonly #getHeight: () => number;
    readonly #getSubagents: () => readonly SubagentSummary[];
    readonly #modelName: (modelId: string) => string;
    readonly #now: () => number;
    readonly #onCancel: () => void;
    readonly #onRequestRender: (() => void) | undefined;
    readonly #theme: TerminalTheme;
    readonly #watchSubagent: CreateSubagentMonitorOptions["watchSubagent"];

    #detailAgentId: string | undefined;
    #entries: SubagentLogEntry[] = [];
    #loading = false;
    #scrollFromBottom = 0;
    #selectedIndex = 0;
    #streamEntryId: string | undefined;
    #terminalFailureRunIds = new Set<string>();
    #watchController: AbortController | undefined;

    constructor(options: CreateSubagentMonitorOptions) {
        this.#getHeight = options.getHeight;
        this.#getSubagents = options.getSubagents;
        this.#modelName = options.modelName;
        this.#now = options.now ?? Date.now;
        this.#onCancel = options.onCancel;
        this.#onRequestRender = options.onRequestRender;
        this.#theme = options.theme ?? DEFAULT_TERMINAL_THEME;
        this.#watchSubagent = options.watchSubagent;
    }

    dispose(): void {
        this.#watchController?.abort();
        this.#watchController = undefined;
    }

    invalidate(): void {}

    render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        const agents = this.#agents();
        const detail = agents.find((agent) => agent.id === this.#detailAgentId);
        const lines =
            detail === undefined
                ? this.#renderList(agents, safeWidth)
                : this.#renderDetail(detail, safeWidth);
        return lines
            .slice(0, Math.max(1, this.#getHeight()))
            .map((line) => this.#surfaceLine(line, safeWidth));
    }

    handleInput(data: string): void {
        const agents = this.#agents();
        const detail = agents.find((agent) => agent.id === this.#detailAgentId);
        if (matchesKey(data, "escape")) {
            if (detail !== undefined) {
                this.#closeDetail();
            } else {
                this.dispose();
                this.#onCancel();
            }
            return;
        }
        if (detail !== undefined) {
            if (matchesKey(data, "up")) {
                this.#scrollFromBottom += 1;
            } else if (matchesKey(data, "down")) {
                this.#scrollFromBottom = Math.max(0, this.#scrollFromBottom - 1);
            }
            return;
        }
        if (matchesKey(data, "up")) {
            this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
            return;
        }
        if (matchesKey(data, "down")) {
            this.#selectedIndex = Math.min(Math.max(0, agents.length - 1), this.#selectedIndex + 1);
            return;
        }
        const selected = agents[this.#selectedIndex];
        if (matchesKey(data, "enter") && selected !== undefined) this.#openDetail(selected.id);
    }

    #agents(): readonly SubagentSummary[] {
        return sortSubagentsForDisplay(this.#getSubagents());
    }

    #openDetail(agentId: string): void {
        this.#watchController?.abort();
        this.#detailAgentId = agentId;
        this.#entries = [];
        this.#loading = true;
        this.#scrollFromBottom = 0;
        this.#streamEntryId = undefined;
        const controller = new AbortController();
        this.#watchController = controller;
        void this.#watchSubagent(agentId, controller.signal, (event) => this.#applyEvent(event))
            .catch((error: unknown) => {
                if (controller.signal.aborted) return;
                this.#appendEntry("stream-error", `Log unavailable: ${errorToMessage(error)}`);
            })
            .finally(() => {
                if (this.#watchController !== controller) return;
                this.#loading = false;
                this.#onRequestRender?.();
            });
    }

    #closeDetail(): void {
        this.#watchController?.abort();
        this.#watchController = undefined;
        this.#detailAgentId = undefined;
        this.#entries = [];
        this.#scrollFromBottom = 0;
        this.#streamEntryId = undefined;
        this.#terminalFailureRunIds.clear();
    }

    #applyEvent(event: SessionEvent): void {
        if (event.sessionId !== this.#detailAgentId) return;
        this.#loading = false;
        if (event.type === "message_submitted" && event.data.source !== "notification") {
            this.#appendEntry(event.data.message.id, subagentLogMessageText(event.data.message));
        } else if (event.type === "agent_message") {
            const text = subagentLogMessageText(event.data.message);
            if (event.data.message.role === "error" && event.data.message.outcome === "failed") {
                this.#terminalFailureRunIds.add(event.data.runId);
                if (this.#terminalFailureRunIds.size > MAX_LOG_ENTRIES) {
                    const oldest = this.#terminalFailureRunIds.values().next().value;
                    if (oldest !== undefined) this.#terminalFailureRunIds.delete(oldest);
                }
            }
            if (text.length > 0) {
                if (this.#streamEntryId !== undefined) {
                    this.#replaceEntry(this.#streamEntryId, text);
                    this.#streamEntryId = undefined;
                } else {
                    this.#appendEntry(event.data.message.id, text);
                }
            }
            for (const block of event.data.message.blocks) {
                if (block.type === "tool_call") {
                    this.#appendEntry(block.id, `Tool · ${humanizeToolName(block.name)}`);
                } else if (block.type === "tool_result") {
                    this.#appendEntry(
                        `result:${block.toolCallId}`,
                        `${block.isError === true ? "Failed" : "Result"} · ${sanitizeTerminalText(block.display)}`,
                    );
                }
            }
        } else if (event.type === "agent_event") {
            const inference = event.data.event;
            if (inference.type === "text_start") {
                this.#streamEntryId = `stream:${event.data.runId}:${inference.contentIndex}`;
                this.#appendEntry(this.#streamEntryId, "");
            } else if (inference.type === "text_delta") {
                this.#streamEntryId ??= `stream:${event.data.runId}:${inference.contentIndex}`;
                this.#appendToEntry(this.#streamEntryId, inference.delta);
            } else if (inference.type === "text_end") {
                this.#streamEntryId ??= `stream:${event.data.runId}:${inference.contentIndex}`;
                this.#replaceEntry(this.#streamEntryId, inference.content);
            } else if (inference.type === "tool_execution_progress") {
                this.#replaceEntry(
                    `progress:${inference.toolCallId}`,
                    `Working · ${sanitizeTerminalText(inference.display)}`,
                );
            } else if (inference.type === "tool_execution_status") {
                this.#replaceEntry(
                    `progress:${inference.toolCallId}`,
                    `Working · ${sanitizeTerminalText(inference.status)}`,
                );
            }
        } else if (event.type === "run_error") {
            if (!this.#terminalFailureRunIds.has(event.data.runId)) {
                this.#appendEntry(`error:${event.id}`, `Error · ${event.data.errorMessage}`);
            }
        }
        this.#onRequestRender?.();
    }

    #appendEntry(id: string, text: string): void {
        const retainedText = text.slice(-MAX_LOG_ENTRY_CHARS);
        const existing = this.#entries.findIndex((entry) => entry.id === id);
        if (existing >= 0) {
            this.#entries[existing] = { id, text: retainedText };
        } else {
            this.#entries.push({ id, text: retainedText });
            if (this.#entries.length > MAX_LOG_ENTRIES) {
                this.#entries.splice(0, this.#entries.length - MAX_LOG_ENTRIES);
            }
        }
    }

    #appendToEntry(id: string, delta: string): void {
        const existing = this.#entries.find((entry) => entry.id === id);
        this.#appendEntry(id, `${existing?.text ?? ""}${delta}`);
    }

    #replaceEntry(id: string, text: string): void {
        this.#appendEntry(id, text);
    }

    #renderList(agents: readonly SubagentSummary[], width: number): string[] {
        const height = Math.max(1, this.#getHeight());
        const itemBudget = Math.max(1, height - 7);
        this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, agents.length - 1));
        const start = Math.max(
            0,
            Math.min(this.#selectedIndex - Math.floor(itemBudget / 2), agents.length - itemBudget),
        );
        const lines = [
            "",
            `  ${this.#theme.brand}${BOLD}Subagents${RESET}${this.#theme.inputBackground}${this.#theme.primary}`,
            `  ${this.#theme.secondary}${agents.length} delegated task${agents.length === 1 ? "" : "s"} · Updates live${RESET}${this.#theme.inputBackground}${this.#theme.primary}`,
            "",
        ];
        if (agents.length === 0) {
            lines.push(`  ${this.#theme.secondary}No delegated work has been started.${RESET}`);
        } else {
            for (const [offset, agent] of agents.slice(start, start + itemBudget).entries()) {
                const index = start + offset;
                const selected = index === this.#selectedIndex;
                const indent = "  ".repeat(Math.max(0, agent.depth - 1));
                const content = `${indent}${selected ? "→ " : "  "}${humanizeSubagentStatus(agent.status)} · ${sanitizeTerminalText(agent.description)} · ${sanitizeTerminalText(this.#modelName(agent.modelId))} · ${formatCompactTokens(agent.totalTokens ?? 0)} context tokens · ${formatActivityElapsedTime(subagentElapsedMs(agent, this.#now()))}`;
                lines.push(
                    selected
                        ? `  ${this.#theme.brand}${truncateToWidth(content, Math.max(1, width - 2))}${RESET}`
                        : `  ${truncateToWidth(content, Math.max(1, width - 2))}`,
                );
            }
        }
        lines.push(
            "",
            `  ${DIM}${this.#theme.secondary}Use ↑/↓ to move · Enter to view log · Esc to close.${RESET}`,
            "",
        );
        return lines;
    }

    #renderDetail(agent: SubagentSummary, width: number): string[] {
        const contentWidth = Math.max(1, width - 6);
        const logLines = this.#entries.flatMap((entry) => {
            const text = sanitizeTerminalText(entry.text.trim());
            if (text.length === 0) return [];
            const wrapped = text
                .split("\n")
                .flatMap((line) => wrapTextWithAnsi(line, contentWidth));
            return wrapped.map((line, index) => `${index === 0 ? "• " : "  "}${line}`);
        });
        const budget = Math.max(1, this.#getHeight() - PANEL_CHROME_ROWS);
        const maxScroll = Math.max(0, logLines.length - budget);
        this.#scrollFromBottom = Math.min(this.#scrollFromBottom, maxScroll);
        const end = Math.max(0, logLines.length - this.#scrollFromBottom);
        const start = Math.max(0, end - budget);
        const visible = logLines.slice(start, end);
        const position =
            logLines.length <= budget
                ? "All log messages visible"
                : `Messages ${start + 1}-${end} of ${logLines.length}`;
        return [
            "",
            `  ${this.#theme.brand}${BOLD}${sanitizeTerminalText(agent.description)}${RESET}${this.#theme.inputBackground}${this.#theme.primary}`,
            `  ${this.#theme.secondary}${humanizeSubagentStatus(agent.status)} · ${sanitizeTerminalText(this.#modelName(agent.modelId))} · ${formatCompactTokens(agent.totalTokens ?? 0)} context tokens${RESET}`,
            "",
            ...(visible.length > 0
                ? visible.map((line) => `  ${line}`)
                : [
                      `  ${this.#theme.secondary}${this.#loading ? "Loading log…" : "No messages yet."}${RESET}`,
                  ]),
            "",
            `  ${DIM}${this.#theme.secondary}Use ↑/↓ to scroll · ${position} · Esc to return.${RESET}`,
            "",
        ];
    }

    #surfaceLine(content: string, width: number): string {
        const restored = content.replaceAll(
            RESET,
            `${RESET}${this.#theme.inputBackground}${this.#theme.primary}`,
        );
        const fitted = truncateToWidth(restored, width, "", true);
        const padding = " ".repeat(Math.max(0, width - visibleWidth(fitted)));
        return `${this.#theme.inputBackground}${this.#theme.primary}${fitted}${padding}${RESET}`;
    }
}
