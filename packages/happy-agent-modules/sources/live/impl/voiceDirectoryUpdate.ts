import { sortedJson } from "./sortedJson.js";
import type { VoiceDirectoryRow } from "./VoiceDirectory.js";
import type { VoiceRefs } from "./VoiceRefs.js";

/** One update tells at most this many changes within this many bytes; the rest are counted. */
export const VOICE_DIRECTORY_CHANGES = 20;
export const VOICE_DIRECTORY_UPDATE_BYTES = 4 * 1024;

/**
 * What changed in the directory since voice was last told, as the phones tell it: one silent
 * `directory` line with `added`, `removed`, `renamed`, and `moved`, each in sidebar order. An
 * added conversation sorts into its place by reference; only when it does not does it say
 * `after`. What kept its order among the rest (the longest such run) did not move. Undefined
 * when nothing voice can see changed; status and activity send nothing.
 */
export function voiceDirectoryUpdate(
    told: readonly VoiceDirectoryRow[],
    current: readonly VoiceDirectoryRow[],
    refs: VoiceRefs,
): string | undefined {
    const before = new Map(told.map((row) => [row.agentId, row]));
    const now = new Set(current.map((row) => row.agentId));
    const ref = (agentId: string) => refs.ref(agentId) ?? null;
    const changes: Record<string, unknown>[][] = [[], [], [], []];
    const [added, removed, renamed, moved] = changes as [
        Record<string, unknown>[],
        Record<string, unknown>[],
        Record<string, unknown>[],
        Record<string, unknown>[],
    ];
    const kept = current.filter((row) => before.has(row.agentId));
    const stay = longestOrderedRun(
        kept.map((row) => told.findIndex((item) => item.agentId === row.agentId)),
    );
    for (const [index, row] of current.entries()) {
        const previousRow = index === 0 ? undefined : current[index - 1];
        const after = previousRow === undefined ? null : ref(previousRow.agentId);
        const old = before.get(row.agentId);
        if (old === undefined) {
            const own = ref(row.agentId);
            const next = current[index + 1];
            const nextRef = next === undefined ? null : ref(next.agentId);
            const inPlace =
                own !== null &&
                (after === null || after < own) &&
                (nextRef === null || own < nextRef);
            added.push({
                ...(inPlace ? {} : { after }),
                kind: row.kind,
                ...(row.parents.length === 0 ? {} : { parents: row.parents }),
                ref: own,
                title: row.title,
            });
            continue;
        }
        if (old.title !== row.title) renamed.push({ ref: ref(row.agentId), title: row.title });
        const parentsChanged = old.parents.join("\u0000") !== row.parents.join("\u0000");
        if (parentsChanged || old.kind !== row.kind || !stay.has(kept.indexOf(row)))
            moved.push({
                after,
                ...(old.kind === row.kind ? {} : { kind: row.kind }),
                ...(row.parents.length === 0 ? {} : { parents: row.parents }),
                ref: ref(row.agentId),
            });
    }
    for (const row of told) if (!now.has(row.agentId)) removed.push({ ref: ref(row.agentId) });
    const total = changes.reduce((sum, list) => sum + list.length, 0);
    if (total === 0) return undefined;
    const included: Record<string, unknown>[][] = [[], [], [], []];
    let count = 0;
    const render = (more: number) =>
        sortedJson({
            ...(included[0]!.length === 0 ? {} : { added: included[0] }),
            event: "directory",
            ...(more === 0 ? {} : { more }),
            ...(included[3]!.length === 0 ? {} : { moved: included[3] }),
            ...(included[1]!.length === 0
                ? {}
                : { removed: included[1]!.map((item) => item["ref"]) }),
            ...(included[2]!.length === 0 ? {} : { renamed: included[2] }),
        });
    for (const [list, items] of changes.entries())
        for (const item of items) {
            if (count >= VOICE_DIRECTORY_CHANGES) break;
            included[list]!.push(item);
            if (Buffer.byteLength(render(total - count - 1)) > VOICE_DIRECTORY_UPDATE_BYTES) {
                included[list]!.pop();
                break;
            }
            count++;
        }
    return render(total - count);
}

/** Positions of the longest increasing run, as indexes into the given sequence. */
function longestOrderedRun(sequence: readonly number[]): Set<number> {
    const length: number[] = [];
    const previous: number[] = [];
    let best = -1;
    for (let index = 0; index < sequence.length; index++) {
        length[index] = 1;
        previous[index] = -1;
        for (let earlier = 0; earlier < index; earlier++)
            if (sequence[earlier]! < sequence[index]! && length[earlier]! + 1 > length[index]!) {
                length[index] = length[earlier]! + 1;
                previous[index] = earlier;
            }
        if (best === -1 || length[index]! > length[best]!) best = index;
    }
    const run = new Set<number>();
    for (let index = best; index !== -1; index = previous[index]!) run.add(index);
    return run;
}
