export function formatResetDuration(milliseconds: number): string {
    if (milliseconds <= 0) return "now";

    // Countdown remaining time: ceil so the last second still shows "1s".
    const totalSeconds = Math.max(1, Math.ceil(milliseconds / 1000));
    const days = Math.floor(totalSeconds / 86_400);
    const hours = Math.floor((totalSeconds % 86_400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    // Multi-day windows (quota) stay coarse; short live countdowns include seconds.
    if (days > 0) return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
    if (hours > 0) {
        if (minutes === 0) return `${hours}h`;
        return `${hours}h ${minutes}m`;
    }
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}
