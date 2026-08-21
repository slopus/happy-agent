import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { formatStartupStatusUsageRows } from "./formatStartupStatusUsageRows.js";
import type { StartupStatusCardModel } from "./StartupStatusCardModel.js";
import type { TerminalTheme } from "./TerminalTheme.js";
import { truncatePathToWidth } from "./truncatePathToWidth.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const MAX_INNER_WIDTH = 72;

export function renderStartupStatusCard(options: {
    model: StartupStatusCardModel;
    theme: TerminalTheme;
    width: number;
}): string[] {
    if (options.width < 4) return [];
    const innerWidth = Math.min(MAX_INNER_WIDTH, Math.max(0, options.width - 4));
    const rows = statusRows(options.model, innerWidth);
    const rule = "─".repeat(innerWidth + 2);
    return [
        `${DIM}╭${rule}╮${RESET}`,
        ...rows.map((row) => borderedRow(row, innerWidth)),
        `${DIM}╰${rule}╯${RESET}`,
    ];

    function borderedRow(row: string, width: number): string {
        const fitted = truncateToWidth(row, width, "", true);
        const padding = " ".repeat(Math.max(0, width - visibleWidth(fitted)));
        return `${DIM}│ ${RESET}${fitted}${padding}${DIM} │${RESET}`;
    }

    function statusRows(model: StartupStatusCardModel, width: number): string[] {
        if (width === 0) return [];
        const title = `${options.theme.brand}${BOLD}Rig${RESET} ${DIM}${model.version} · ${model.session}${RESET}`;
        const modelValues = [
            model.model,
            model.reasoning,
            model.provider,
            ...(model.fast ? ["Fast"] : []),
        ];
        const usage = formatStartupStatusUsageRows(model.usage, width);
        if (width >= 48) {
            const workspaceWidth = Math.max(
                1,
                width -
                    visibleWidth("Workspace:  · Environment: ") -
                    visibleWidth(model.environment),
            );
            return [
                title,
                "",
                `${DIM}Model:${RESET} ${model.model} ${DIM}· Reasoning:${RESET} ${model.reasoning} ${DIM}· Provider:${RESET} ${model.provider}${model.fast ? ` ${DIM}·${RESET} ${options.theme.brand}Fast${RESET}` : ""}`,
                `${DIM}Workspace:${RESET} ${truncatePathToWidth(model.workspace, workspaceWidth)} ${DIM}· Environment:${RESET} ${model.environment}`,
                `${DIM}Access:${RESET} ${model.access}`,
                ...(model.engineVersion === undefined
                    ? []
                    : [`${DIM}Engine:${RESET} ${model.engineVersion}`]),
                ...usage.map((line) => `${DIM}${line}${RESET}`),
            ];
        }

        return [
            `${options.theme.brand}${BOLD}Rig${RESET} ${DIM}${model.version}${RESET}`,
            `${DIM}${model.session}${RESET}`,
            "",
            ...packValues(modelValues, width),
            truncatePathToWidth(model.workspace, width),
            ...packValues([model.environment, model.access], width),
            ...(model.engineVersion === undefined ? [] : [`Engine ${model.engineVersion}`]),
            ...usage.map((line) => `${DIM}${line}${RESET}`),
        ];
    }

    function packValues(values: readonly string[], width: number): string[] {
        const lines: string[] = [];
        for (const value of values) {
            const current = lines.at(-1);
            if (current !== undefined && visibleWidth(`${current} · ${value}`) <= width) {
                lines[lines.length - 1] = `${current} ${DIM}·${RESET} ${value}`;
            } else {
                lines.push(value);
            }
        }
        return lines;
    }
}
