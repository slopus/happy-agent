import type { VoiceCallSlot } from "../persistence/liveCallHistory.js";
import type { VoiceTurn, VoiceTurns } from "./readVoiceTurns.js";
import { voiceAgo, voiceClock, voiceWhen } from "./voiceTimes.js";
import type { VoiceDirectoryRow } from "./readVoiceDirectory.js";

/**
 * GPT-Live takes at most 8,192 tokens of startup input, so the startup items are 24 KB rather than
 * the phones' 32 KB first context; the directory and recap keep the phones' own budgets inside it.
 * The phones' prompt goes beside their context; where the voice prompt is itself a startup item,
 * it comes out of this budget.
 */
export const VOICE_CONTEXT_BYTES = 24 * 1024;
export const VOICE_DIRECTORY_ROWS = 100;
const DIRECTORY_BYTES = 12 * 1024;
const RECAP_BYTES = 8 * 1024;
const RECAP_MINIMUM_BYTES = 512;
const LINE_BYTES = 1024;

export interface VoiceRowState {
    readonly working: boolean;
    readonly needsPerson: boolean;
    readonly lastActivityAt: number | undefined;
    /** The pending question it asks the person, when it asks one. */
    readonly question?: string | undefined;
    /** Why its last run failed, when it did. */
    readonly failed?: string | undefined;
}

export interface VoiceCallContextInput {
    /** When the call started; the context is never a live clock. */
    readonly now: number;
    readonly timeZone: string;
    readonly focusRevision: number;
    readonly recap: readonly VoiceCallSlot[];
    readonly onScreen:
        | {
              readonly row: VoiceDirectoryRow;
              readonly ref: string | undefined;
              readonly state: VoiceRowState;
              readonly turns: VoiceTurns;
          }
        | undefined;
    /**
     * Every conversation in sidebar order. When not all fit, those with the lowest `rank` are
     * kept: the one on screen and the ones followed, then the most recently active.
     */
    readonly rows: readonly {
        readonly row: VoiceDirectoryRow;
        readonly ref: string | undefined;
        readonly state: VoiceRowState | undefined;
        readonly rank: number;
    }[];
    /** The whole context's budget; the startup budget when omitted. */
    readonly bytes?: number;
}

/**
 * The call's first context as plain text, in the phones' parts: the time and focus revision, the
 * recap of earlier calls, the conversation on screen with its last turns, then the directory with
 * references, status and last activity. When it is too big the older turns give way first, then
 * the directory's tail, then the recap's older lines, and the newest turn last. `listed` is the
 * conversations the directory names: the only ones voice holds a reference to.
 */
export function renderVoiceCallContext(input: VoiceCallContextInput): {
    readonly text: string;
    readonly listed: readonly string[];
} {
    let turns = input.onScreen?.turns.turns.length ?? 0;
    let rows = input.rows.length;
    let recapBytes = RECAP_BYTES;
    let listed: readonly string[] = [];
    const render = () => {
        const directory = renderDirectory(input, rows);
        listed = directory.listed;
        return [
            `Now: ${voiceClock(input.now, input.timeZone)} (the person's local time, ${input.timeZone})\nfocusRevision: ${String(input.focusRevision)}`,
            renderRecap(input, recapBytes),
            renderOnScreen(input, turns),
            directory.text,
        ]
            .filter((part) => part !== "")
            .join("\n\n");
    };
    let text = render();
    const budget = input.bytes ?? VOICE_CONTEXT_BYTES;
    while (Buffer.byteLength(text) > budget) {
        if (turns > 1) turns--;
        else if (rows > 0) rows = Math.max(0, rows - 5);
        else if (recapBytes > RECAP_MINIMUM_BYTES)
            recapBytes = Math.max(RECAP_MINIMUM_BYTES, recapBytes / 2);
        else if (turns > 0) turns--;
        else break;
        text = render();
    }
    return { text: cutBytes(text, budget), listed };
}

function renderRecap(input: VoiceCallContextInput, bytes: number): string {
    if (input.recap.length === 0) return "";
    const lines = input.recap.map((slot) =>
        cutLine(
            slot.kind === "ending"
                ? `- ${voiceAgo(input.now - slot.at)}: ${slot.text}`
                : `- ${voiceAgo(input.now - slot.at)}, ${slot.kind === "person" ? "the person" : "you"}: ${slot.text}`,
        ),
    );
    const kept: string[] = [];
    let size = 0;
    for (const line of [...lines].reverse()) {
        if (size + Buffer.byteLength(line) + 1 > bytes) break;
        kept.unshift(line);
        size += Buffer.byteLength(line) + 1;
    }
    return [
        "Previous voice conversation (earlier calls, oldest first):",
        ...(kept.length < lines.length ? ["Older lines aren't shown."] : []),
        ...kept,
    ].join("\n");
}

function renderOnScreen(input: VoiceCallContextInput, turns: number): string {
    const screen = input.onScreen;
    if (screen === undefined)
        return "On screen: no conversation (home, Settings or another screen).";
    const { row, ref, state } = screen;
    const shown = turns === 0 ? [] : screen.turns.turns.slice(-turns);
    const lines = [
        `On screen: ${describe(row, ref)}${row.parents.length === 0 ? "" : `, under ${row.parents.join(" > ")}`}`,
        `Working: ${state.working ? "yes" : "no"}. Needs the person: ${state.needsPerson ? "yes" : "no"}.`,
        ...(state.question === undefined ? [] : [`It asks: ${short(state.question, 1024)}`]),
        ...(state.failed === undefined
            ? []
            : [`Its last run failed: ${short(state.failed, 1024)}`]),
        ...(screen.turns.lastPersonAt === undefined
            ? []
            : [
                  `Last message from the person: ${voiceWhen(screen.turns.lastPersonAt, input.now, input.timeZone)}`,
              ]),
        ...(screen.turns.lastReplyAt === undefined
            ? []
            : [`Last reply: ${voiceWhen(screen.turns.lastReplyAt, input.now, input.timeZone)}`]),
    ];
    if (turns === 0 || shown.length === 0)
        lines.push(
            screen.turns.turns.length === 0
                ? "Nothing has been said here yet."
                : "Older turns aren't shown.",
        );
    else {
        lines.push("Last turns, oldest first:");
        if (screen.turns.older || shown.length < screen.turns.turns.length)
            lines.push("Older turns aren't shown.");
        shown.forEach((turn, index) => lines.push(renderTurn(turn, index + 1, input)));
    }
    return lines.join("\n");
}

function renderTurn(turn: VoiceTurn, number: number, input: VoiceCallContextInput): string {
    const when = (at: number | undefined) =>
        at === undefined ? "" : ` (${voiceAgo(input.now - at)})`;
    const parts: string[] = [];
    if (turn.message !== undefined)
        parts.push(
            `${turn.from === "agent" ? "Another agent" : "The person"}${when(turn.message.at)}: ${turn.message.text}`,
        );
    if (turn.reply !== undefined) parts.push(`Agent${when(turn.reply.at)}: ${turn.reply.text}`);
    return `${String(number)}. ${parts.join("\n   ")}`;
}

function renderDirectory(
    input: VoiceCallContextInput,
    count: number,
): { text: string; listed: string[] } {
    const title = "Conversations in the app, in the sidebar's order:";
    const order = input.rows
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => a.entry.rank - b.entry.rank || a.index - b.index);
    const kept = new Set<number>();
    for (const { index } of order) {
        if (kept.size >= Math.min(count, VOICE_DIRECTORY_ROWS)) break;
        kept.add(index);
        if (Buffer.byteLength(directoryLines(input, kept).join("\n")) > DIRECTORY_BYTES - 128)
            kept.delete(index);
    }
    const lines = [title, ...directoryLines(input, kept)];
    const rest = input.rows.length - kept.size;
    if (kept.size === 0 && rest === 0) lines.push("(none)");
    if (rest > 0)
        lines.push(`… and ${String(rest)} more not listed; ask your backend to find one by name.`);
    return {
        text: lines.join("\n"),
        listed: input.rows.flatMap(({ row }, index) => (kept.has(index) ? [row.agentId] : [])),
    };
}

/** The kept conversations in sidebar order, each preceded by the headings it newly enters. */
function directoryLines(input: VoiceCallContextInput, kept: ReadonlySet<number>): string[] {
    const lines: string[] = [];
    let open: readonly string[] = [];
    input.rows.forEach(({ row, ref, state }, index) => {
        if (!kept.has(index)) return;
        const headings = row.headings ?? [];
        const path = headings.map((heading) => `${heading.kind}:${heading.title}`);
        let shared = 0;
        while (shared < Math.min(path.length, open.length) && path[shared] === open[shared])
            shared++;
        for (let depth = shared; depth < headings.length; depth++)
            lines.push(
                cutLine(
                    `${"  ".repeat(Math.min(depth, 8))}- ${oneLine(headings[depth]!.title)} — ${headings[depth]!.kind}`,
                ),
            );
        open = path;
        const details = [
            ...(state?.working === true ? ["working"] : []),
            ...(state?.needsPerson === true
                ? [
                      state.question === undefined
                          ? "needs the person"
                          : `needs the person (asks: ${short(state.question, 160)})`,
                  ]
                : []),
            ...(state?.failed === undefined ? [] : [`failed (${short(state.failed, 160)})`]),
            ...(state?.lastActivityAt === undefined
                ? []
                : [
                      `last active ${voiceAgo(input.now - state.lastActivityAt)} (${voiceClock(state.lastActivityAt, input.timeZone).slice(11, 16)})`,
                  ]),
        ];
        lines.push(
            cutLine(
                `${"  ".repeat(Math.min(row.parents.length, 8))}- ${describe(row, ref)}${details.length === 0 ? "" : `, ${details.join(", ")}`}`,
            ),
        );
    });
    return lines;
}

function describe(row: VoiceDirectoryRow, ref: string | undefined): string {
    return `${oneLine(row.title)} — ${row.kind}${ref === undefined ? "" : `, ref ${ref}`}`;
}

function oneLine(text: string): string {
    return text.replace(/\s+/g, " ").trim().slice(0, 256) || "Untitled";
}

function short(text: string, characters: number): string {
    const line = oneLine(text);
    return line.length <= characters ? line : `${line.slice(0, characters - 1)}…`;
}

function cutLine(line: string): string {
    return Buffer.byteLength(line) <= LINE_BYTES ? line : `${cutBytes(line, LINE_BYTES - 3)}…`;
}

/** At most `bytes` of UTF-8, cut on a character boundary so nothing is ever half a character. */
export function cutBytes(text: string, bytes: number): string {
    const encoded = Buffer.from(text);
    if (encoded.length <= bytes) return text;
    let end = Math.max(0, bytes);
    while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
    return encoded.subarray(0, end).toString("utf8");
}

/**
 * Text within `bytes` of UTF-8, cut after a whole word and ending `… (cut, N more words)`, as the
 * phones cut what voice is told. Text that fits is returned unchanged.
 */
export function cutWords(text: string, bytes: number): string {
    if (Buffer.byteLength(text) <= bytes) return text;
    const room = bytes - 32;
    if (room <= 0) return `${cutBytes(text, bytes - 3)}…`;
    const words = text.split(/(\s+)/);
    let kept = "";
    let index = 0;
    for (; index < words.length; index++) {
        const next = kept + words[index]!;
        if (Buffer.byteLength(next) > room) break;
        kept = next;
    }
    if (kept.trim() === "") kept = cutBytes(text, room);
    const left = words.slice(index).filter((word) => word.trim() !== "").length;
    return `${kept.trimEnd()} … (cut, ${String(Math.max(1, left))} more words)`;
}

/** JSON on one line with every object's keys sorted, as the phones send their context lines. */
export function sortedJson(value: unknown): string {
    return JSON.stringify(value, (_key, item: unknown) =>
        item !== null && typeof item === "object" && !Array.isArray(item)
            ? Object.fromEntries(
                  Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
                      a < b ? -1 : a > b ? 1 : 0,
                  ),
              )
            : item,
    );
}
