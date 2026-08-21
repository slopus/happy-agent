import type { GetSessionUsageResponse, SessionUsageGroup } from "../protocol/index.js";
import type { ProviderQuotaWindow } from "@slopus/happy-providers";
import type { CodingAssistantModelChoice } from "./CodingAssistantAgentBackend.js";
import { formatResetDuration } from "./formatResetDuration.js";
import {
    calculateUsedTokens,
    formatUsageTokens,
    formatWorkUsageDetails,
    formatWorkUsageSummary,
} from "./formatWorkUsageSummary.js";
import { humanizeProviderId } from "./humanizeProviderId.js";

export function formatSessionUsageSummary(
    summary: GetSessionUsageResponse,
    modelChoices: readonly CodingAssistantModelChoice[],
    now = Date.now(),
): string {
    const lines: string[] = [];
    const providerIds = distinct([
        ...summary.groups.map((group) => group.providerId),
        ...summary.quotas.map((entry) => entry.providerId),
        summary.currentProviderId,
    ]);

    for (const [providerIndex, providerId] of providerIds.entries()) {
        if (providerIndex > 0) lines.push("");
        lines.push(humanizeProviderId(providerId));
        const providerGroups = summary.groups.filter(
            (candidate) => candidate.providerId === providerId,
        );
        for (const group of providerGroups) {
            lines.push(`  ${modelName(group, modelChoices)}`);
            lines.push(...formatModelUsage(group).map((line) => `    ${line}`));
            if (isCurrentContextGroup(group, summary)) {
                lines.push(`    ${formatContext(summary, modelChoices)}`);
            }
        }
        if (
            summary.context !== undefined &&
            providerId === summary.currentProviderId &&
            providerId === summary.context.providerId &&
            !providerGroups.some((group) => isCurrentContextGroup(group, summary))
        ) {
            lines.push(`  ${contextModelName(summary, modelChoices)}`);
            lines.push(`    ${formatContext(summary, modelChoices)}`);
        }
        const quota = summary.quotas.find((entry) => entry.providerId === providerId)?.quota;
        lines.push(
            "  Account quota",
            `    ${formatQuotaWindow("5-hour", quota?.windows.fiveHour, now)}`,
            `    ${formatQuotaWindow("Weekly", quota?.windows.weekly, now)}`,
        );
    }

    lines.push(
        `Session work: ${formatWorkUsageSummary(totalUsage(summary.groups), {
            usedTokens: summary.groups.reduce(
                (total, group) => total + calculateUsedTokens(group.usage),
                0,
            ),
        })}`,
    );
    return lines.join("\n");
}

function contextModelName(
    summary: GetSessionUsageResponse,
    modelChoices: readonly CodingAssistantModelChoice[],
): string {
    const context = summary.context;
    if (context === undefined) return "Model unavailable";
    return (
        modelChoices.find(
            (choice) =>
                choice.providerId === context.providerId &&
                choice.model.id === context.requestedModelId,
        )?.model.name ?? humanizeIdentifier(context.modelId)
    );
}

function modelName(
    group: SessionUsageGroup,
    modelChoices: readonly CodingAssistantModelChoice[],
): string {
    const choice = modelChoices.find(
        (candidate) =>
            candidate.providerId === group.providerId && candidate.model.id === group.modelId,
    );
    const name = choice?.model.name ?? humanizeIdentifier(group.modelId);
    // Reviews are work the user never asked for directly, so they are named for what they did
    // rather than left to look like another slice of the conversation.
    return group.role === "permission_review" ? `${name} (permission review)` : name;
}

function formatModelUsage(group: SessionUsageGroup): string[] {
    return [
        ...formatWorkUsageDetails(group.usage),
        ...(group.usage.reasoning === undefined
            ? []
            : [`Reasoning: ${formatUsageTokens(group.usage.reasoning)}`]),
        ...(group.providerId === "claude" && group.usage.cost.total > 0
            ? [`Cost: ${formatUsd(group.usage.cost.total)}`]
            : []),
    ];
}

function isCurrentContextGroup(
    group: SessionUsageGroup,
    summary: GetSessionUsageResponse,
): boolean {
    const context = summary.context;
    return (
        context !== undefined &&
        // A reviewer running on the conversation's model still has its own history, so it never
        // owns the context window even when every other field matches.
        group.role === undefined &&
        group.providerId === summary.currentProviderId &&
        group.providerId === context.providerId &&
        group.modelId === context.modelId
    );
}

function formatQuotaWindow(
    label: "5-hour" | "Weekly",
    window: ProviderQuotaWindow | undefined,
    now: number,
): string {
    if (window?.status !== "available") return `${label}: unavailable`;
    const left = Math.max(0, Math.min(100, 100 - window.usedPercent));
    return `${label}: ${formatPercent(left)} left · resets in ${formatResetDuration(window.resetsAt - now)}`;
}

function formatContext(
    summary: GetSessionUsageResponse,
    modelChoices: readonly CodingAssistantModelChoice[],
): string {
    const context = summary.context;
    if (context === undefined) return "Context: unavailable";
    const window = modelChoices.find(
        (choice) =>
            choice.providerId === context.providerId &&
            choice.model.id === context.requestedModelId,
    )?.model.contextWindow;
    const prefix = context.approximate ? "~" : "";
    if (window === undefined) return `Context: ${prefix}${formatUsageTokens(context.totalTokens)}`;
    const percentLeft = Math.max(0, (1 - context.totalTokens / window) * 100);
    return `Context: ${prefix}${formatUsageTokens(context.totalTokens)} / ${formatUsageTokens(window)} · ${formatPercent(percentLeft)} left`;
}

function formatPercent(value: number): string {
    const rounded = Math.round(value * 10) / 10;
    if (Object.is(rounded, -0) || rounded === 0) return "0%";
    const sign = rounded < 0 ? "-" : "";
    const absolute = Math.abs(rounded);
    const number = absolute < 1 ? String(absolute).replace(/^0/u, "") : String(absolute);
    return `${sign}${number}%`;
}

function formatUsd(value: number): string {
    return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

function humanizeIdentifier(value: string): string {
    const name = value.split("/").at(-1) ?? value;
    return name
        .replaceAll(/[-_]+/gu, " ")
        .replace(/\b\p{L}/gu, (character) => character.toUpperCase());
}

function distinct(values: readonly string[]): string[] {
    return [...new Set(values)];
}

function totalUsage(groups: readonly SessionUsageGroup[]): {
    cacheRead: number;
    input: number;
    output: number;
} {
    return groups.reduce(
        (total, group) => ({
            cacheRead: total.cacheRead + group.usage.cacheRead,
            input: total.input + group.usage.input,
            output: total.output + group.usage.output,
        }),
        { cacheRead: 0, input: 0, output: 0 },
    );
}
