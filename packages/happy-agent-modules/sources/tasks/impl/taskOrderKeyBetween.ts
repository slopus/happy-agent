/**
 * A decimal-fraction catalog key strictly between two neighbours, compared lexicographically.
 * Either end may be null, meaning the start or the end of the catalog.
 */
export function taskOrderKeyBetween(before: string | null, after: string | null): string {
    const lower = before ?? "";
    if (after !== null && lower >= after) throw new Error("Task order keys are out of order.");
    let prefix = "";
    for (let index = 0; ; index += 1) {
        const low = index < lower.length ? lower.charCodeAt(index) - 48 : 0;
        const high = after !== null && index < after.length ? after.charCodeAt(index) - 48 : 10;
        if (high - low > 1) return `${prefix}${String(low + Math.floor((high - low) / 2))}`;
        if (high - low === 1)
            return `${prefix}${String(low)}${orderKeyAbove(lower.slice(index + 1))}`;
        prefix += String(low);
    }
}

function orderKeyAbove(rest: string): string {
    let prefix = "";
    for (let index = 0; ; index += 1) {
        const digit = index < rest.length ? rest.charCodeAt(index) - 48 : 0;
        if (digit < 9) return `${prefix}${String(digit + Math.floor((10 - digit) / 2))}`;
        prefix += "9";
    }
}
