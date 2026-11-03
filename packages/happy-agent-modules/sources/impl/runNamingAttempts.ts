import type { AgentKV } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { delay, type Context } from "@steve.kite/stdlib";

const progressSchema = Type.Object({
    attempts: Type.Integer({ minimum: 0, maximum: 3 }),
    retryAt: Type.Number({ minimum: 0 }),
});

/** A durable naming budget. Null means the owner no longer needs a name; undefined needs fallback. */
export async function runNamingAttempts<Name>(
    ctx: Context,
    kv: AgentKV,
    eligible: () => Promise<boolean>,
    attempt: () => Promise<Name | undefined>,
): Promise<Name | null | undefined> {
    const stored = await kv.read(ctx, "progress");
    if (stored !== undefined && !Value.Check(progressSchema, stored)) {
        throw new Error("The stored automatic naming budget is invalid.");
    }
    let progress = Value.Check(progressSchema, stored) ? stored : { attempts: 0, retryAt: 0 };
    while (progress.attempts < 3) {
        if (progress.retryAt > Date.now()) await delay(ctx, progress.retryAt - Date.now());
        ctx.lifetime?.throwIfAborted();
        // Storage/eligibility errors are not provider failures and must not consume retries.
        if (!(await eligible())) return null;
        // Reserve before calling the provider: restarting cannot reset the inference budget.
        const attempts = progress.attempts + 1;
        progress = { attempts, retryAt: Date.now() + (attempts === 1 ? 1_000 : 5_000) };
        await kv.write(ctx, "progress", progress);
        try {
            const name = await attempt();
            ctx.lifetime?.throwIfAborted();
            if (name !== undefined) return name;
        } catch (error: unknown) {
            ctx.lifetime?.throwIfAborted();
            ctx.log.debug("An automatic naming attempt failed.", { attempt: attempts }, error);
        }
        // Backoff starts after the failed attempt, and remains durable across a shutdown.
        progress = { ...progress, retryAt: Date.now() + (attempts === 1 ? 1_000 : 5_000) };
        await kv.write(ctx, "progress", progress);
    }
    ctx.lifetime?.throwIfAborted();
    return undefined;
}
