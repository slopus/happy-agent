import {
    matchesKey,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
    type Component,
} from "@earendil-works/pi-tui";

import type { SubagentSummary } from "../protocol/index.js";
import type { WorkflowRun } from "../protocol/index.js";
import { humanizeWorkflowName, serializeWorkflowValue } from "./workflowDisplay.js";
import { formatActivityElapsedTime } from "./formatActivityElapsedTime.js";
import { humanizeSubagentStatus } from "./humanizeSubagentStatus.js";
import { humanizeWorkflowStatus } from "./humanizeWorkflowStatus.js";
import { sanitizeTerminalText } from "./sanitizeTerminalText.js";
import { DEFAULT_TERMINAL_THEME } from "./defaultTerminalTheme.js";
import type { TerminalTheme } from "./TerminalTheme.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const MAX_LIST_ITEMS = 8;
const MAX_DETAIL_LOGS = 6;
const MAX_DETAIL_RESULT_LINES = 8;
const MAX_DETAIL_TEXT_CHARS = 4_000;
const MAX_DETAIL_LOG_CHARS = 500;
const MAX_DETAIL_ACTIONS = 8;
const MAX_INSPECTION_LINES = 14;
export interface CreateWorkflowMonitorOptions {
    getSubagents(): readonly SubagentSummary[];
    getWorkflows(): readonly WorkflowRun[];
    initialRunId?: string;
    now?: () => number;
    onCancel(): void;
    onRequestRender?(): void;
    onStop(runId: string): void | Promise<void>;
    theme?: TerminalTheme;
}

export function createWorkflowMonitor(options: CreateWorkflowMonitorOptions): Component {
    return new WorkflowMonitor(options);
}

class WorkflowMonitor implements Component {
    readonly #getSubagents: () => readonly SubagentSummary[];
    readonly #getWorkflows: () => readonly WorkflowRun[];
    readonly #now: () => number;
    readonly #onCancel: () => void;
    readonly #onRequestRender: (() => void) | undefined;
    readonly #onStop: (runId: string) => void | Promise<void>;
    readonly #theme: TerminalTheme;

    #detailRunId: string | undefined;
    #detailSelectionIndex = 0;
    #inspectionScrollOffset = 0;
    #inspectionView: { kind: "agent"; agentId: string } | { kind: "code" } | undefined;
    #selectedIndex = 0;
    #stoppingRunId: string | undefined;

    constructor(options: CreateWorkflowMonitorOptions) {
        this.#detailRunId = options.initialRunId;
        this.#getSubagents = options.getSubagents;
        this.#getWorkflows = options.getWorkflows;
        this.#now = options.now ?? Date.now;
        this.#onCancel = options.onCancel;
        this.#onRequestRender = options.onRequestRender;
        this.#onStop = options.onStop;
        this.#theme = options.theme ?? DEFAULT_TERMINAL_THEME;
    }

    invalidate(): void {}

    render(width: number): string[] {
        const workflows = this.#getWorkflows();
        const detail = workflows.find((workflow) => workflow.runId === this.#detailRunId);
        const lines =
            detail === undefined
                ? this.#renderList(workflows, width)
                : this.#inspectionView?.kind === "code"
                  ? this.#renderCode(detail, width)
                  : this.#inspectionView?.kind === "agent"
                    ? this.#renderAgent(detail, this.#inspectionView.agentId, width)
                    : this.#renderDetail(detail, width);
        return lines.map((line) => this.#surfaceLine(line, Math.max(1, width)));
    }

    handleInput(data: string): void {
        const workflows = this.#getWorkflows();
        const detail = workflows.find((workflow) => workflow.runId === this.#detailRunId);
        if (matchesKey(data, "escape")) {
            if (this.#inspectionView !== undefined) {
                this.#inspectionView = undefined;
                this.#inspectionScrollOffset = 0;
            } else if (detail !== undefined) {
                this.#detailRunId = undefined;
            } else {
                this.#onCancel();
            }
            return;
        }
        if (detail !== undefined) {
            if (this.#inspectionView !== undefined) {
                if (matchesKey(data, "up")) {
                    this.#inspectionScrollOffset = Math.max(0, this.#inspectionScrollOffset - 1);
                } else if (matchesKey(data, "down")) {
                    this.#inspectionScrollOffset += 1;
                }
                return;
            }
            const agents = this.#workflowAgents(detail.runId);
            const actionCount = agents.length + 1;
            if (matchesKey(data, "up")) {
                this.#detailSelectionIndex = Math.max(0, this.#detailSelectionIndex - 1);
                return;
            }
            if (matchesKey(data, "down")) {
                this.#detailSelectionIndex = Math.min(
                    actionCount - 1,
                    this.#detailSelectionIndex + 1,
                );
                return;
            }
            if (matchesKey(data, "enter")) {
                if (this.#detailSelectionIndex === 0) {
                    this.#inspectionView = { kind: "code" };
                } else {
                    const agent = agents[this.#detailSelectionIndex - 1];
                    if (agent !== undefined) {
                        this.#inspectionView = { agentId: agent.id, kind: "agent" };
                    }
                }
                this.#inspectionScrollOffset = 0;
                return;
            }
            if (data.toLowerCase() === "s" && detail.status === "running") {
                this.#stop(detail.runId);
            }
            return;
        }
        if (matchesKey(data, "up")) {
            this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
            return;
        }
        if (matchesKey(data, "down")) {
            this.#selectedIndex = Math.min(
                Math.max(0, workflows.length - 1),
                this.#selectedIndex + 1,
            );
            return;
        }
        if (matchesKey(data, "enter") && workflows[this.#selectedIndex] !== undefined) {
            this.#detailRunId = workflows[this.#selectedIndex]?.runId;
        }
    }

    #renderList(workflows: readonly WorkflowRun[], width: number): string[] {
        const running = workflows.filter((workflow) => workflow.status === "running").length;
        const lines = [
            "",
            `  ${this.#theme.brand}${BOLD}Workflows${RESET}${this.#theme.inputBackground}${this.#theme.primary}`,
            `  ${this.#theme.secondary}${running === 0 ? "No active workflows" : `${running} active`} · Updates live${RESET}${this.#theme.inputBackground}${this.#theme.primary}`,
            "",
        ];
        if (workflows.length === 0) {
            lines.push(
                `  ${this.#theme.secondary}No workflows have been started in this session.${RESET}`,
            );
        } else {
            this.#selectedIndex = Math.min(this.#selectedIndex, workflows.length - 1);
            const start = Math.max(
                0,
                Math.min(
                    this.#selectedIndex - Math.floor(MAX_LIST_ITEMS / 2),
                    workflows.length - MAX_LIST_ITEMS,
                ),
            );
            for (const [offset, workflow] of workflows
                .slice(start, start + MAX_LIST_ITEMS)
                .entries()) {
                const index = start + offset;
                const selected = index === this.#selectedIndex;
                const marker = selected ? "→ " : "  ";
                const phase =
                    workflow.phase === undefined
                        ? ""
                        : ` · ${sanitizeTerminalText(workflow.phase)}`;
                const agents = `${workflow.agentCount} agent${workflow.agentCount === 1 ? "" : "s"}`;
                const label = sanitizeTerminalText(humanizeWorkflowName(workflow.name));
                const content = `${marker}${label}  ${humanizeWorkflowStatus(workflow.status)} · ${agents}${phase}`;
                lines.push(
                    selected
                        ? `  ${this.#theme.brand}${truncateToWidth(content, Math.max(1, width - 2))}${RESET}`
                        : `  ${truncateToWidth(content, Math.max(1, width - 2))}`,
                );
            }
        }
        lines.push(
            "",
            `  ${DIM}${this.#theme.secondary}Use ↑/↓ to move, Enter to open, Esc to close.${RESET}`,
            "",
        );
        return lines;
    }

    #renderDetail(workflow: WorkflowRun, width: number): string[] {
        const contentWidth = Math.max(1, width - 4);
        const finishedAt = workflow.finishedAt ?? this.#now();
        const elapsed = formatActivityElapsedTime(finishedAt - workflow.startedAt);
        const agents = `${workflow.agentCount} agent${workflow.agentCount === 1 ? "" : "s"}`;
        const lines = [
            "",
            `  ${this.#theme.brand}${BOLD}${sanitizeTerminalText(humanizeWorkflowName(workflow.name))}${RESET}${this.#theme.inputBackground}${this.#theme.primary}`,
            `  ${this.#statusColor(workflow.status)}${humanizeWorkflowStatus(workflow.status)}${RESET}${this.#theme.inputBackground}${this.#theme.primary} ${this.#theme.secondary}· ${agents} · ${elapsed}${RESET}`,
            "",
            ...wrapTextWithAnsi(
                sanitizeTerminalText(workflow.description.slice(0, MAX_DETAIL_TEXT_CHARS)),
                contentWidth,
            ).map((line) => `  ${line}`),
        ];
        if (workflow.phase !== undefined) {
            lines.push(
                "",
                `  ${this.#theme.secondary}${workflow.status === "running" ? "Current phase" : "Last phase"}${RESET}`,
                `  ${sanitizeTerminalText(workflow.phase.slice(0, MAX_DETAIL_LOG_CHARS))}`,
            );
        }
        const logs = workflow.logs
            .filter((log) => !log.startsWith("Phase: "))
            .slice(-MAX_DETAIL_LOGS);
        if (logs.length > 0) {
            lines.push(
                "",
                `  ${this.#theme.secondary}Progress${RESET}`,
                ...logs.flatMap((log) =>
                    wrapTextWithAnsi(
                        `• ${sanitizeTerminalText(log.slice(0, MAX_DETAIL_LOG_CHARS))}`,
                        contentWidth,
                    ).map((line) => `  ${line}`),
                ),
            );
        }
        const result =
            workflow.error ??
            (workflow.output === undefined ? undefined : serializeWorkflowValue(workflow.output));
        if (result !== undefined) {
            const resultLines = sanitizeTerminalText(result.slice(0, MAX_DETAIL_TEXT_CHARS))
                .split("\n")
                .flatMap((line) => wrapTextWithAnsi(line, contentWidth))
                .slice(0, MAX_DETAIL_RESULT_LINES);
            lines.push(
                "",
                `  ${this.#theme.secondary}${workflow.error === undefined ? "Result" : "Error"}${RESET}`,
                ...resultLines.map((line) => `  ${line}`),
            );
        }
        const workflowAgents = this.#workflowAgents(workflow.runId);
        const actions = [
            { id: "code", label: "View workflow code" },
            ...workflowAgents.map((agent, index) => ({
                id: agent.id,
                label: `Agent ${index + 1}  ${humanizeSubagentStatus(agent.status)} · ${sanitizeTerminalText(agent.description)}`,
            })),
        ];
        this.#detailSelectionIndex = Math.min(
            this.#detailSelectionIndex,
            Math.max(0, actions.length - 1),
        );
        const actionStart = Math.max(
            0,
            Math.min(
                this.#detailSelectionIndex - Math.floor(MAX_DETAIL_ACTIONS / 2),
                actions.length - MAX_DETAIL_ACTIONS,
            ),
        );
        lines.push("", `  ${this.#theme.secondary}Inspect${RESET}`);
        for (const [offset, action] of actions
            .slice(actionStart, actionStart + MAX_DETAIL_ACTIONS)
            .entries()) {
            const selected = actionStart + offset === this.#detailSelectionIndex;
            const content = `${selected ? "→ " : "  "}${action.label}`;
            lines.push(
                selected
                    ? `  ${this.#theme.brand}${truncateToWidth(content, contentWidth)}${RESET}`
                    : `  ${truncateToWidth(content, contentWidth)}`,
            );
        }
        lines.push(
            "",
            `  ${DIM}${this.#theme.secondary}Use ↑/↓ to move · Enter to open · ${workflow.status === "running" ? "S to stop · " : ""}Esc to return.${RESET}`,
            "",
        );
        return lines;
    }

    #renderCode(workflow: WorkflowRun, width: number): string[] {
        const contentWidth = Math.max(1, width - 4);
        const content = workflow.code.split("\n").flatMap((line, index) => {
            const prefix = `${String(index + 1).padStart(4)}  `;
            const wrapped = wrapTextWithAnsi(
                `${this.#theme.secondary}${prefix}${RESET}${sanitizeTerminalText(line)}`,
                contentWidth,
            );
            return wrapped.length === 0 ? [`${this.#theme.secondary}${prefix}${RESET}`] : wrapped;
        });
        return this.#renderInspection({
            content,
            color: this.#theme.brand,
            kind: "Workflow code",
            title: humanizeWorkflowName(workflow.name),
            width,
        });
    }

    #renderAgent(workflow: WorkflowRun, agentId: string, width: number): string[] {
        const agent = this.#workflowAgents(workflow.runId).find(
            (candidate) => candidate.id === agentId,
        );
        if (agent === undefined) {
            this.#inspectionView = undefined;
            return this.#renderDetail(workflow, width);
        }
        const contentWidth = Math.max(1, width - 4);
        const prompt = agent.prompt ?? "The incoming prompt is not available.";
        const latestText = agent.latestText ?? "No text response yet.";
        const content = [
            `${this.#theme.secondary}Incoming prompt${RESET}`,
            ...wrapTextWithAnsi(sanitizeTerminalText(prompt), contentWidth),
            "",
            `${this.#theme.secondary}Latest message${RESET}`,
            ...wrapTextWithAnsi(sanitizeTerminalText(latestText), contentWidth),
        ];
        return this.#renderInspection({
            content,
            color: "\x1b[36m",
            kind: "Workflow agent",
            status: humanizeSubagentStatus(agent.status),
            title: agent.description,
            width,
        });
    }

    #renderInspection(options: {
        color: string;
        content: readonly string[];
        kind: string;
        status?: string;
        title: string;
        width: number;
    }): string[] {
        const maxOffset = Math.max(0, options.content.length - MAX_INSPECTION_LINES);
        this.#inspectionScrollOffset = Math.min(this.#inspectionScrollOffset, maxOffset);
        const visible = options.content.slice(
            this.#inspectionScrollOffset,
            this.#inspectionScrollOffset + MAX_INSPECTION_LINES,
        );
        const scrollStatus =
            options.content.length <= MAX_INSPECTION_LINES
                ? ""
                : ` · Lines ${this.#inspectionScrollOffset + 1}-${this.#inspectionScrollOffset + visible.length} of ${options.content.length}`;
        return [
            "",
            `  ${options.color}${BOLD}${sanitizeTerminalText(options.kind)}${RESET}${this.#theme.inputBackground}${this.#theme.primary} ${sanitizeTerminalText(options.title)}`,
            ...(options.status === undefined
                ? []
                : [`  ${this.#theme.secondary}${sanitizeTerminalText(options.status)}${RESET}`]),
            "",
            ...visible.map((line) => `  ${line}`),
            "",
            `  ${DIM}${this.#theme.secondary}${options.content.length > MAX_INSPECTION_LINES ? "Use ↑/↓ to scroll" : "All content visible"}${scrollStatus} · Esc to return.${RESET}`,
            "",
        ];
    }

    #workflowAgents(runId: string): SubagentSummary[] {
        const prefix = `workflow_${runId}_`;
        return this.#getSubagents()
            .filter((agent) => agent.taskName?.startsWith(prefix) === true)
            .sort((left, right) => {
                const leftIndex = workflowAgentIndex(left.taskName);
                const rightIndex = workflowAgentIndex(right.taskName);
                return leftIndex - rightIndex || left.createdAt - right.createdAt;
            });
    }

    #statusColor(status: WorkflowRun["status"]): string {
        if (status === "completed") return this.#theme.success;
        if (status === "error") return this.#theme.error;
        if (status === "running") return this.#theme.brand;
        return this.#theme.warning;
    }

    #stop(runId: string): void {
        if (this.#stoppingRunId !== undefined) return;
        this.#stoppingRunId = runId;
        void Promise.resolve(this.#onStop(runId)).finally(() => {
            this.#stoppingRunId = undefined;
            this.#onRequestRender?.();
        });
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

function workflowAgentIndex(taskName: string | undefined): number {
    const index = Number(taskName?.split("_").at(-1));
    return Number.isFinite(index) ? index : Number.MAX_SAFE_INTEGER;
}
