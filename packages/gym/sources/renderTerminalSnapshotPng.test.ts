import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { renderTerminalSnapshotPng } from "./renderTerminalSnapshotPng.js";
import type { TerminalColorSnapshot, TerminalSnapshot } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
    );
});

describe("renderTerminalSnapshotPng terminal defaults", () => {
    it.each([
        ["dark", rgb(238), rgb(13)],
        ["light", rgb(13), rgb(238)],
    ])("uses Ghostty's %s foreground and background", async (_scheme, foreground, background) => {
        const directory = await mkdtemp(join(tmpdir(), "happy-terminal-gym-screenshot-"));
        temporaryDirectories.push(directory);
        const outputPath = join(directory, "terminal.png");

        await renderTerminalSnapshotPng(snapshot(foreground, background), outputPath);

        const image = sharp(await readFile(outputPath));
        const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
        expect(pixelAt(data, info.channels, 0, 0, info.width)).toEqual(colorChannels(background));
        expect(containsPixel(data, info.channels, colorChannels(foreground))).toBe(true);
    });
});

function colorChannels(color: TerminalColorSnapshot): number[] {
    if (color.kind !== "rgb") throw new Error("Expected an RGB color.");
    return [color.red, color.green, color.blue, 255];
}

function containsPixel(data: Buffer, channels: number, expected: readonly number[]): boolean {
    for (let offset = 0; offset < data.length; offset += channels) {
        if (expected.every((value, index) => data[offset + index] === value)) return true;
    }
    return false;
}

function pixelAt(data: Buffer, channels: number, x: number, y: number, width: number): number[] {
    const offset = (y * width + x) * channels;
    return [...data.subarray(offset, offset + channels)];
}

function rgb(value: number): TerminalColorSnapshot {
    return { kind: "rgb", red: value, green: value, blue: value };
}

function snapshot(
    defaultForeground: TerminalColorSnapshot,
    defaultBackground: TerminalColorSnapshot,
): TerminalSnapshot {
    return {
        cells: [
            {
                background: null,
                bold: false,
                dim: false,
                foreground: null,
                hyperlink: null,
                italic: false,
                text: "█",
                x: 0,
                y: 0,
            },
        ],
        cursor: { visible: false, x: 0, y: 0 },
        defaultBackground,
        defaultForeground,
        outputRevision: 0,
        rows: ["█"],
        scroll: {
            atBottom: true,
            atTop: false,
            bottomDepartureCount: 0,
            offset: 0,
            topArrivalCount: 0,
            totalRows: 1,
            visibleRows: 1,
        },
        synchronizedOutputActive: false,
        text: "█",
        title: "",
    };
}
