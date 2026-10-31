import type { ReplaceTaskSectionsRequest } from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";

import {
    TaskConflictError,
    TaskInputError,
    taskSectionRecordSchema,
    type TaskMemberId,
    type TaskMembership,
    type TaskSectionRecord,
} from "../Task.js";
import { taskOrderKeyBetween } from "./taskOrderKeyBetween.js";

export const MAX_TASK_SECTIONS = 50;

export interface TaskListRow {
    readonly kind: "task" | "section";
    readonly id: string;
    readonly orderKey: string;
}

/** A member's list as one sequence: tasks and section headers by key, a task first on a tie. */
export function taskListRows(
    memberships: readonly Pick<TaskMembership, "taskId" | "orderKey">[],
    sections: readonly Pick<TaskSectionRecord, "id" | "orderKey">[],
): TaskListRow[] {
    return [
        ...memberships.map(({ taskId, orderKey }) => ({
            kind: "task" as const,
            id: taskId,
            orderKey,
        })),
        ...sections.map(({ id, orderKey }) => ({ kind: "section" as const, id, orderKey })),
    ].sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0));
}

/**
 * Apply `PUT /v0/tasks/sections` to one member's list: the sections it ends with, and the
 * memberships that moved with a section. Entries apply in order; one left out is removed and its
 * tasks keep their keys. Moving a section takes the tasks under it along, in order.
 */
export function planTaskSections(
    memberships: readonly TaskMembership[],
    current: readonly TaskSectionRecord[],
    memberId: TaskMemberId,
    entries: ReplaceTaskSectionsRequest["sections"],
): { readonly sections: TaskSectionRecord[]; readonly moved: TaskMembership[] } {
    const ids = new Set(entries.map((entry) => entry.id));
    const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
    if (entries.length > MAX_TASK_SECTIONS) {
        throw new TaskInputError(`A list holds at most ${String(MAX_TASK_SECTIONS)} sections.`);
    }
    if (ids.size !== entries.length || names.size !== entries.length) {
        throw new TaskInputError("Each section needs its own ID and a name no other one has.");
    }
    const keys = new Map(memberships.map((membership) => [membership.taskId, membership.orderKey]));
    const sections = new Map(
        current
            .filter((section) => ids.has(section.id))
            .map((section) => [section.id, { ...section }]),
    );
    for (const entry of entries) {
        const existing = sections.get(entry.id);
        const section = existing ?? {
            id: entry.id,
            memberId,
            name: "",
            orderKey: "",
            collapsed: false,
        };
        Object.assign(section, { name: entry.name, collapsed: entry.collapsed });
        if (existing !== undefined && entry.after === undefined) continue;
        const rows = taskListRows(
            [...keys].map(([taskId, orderKey]) => ({ taskId, orderKey })),
            [...sections.values()],
        );
        // The header and the tasks under it, up to the next header.
        const start = rows.findIndex((row) => row.kind === "section" && row.id === entry.id);
        const block =
            start < 0
                ? [{ kind: "section" as const, id: entry.id, orderKey: "" }]
                : rows.slice(start, endOfSection(rows, start + 1));
        const rest = rows.filter((row) => !block.includes(row));
        const after = entry.after ?? null;
        let anchor = -1;
        if (after !== null) {
            const kind = "taskId" in after ? "task" : "section";
            const id = "taskId" in after ? after.taskId : after.sectionId;
            anchor = rest.findIndex((row) => row.kind === kind && row.id === id);
            if (anchor < 0) {
                throw new TaskConflictError(
                    "A section can only go after a task or section in your list.",
                );
            }
            if (kind === "section") anchor = endOfSection(rest, anchor + 1) - 1;
        }
        sections.set(entry.id, section);
        if (start >= 0 && anchor === start - 1) continue;
        const fresh = orderKeysBetween(
            rest[anchor]?.orderKey ?? null,
            rest[anchor + 1]?.orderKey ?? null,
            block.length,
        );
        block.forEach((row, index) => {
            if (row.kind === "section") section.orderKey = fresh[index]!;
            else keys.set(row.id, fresh[index]!);
        });
    }
    const ordered = [...sections.values()].sort((a, b) =>
        a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id < b.id ? -1 : 1,
    );
    for (const section of ordered) {
        if (!Value.Check(taskSectionRecordSchema, section)) {
            throw new TaskInputError("The sections do not fit in your list.");
        }
    }
    const moved = memberships
        .filter((membership) => keys.get(membership.taskId) !== membership.orderKey)
        .map((membership) => ({ ...membership, orderKey: keys.get(membership.taskId)! }));
    return { sections: ordered, moved };
}

function endOfSection(rows: readonly TaskListRow[], from: number): number {
    const next = rows.findIndex((row, index) => index >= from && row.kind === "section");
    return next < 0 ? rows.length : next;
}

/** `count` keys in order between two neighbours, bisecting so keys grow with the log of count. */
function orderKeysBetween(before: string | null, after: string | null, count: number): string[] {
    if (count === 0) return [];
    const middle = taskOrderKeyBetween(before, after);
    const below = Math.floor((count - 1) / 2);
    return [
        ...orderKeysBetween(before, middle, below),
        middle,
        ...orderKeysBetween(middle, after, count - 1 - below),
    ];
}
