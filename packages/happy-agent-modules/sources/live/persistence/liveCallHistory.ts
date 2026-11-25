import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

/** What was said aloud in a person's recent calls, as the phones keep it: the latest 30 slots. */
export const VOICE_CALL_SLOTS = 30;
const SLOT_TEXT = 1024;

const slotSchema = Type.Object(
    {
        at: Type.Integer({ minimum: 0 }),
        kind: Type.Union([
            Type.Literal("person"),
            Type.Literal("assistant"),
            Type.Literal("ending"),
        ]),
        text: Type.String({ maxLength: SLOT_TEXT }),
    },
    { additionalProperties: false },
);
const slotsSchema = Type.Array(slotSchema, { maxItems: VOICE_CALL_SLOTS });
export type VoiceCallSlot = Static<typeof slotSchema>;

export async function readCallHistory(ctx: Context, ownerId: string): Promise<VoiceCallSlot[]> {
    const rows = await agentDatabaseRows<{ slots_json: string }>(
        ctx.db,
        sql`SELECT slots_json FROM happy_live_call_history WHERE owner_id = ${ownerId}`,
    );
    if (rows[0] === undefined) return [];
    try {
        const slots: unknown = JSON.parse(rows[0].slots_json);
        return Value.Check(slotsSchema, slots) ? slots : [];
    } catch {
        return [];
    }
}

/** Appends a call's slots, keeping only the latest 30, each cut to 1 KB. */
export async function appendCallHistory(
    ctx: Context,
    ownerId: string,
    slots: readonly VoiceCallSlot[],
    now: number,
): Promise<void> {
    if (slots.length === 0) return;
    const kept = [...(await readCallHistory(ctx, ownerId)), ...slots]
        .map((slot) => ({ ...slot, text: clip(slot.text) }))
        .slice(-VOICE_CALL_SLOTS);
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO happy_live_call_history(owner_id, slots_json, updated_at)
        VALUES (${ownerId}, ${JSON.stringify(kept)}, ${now})
        ON CONFLICT(owner_id) DO UPDATE SET slots_json = excluded.slots_json,
        updated_at = excluded.updated_at`,
    );
}

function clip(text: string): string {
    if (text.length <= SLOT_TEXT) return text;
    return `${text.slice(0, SLOT_TEXT - 1)}…`;
}
