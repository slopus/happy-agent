import type { AgentModuleScope } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { skillNameSchema } from "../Skills.js";

const usageSchema = Type.Array(
    Type.Object({
        name: skillNameSchema,
        count: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    }),
    { maxItems: 1_024 },
);
type Usage = Static<typeof usageSchema>;
export const SKILL_USER_KEY = "usage-user";
const userSchema = Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]);

export async function skillUsageUser(
    ctx: Context,
    scope: AgentModuleScope,
): Promise<string | undefined> {
    const user = await scope.runKV?.read(ctx, SKILL_USER_KEY);
    if (user === undefined || user === null) return undefined;
    if (!Value.Check(userSchema, user)) throw new Error("Stored skill user is invalid.");
    return user;
}

export async function querySkillUsage(
    ctx: Context,
    scope: AgentModuleScope,
    user: string,
): Promise<Usage> {
    const value = await scope.sharedKV.read(ctx, `usage:${user}`);
    if (value === undefined) return [];
    if (!Value.Check(usageSchema, value)) throw new Error("Stored skill usage is invalid.");
    return structuredClone(value);
}

/** One observed activation per person, skill, and run, including a replay or repeated read. */
export async function recordSkillUse(
    ctx: Context,
    scope: AgentModuleScope,
    name: string,
    user: string | undefined,
): Promise<void> {
    if (user === undefined || scope.sharedKV === undefined) return;
    await ctx.inTx(async (tx) => {
        const key = `used:${user}:${name}`;
        if ((await scope.runKV.read(tx, key)) === true) return;
        const usage = await querySkillUsage(tx, scope, user);
        const previous = usage.find((item) => item.name === name);
        if (previous === undefined) usage.push({ name, count: 1 });
        else previous.count = Math.min(Number.MAX_SAFE_INTEGER, previous.count + 1);
        usage.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
        // Retain aggregates, not an ever-growing activation log. Give a newly observed skill
        // a place even when the retained frequent set is full.
        const retained = usage.slice(0, 1_024);
        if (!retained.some((item) => item.name === name)) retained[1_023] = { name, count: 1 };
        await scope.sharedKV.write(tx, `usage:${user}`, retained);
        await scope.runKV.write(tx, key, true);
    });
}
