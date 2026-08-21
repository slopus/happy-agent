export function formatCompactTokens(value: number): string {
    if (value < 1_000) return String(value);
    if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
    return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`;
}
