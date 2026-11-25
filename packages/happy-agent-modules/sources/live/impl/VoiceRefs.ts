/**
 * A call's conversation references, `s` and a decimal order key, as the phones give them. Compared
 * as text they sort in the sidebar's order (`s4` < `s49` < `s5`). Every conversation listed when
 * the call starts gets the shortest key the list allows; one that comes later gets a key between
 * its neighbours, so no other reference changes. A reference stays its conversation's for the
 * whole call, through renames, moves, and absences, and is never handed to another.
 */
export class VoiceRefs {
    readonly #keys = new Map<string, string>();
    readonly #used = new Set<string>();

    /** References for the call's first directory, in its order. */
    static start(agentIds: readonly string[]): VoiceRefs {
        const refs = new VoiceRefs();
        const keys = initialKeys(agentIds.length);
        agentIds.forEach((agentId, index) => refs.#set(agentId, keys[index]!));
        return refs;
    }

    ref(agentId: string): string | undefined {
        const key = this.#keys.get(agentId);
        return key === undefined ? undefined : `s${key}`;
    }

    /** The agent a reference names, if this call handed it out. */
    agentFor(ref: string): string | undefined {
        for (const [agentId, key] of this.#keys) if (`s${key}` === ref) return agentId;
        return undefined;
    }

    /**
     * Give each conversation of the current directory without a reference one between the
     * references around it, in sidebar order. Returns the newly referenced agents.
     */
    place(agentIds: readonly string[]): string[] {
        const added: string[] = [];
        for (const [index, agentId] of agentIds.entries()) {
            if (this.#keys.has(agentId)) continue;
            const before = agentIds
                .slice(0, index)
                .reverse()
                .map((id) => this.#keys.get(id))
                .find((key) => key !== undefined);
            const after = agentIds
                .slice(index + 1)
                .map((id) => this.#keys.get(id))
                .find((key) => key !== undefined);
            const key =
                keyBetween(before, after, this.#used) ??
                keyBetween(this.#last(), undefined, this.#used);
            if (key === undefined) continue;
            this.#set(agentId, key);
            added.push(agentId);
        }
        return added;
    }

    #last(): string | undefined {
        let last: string | undefined;
        for (const key of this.#used) if (last === undefined || key > last) last = key;
        return last;
    }

    #set(agentId: string, key: string): void {
        this.#keys.set(agentId, key);
        this.#used.add(key);
    }
}

/** `1`…`9` for up to nine; else the fewest digits that hold them, from `11`, never ending in 0. */
function initialKeys(count: number): string[] {
    if (count <= 9) return Array.from({ length: count }, (_, index) => String(index + 1));
    let digits = 2;
    while (Math.floor((10 ** digits - 10 ** (digits - 1)) * 0.9) < count) digits++;
    const keys: string[] = [];
    for (let value = 10 ** (digits - 1) + 1; keys.length < count; value++)
        if (value % 10 !== 0) keys.push(String(value));
    return keys;
}

/**
 * The shortest key strictly between `low` and `high` as text, not ending in 0 and not used: just
 * below `high` when there is one (`4`, `5` gives `49`), else just above `low` (`9` gives `91`).
 */
export function keyBetween(
    low: string | undefined,
    high: string | undefined,
    used: ReadonlySet<string> = new Set(),
): string | undefined {
    if (low !== undefined && high !== undefined && low >= high) return undefined;
    for (let length = 1; length <= 24; length++) {
        let candidate =
            high === undefined ? smallestAbove(low, length) : largestBelow(high, length);
        while (candidate !== undefined) {
            const fits =
                (low === undefined || candidate > low) && (high === undefined || candidate < high);
            if (!fits) break;
            if (!candidate.endsWith("0") && !used.has(candidate)) return candidate;
            candidate = high === undefined ? increment(candidate) : decrement(candidate);
        }
    }
    return undefined;
}

function largestBelow(high: string, length: number): string | undefined {
    if (high.length > length) return high.slice(0, length);
    const lower = decrement(high);
    return lower === undefined ? undefined : lower + "9".repeat(length - high.length);
}

function smallestAbove(low: string | undefined, length: number): string | undefined {
    if (low === undefined) return "0".repeat(length - 1) + "1";
    if (low.length < length) return low + "0".repeat(length - low.length - 1) + "1";
    return increment(low.slice(0, length));
}

function decrement(value: string): string | undefined {
    const digits = [...value].map(Number);
    for (let index = digits.length - 1; index >= 0; index--) {
        if (digits[index]! > 0) {
            digits[index]! -= 1;
            return digits.join("");
        }
        digits[index] = 9;
    }
    return undefined;
}

function increment(value: string): string | undefined {
    const digits = [...value].map(Number);
    for (let index = digits.length - 1; index >= 0; index--) {
        if (digits[index]! < 9) {
            digits[index]! += 1;
            return digits.join("");
        }
        digits[index] = 0;
    }
    return undefined;
}
