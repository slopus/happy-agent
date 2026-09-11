/** Decimal fractional keys, with the same lexicographic ordering used by project catalogs. */
export function connectionOrderKeyBetween(before: string | null, after: string | null): string {
    const lower = before ?? "";
    if (after !== null && lower >= after)
        throw new Error("Connection order keys are out of order.");
    let prefix = "";
    for (let index = 0; ; index += 1) {
        const low = index < lower.length ? lower.charCodeAt(index) - 48 : 0;
        const high = after !== null && index < after.length ? after.charCodeAt(index) - 48 : 10;
        if (high - low > 1) return `${prefix}${low + Math.floor((high - low) / 2)}`;
        if (high - low === 1) return `${prefix}${low}${above(lower.slice(index + 1))}`;
        prefix += String(low);
    }
}

function above(rest: string): string {
    let prefix = "";
    for (let index = 0; ; index += 1) {
        const digit = index < rest.length ? rest.charCodeAt(index) - 48 : 0;
        if (digit < 9) return `${prefix}${digit + Math.floor((10 - digit) / 2)}`;
        prefix += "9";
    }
}
