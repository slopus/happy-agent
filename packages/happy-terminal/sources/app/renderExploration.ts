import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { ExplorationOperation, ExplorationToolCallPresentation } from "../protocol/index.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const NOT_BOLD = "\x1b[22m";
const DIM = "\x1b[2m";

export function renderExploration(
    presentations: readonly ExplorationToolCallPresentation[],
    options: {
        accent: string;
        brand: string;
        primary: string;
        status: string;
        title: "Awaiting approval" | "Explored" | "Exploring";
        width: number;
    },
): string[] {
    const width = Math.max(1, options.width);
    const header = `${options.status}•${RESET} ${options.brand}${BOLD}${options.title}${NOT_BOLD}${RESET}`;
    const lines = [truncateToWidth(header, width, "", true)];
    const rows = explorationRows(presentations);
    const firstPrefix = `${DIM}  └${RESET} `;
    const continuationPrefix = " ".repeat(visibleWidth(firstPrefix));
    const contentWidth = Math.max(1, width - visibleWidth(firstPrefix));

    for (const [rowIndex, operation] of rows.entries()) {
        const label = operationLabel(operation);
        const labelPrefix = `${options.accent}${label}${RESET} `;
        const detail = operationDetail(operation, options.primary);
        const wrapped = wrapTextWithAnsi(
            detail,
            Math.max(1, contentWidth - visibleWidth(labelPrefix)),
        );
        const visibleRows = wrapped.length === 0 ? [""] : wrapped;
        for (const [lineIndex, line] of visibleRows.entries()) {
            const branchPrefix =
                rowIndex === 0 && lineIndex === 0 ? firstPrefix : continuationPrefix;
            const operationPrefix =
                lineIndex === 0 ? labelPrefix : " ".repeat(visibleWidth(labelPrefix));
            lines.push(
                truncateToWidth(
                    `${branchPrefix}${operationPrefix}${line}${options.primary}`,
                    width,
                    "",
                    true,
                ),
            );
        }
    }
    return lines;
}

function explorationRows(
    presentations: readonly ExplorationToolCallPresentation[],
): ExplorationOperation[] {
    const rows: ExplorationOperation[] = [];
    for (let index = 0; index < presentations.length; index += 1) {
        const presentation = presentations[index];
        if (presentation === undefined) continue;
        if (presentation.operations.every((operation) => operation.kind === "read")) {
            const names: string[] = [];
            while (index < presentations.length) {
                const reads = presentations[index]?.operations;
                if (reads === undefined || !reads.every((operation) => operation.kind === "read")) {
                    break;
                }
                for (const operation of reads) {
                    if (operation.kind === "read" && !names.includes(operation.name)) {
                        names.push(operation.name);
                    }
                }
                index += 1;
            }
            index -= 1;
            rows.push({ kind: "read", name: names.join(", ") });
            continue;
        }
        rows.push(...presentation.operations);
    }
    return rows;
}

function operationLabel(operation: ExplorationOperation): "List" | "Read" | "Search" {
    if (operation.kind === "list") return "List";
    if (operation.kind === "read") return "Read";
    return "Search";
}

function operationDetail(operation: ExplorationOperation, primary: string): string {
    if (operation.kind === "list") return operation.target;
    if (operation.kind === "read") return operation.name;
    if (operation.query !== undefined && operation.path !== undefined) {
        return `${operation.query}${DIM} in ${RESET}${primary}${operation.path}`;
    }
    return operation.query ?? operation.path ?? operation.command;
}
