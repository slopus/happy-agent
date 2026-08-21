import type { RgbColor } from "@earendil-works/pi-tui";

export function nearestXtermColorIndex(target: RgbColor): number {
    const cube = [0, 95, 135, 175, 215, 255];
    let bestIndex = 16;
    let bestDistance = Number.POSITIVE_INFINITY;

    const consider = (index: number, red: number, green: number, blue: number) => {
        const distance = (red - target.r) ** 2 + (green - target.g) ** 2 + (blue - target.b) ** 2;
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    };

    for (let red = 0; red < cube.length; red += 1) {
        for (let green = 0; green < cube.length; green += 1) {
            for (let blue = 0; blue < cube.length; blue += 1) {
                consider(
                    16 + red * 36 + green * 6 + blue,
                    cube[red] ?? 0,
                    cube[green] ?? 0,
                    cube[blue] ?? 0,
                );
            }
        }
    }
    for (let offset = 0; offset < 24; offset += 1) {
        const value = 8 + offset * 10;
        consider(232 + offset, value, value, value);
    }

    return bestIndex;
}
