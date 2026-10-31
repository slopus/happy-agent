import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type { BotsModule } from "../../bots/index.js";
import type { SurfacesModule } from "../../surfaces/index.js";
import { STANDALONE_TASK_MEMBER, taskMemberIdSchema, type TasksModule } from "../../tasks/index.js";
import type { VoiceOutline, VoiceOutlineRow } from "./VoiceOutline.js";

/**
 * The person's sidebar as the daemon knows it: Happy, every other active bot in catalog order,
 * the active tasks they joined in membership order, and the Surfaces they joined in their member
 * order. Sessions under them are not part of it: the sidebar shows rows, never sessions.
 */
export async function readVoiceOutline(
    ctx: Context,
    modules: {
        readonly bots: BotsModule;
        readonly tasks: TasksModule;
        readonly surfaces: SurfacesModule;
    },
    ownerId: string,
): Promise<VoiceOutline> {
    const happy = await modules.bots.chiefOfStaff(ctx);
    const rows: VoiceOutlineRow[] = [];
    if (happy?.status === "active") rows.push({ name: happy.name, agentId: happy.agentId });
    for (const bot of await modules.bots.list(ctx))
        if (bot.status === "active" && bot.id !== happy?.id)
            rows.push({ name: bot.name, agentId: bot.agentId });
    const tasks = Value.Check(taskMemberIdSchema, ownerId)
        ? await modules.tasks.listForMember(ctx, ownerId)
        : [];
    for (const { task } of tasks)
        if (task.status === "active" && task.agentId !== undefined)
            rows.push({ name: task.name, agentId: task.agentId });
    const userId = ownerId === STANDALONE_TASK_MEMBER ? null : ownerId;
    const surfaces = (await modules.surfaces.list(ctx))
        .flatMap((surface) => {
            const member = surface.members.find((candidate) => candidate.userId === userId);
            return member === undefined ? [] : [{ name: surface.name, orderKey: member.orderKey }];
        })
        .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0));
    for (const surface of surfaces) rows.push({ name: surface.name, agentId: undefined });
    return { rows };
}
