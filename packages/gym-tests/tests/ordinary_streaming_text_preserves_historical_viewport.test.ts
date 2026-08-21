import { afterEach, describe, expect, it } from "vitest";

import {
    captureScrollback,
    createGym,
    waitForTerminalOutput,
    type Gym,
} from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("ordinary streaming text while reading history", () => {
    it("keeps exact upper-middle rows and offset through repeated turns and live chunks", async () => {
        const releaseFinalAnswer = deferred<void>();
        const finalRequestStarted = deferred<void>();
        const responses = [
            historicalResponse("FIRST", 0),
            historicalResponse("SECOND", 45),
            historicalResponse("THIRD", 90),
        ];
        const streamedAnswer = [
            "ORDINARY_STREAM_BEGIN",
            "This is ordinary prose arriving a few characters at a time. It contains no table.",
            "",
            ...Array.from({ length: 96 }, (_, index) => {
                const marker =
                    index === 47
                        ? " ORDINARY_STREAM_MIDDLE"
                        : index === 70
                          ? " ORDINARY_STREAM_LATE"
                          : "";
                return `- Ordinary bullet ${String(index).padStart(3, "0")} remains plain flowing text.${marker}`;
            }),
            "",
            "The final paragraph closes the ordinary streamed response.",
            "ORDINARY_STREAM_END",
        ].join("\n");
        const gym = await createGym({
            cols: 68,
            inference: async (_request, callIndex) => {
                if (callIndex < responses.length) {
                    return { content: [{ text: responses[callIndex] ?? "", type: "text" }] };
                }
                if (callIndex === 3) {
                    finalRequestStarted.resolve();
                    await releaseFinalAnswer.promise;
                    return {
                        completionDelayMs: 800,
                        content: [{ text: streamedAnswer, type: "text" }],
                        textDeltaChunkSize: 19,
                        textDeltaDelayMs: 15,
                    };
                }
                expect(callIndex).toBe(4);
                return { content: [{ text: "ORDINARY_FOLLOW_UP", type: "text" }] };
            },
            rows: 16,
        });
        running.add(gym);

        submit(gym, "Give me a detailed ordinary-text response.");
        await waitForIdleText(gym, "FIRST_HISTORY_END");
        submit(gym, "again");
        await waitForIdleText(gym, "SECOND_HISTORY_END");
        submit(gym, "again");
        await waitForIdleText(gym, "THIRD_HISTORY_END");

        submit(gym, "again");
        await finalRequestStarted.promise;
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Working") &&
                snapshot.scroll.atBottom &&
                snapshot.scroll.totalRows > 150,
            "live status before the ordinary response starts",
            30_000,
        );

        gym.terminal.scrollToTop();
        gym.terminal.scrollBy(70);
        const anchored = await gym.terminal.snapshot();
        expect(anchored.scroll.atTop).toBe(false);
        expect(anchored.scroll.atBottom).toBe(false);
        expect(anchored.scroll.offset).toBeGreaterThan(0);
        expect(anchored.scroll.offset + anchored.scroll.visibleRows).toBeLessThan(
            anchored.scroll.totalRows,
        );
        const anchor = historicalAnchor(anchored);
        await writeProof(gym, "ordinary-01-anchored.png");

        const animated = await gym.terminal.waitUntil(
            (snapshot) => snapshot.outputRevision > anchored.outputRevision,
            "an animated live status redraw while reading history",
            10_000,
        );
        assertHistoricalAnchor(animated, anchor);

        const inputRevisionBeforeHostCopy = gym.terminal.inputRevision;
        const copiedSelection = hostTerminalCopy(anchor.rows.slice(3, 9));
        expect(copiedSelection).toBe(anchor.rows.slice(3, 9).join("\n"));
        const afterHostCopy = await gym.terminal.snapshot();
        expect(gym.terminal.inputRevision).toBe(inputRevisionBeforeHostCopy);
        assertHistoricalAnchor(afterHostCopy, anchor);

        const middleOutput = waitForTerminalOutput(gym, "ORDINARY_STREAM_MIDDLE", 30_000);
        const lateOutput = waitForTerminalOutput(gym, "ORDINARY_STREAM_LATE", 30_000);
        const finalOutput = waitForTerminalOutput(gym, "ORDINARY_STREAM_END", 30_000);
        const output: string[] = [];
        const stopOutputCapture = gym.terminal.onOutput((data) => output.push(data));
        releaseFinalAnswer.resolve();

        await middleOutput;
        const duringStream = await gym.terminal.snapshot();
        expect(duringStream.outputRevision).toBeGreaterThan(animated.outputRevision);
        expect(duringStream.scroll.totalRows).toBeGreaterThan(anchor.totalRows);
        assertHistoricalAnchor(duringStream, anchor);
        await writeProof(gym, "ordinary-02-during-stream.png");

        gym.terminal.scrollToBottom();
        const liveMiddleBottom = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("ORDINARY_STREAM_MIDDLE") &&
                snapshot.text.includes("esc to interrupt") &&
                snapshot.scroll.atBottom,
            "the current live tail during ordinary streaming",
            30_000,
        );
        expect(liveMiddleBottom.text).not.toContain("ORDINARY_STREAM_END");

        gym.terminal.scrollToTop();
        gym.terminal.scrollBy(anchor.offset);
        const anchoredAgain = await gym.terminal.snapshot();
        expect(anchoredAgain.rows).toEqual(anchor.rows);
        expect(anchoredAgain.text).toBe(anchor.text);
        expect(anchoredAgain.scroll.bottomDepartureCount).toBe(anchor.bottomDepartureCount + 1);
        expect(anchoredAgain.scroll.topArrivalCount).toBe(anchor.topArrivalCount + 1);
        const secondAnchor = historicalAnchor(anchoredAgain);

        await lateOutput;
        const lateWhileAnchored = await gym.terminal.snapshot();
        assertHistoricalAnchor(lateWhileAnchored, secondAnchor);

        gym.terminal.scrollToBottom();
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("ORDINARY_STREAM_LATE") &&
                snapshot.text.includes("esc to interrupt") &&
                !snapshot.text.includes("ORDINARY_STREAM_END") &&
                snapshot.scroll.atBottom,
            "the later live tail during the second streaming cycle",
            30_000,
        );
        gym.terminal.scrollToTop();
        gym.terminal.scrollBy(anchor.offset);
        const anchoredThird = await gym.terminal.snapshot();
        expect(anchoredThird.rows).toEqual(anchor.rows);
        expect(anchoredThird.text).toBe(anchor.text);
        expect(anchoredThird.scroll.bottomDepartureCount).toBe(
            secondAnchor.bottomDepartureCount + 1,
        );
        expect(anchoredThird.scroll.topArrivalCount).toBe(secondAnchor.topArrivalCount + 1);

        await finalOutput;
        const afterStream = await gym.terminal.snapshot();
        expect(afterStream.scroll.totalRows).toBeGreaterThan(anchor.totalRows + 40);
        expect(afterStream.rows).toEqual(anchor.rows);
        expect(afterStream.text).toBe(anchor.text);
        await writeProof(gym, "ordinary-03-after-stream.png");

        gym.terminal.scrollToBottom();
        const beforeSettlement = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("ORDINARY_STREAM_END") &&
                snapshot.text.includes("esc to interrupt") &&
                snapshot.scroll.atBottom,
            "the final streamed frame immediately before settlement",
            30_000,
        );
        expect(beforeSettlement.text).toContain("Working");
        const completed = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("ORDINARY_STREAM_END") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "the completed ordinary response after returning to the bottom",
            30_000,
        );
        expect(completed.text).not.toContain("Session interrupted");
        expect(completed.text).not.toContain("�");
        expect(output.join("")).not.toContain("\x1b[3J");
        expect(output.join("")).not.toContain("\x1b[2J\x1b[H");
        stopOutputCapture();

        submit(gym, "Render one later revision after live return-to-bottom transitions.");
        const followUp = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("ORDINARY_FOLLOW_UP") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "a later healthy revision after streamed return-to-bottom",
            30_000,
        );
        expect(followUp.text).not.toContain("�");

        const transcript = await captureScrollback(gym);
        expect(countOccurrences(transcript, "FIRST_HISTORY_BEGIN")).toBe(1);
        expect(countOccurrences(transcript, "SECOND_HISTORY_BEGIN")).toBe(1);
        expect(countOccurrences(transcript, "THIRD_HISTORY_BEGIN")).toBe(1);
        expect(countOccurrences(transcript, "ORDINARY_STREAM_BEGIN")).toBe(1);
        expect(countOccurrences(transcript, "ORDINARY_STREAM_END")).toBe(1);
        expect(countOccurrences(transcript, "ORDINARY_FOLLOW_UP")).toBe(1);

        const agentRequests = gym.inference.requests.filter(
            (request) => !request.options.sessionId?.endsWith(":title"),
        );
        expect(agentRequests).toHaveLength(5);
        expect(
            agentRequests
                .slice(1, 4)
                .map((request) => request.context.messages.at(-1))
                .map((message) => messageText(message?.content)),
        ).toEqual(["again", "again", "again"]);
    }, 120_000);
});

interface HistoricalAnchor {
    bottomDepartureCount: number;
    offset: number;
    rows: readonly string[];
    text: string;
    topArrivalCount: number;
    totalRows: number;
}

function historicalResponse(label: string, start: number): string {
    return [
        `${label}_HISTORY_BEGIN`,
        "Here is another ordinary response with prose and bullets:",
        ...Array.from(
            { length: 45 },
            (_, index) =>
                `- Historical bullet ${String(start + index).padStart(3, "0")} has stable ordinary text.`,
        ),
        `${label}_HISTORY_END`,
    ].join("\n");
}

function historicalAnchor(
    snapshot: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>,
): HistoricalAnchor {
    return {
        bottomDepartureCount: snapshot.scroll.bottomDepartureCount,
        offset: snapshot.scroll.offset,
        rows: snapshot.rows,
        text: snapshot.text,
        topArrivalCount: snapshot.scroll.topArrivalCount,
        totalRows: snapshot.scroll.totalRows,
    };
}

function assertHistoricalAnchor(
    snapshot: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>,
    anchor: HistoricalAnchor,
): void {
    expect(snapshot.scroll.atTop).toBe(false);
    expect(snapshot.scroll.atBottom).toBe(false);
    expect(snapshot.scroll.offset).toBe(anchor.offset);
    expect(snapshot.scroll.bottomDepartureCount).toBe(anchor.bottomDepartureCount);
    expect(snapshot.scroll.topArrivalCount).toBe(anchor.topArrivalCount);
    expect(snapshot.rows).toEqual(anchor.rows);
    expect(snapshot.text).toBe(anchor.text);
}

function hostTerminalCopy(selectedRows: readonly string[]): string {
    // Native selection and Cmd-C belong to the host terminal and send no input bytes to Happy Terminal.
    return selectedRows.join("\n");
}

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
    let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve: (value) => resolvePromise(value as T),
    };
}

async function waitForIdleText(gym: Gym, text: string): Promise<void> {
    await gym.terminal.waitUntil(
        (snapshot) =>
            snapshot.text.includes(text) &&
            snapshot.text.includes("Ask Happy Terminal to do anything") &&
            snapshot.scroll.atBottom,
        `idle response containing ${text}`,
        30_000,
    );
}

async function writeProof(gym: Gym, name: string): Promise<void> {
    const directory = process.env.HAPPY_TERMINAL_GYM_PROOF_DIR;
    if (directory === undefined) return;
    await gym.terminal.screenshot(`${directory}/${name}`);
}

function countOccurrences(text: string, search: string): number {
    return text.split(search).length - 1;
}

function messageText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter(
            (block): block is { text: string } =>
                typeof block === "object" &&
                block !== null &&
                "type" in block &&
                block.type === "text" &&
                "text" in block &&
                typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("\n");
}
