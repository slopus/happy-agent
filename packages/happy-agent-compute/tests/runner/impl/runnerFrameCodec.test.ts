import { describe, expect, it } from "vitest";

import {
    decodeRunnerFrame,
    encodeRunnerFrame,
} from "../../../sources/runner/impl/runnerFrameCodec.js";
import { MAX_RUNNER_FRAME_BYTES } from "../../../sources/runner/runnerProtocol.js";

describe("runner frames", () => {
    it("carry a JSON header and raw bytes without re-encoding them", () => {
        const body = new Uint8Array([0, 255, 10, 13]);
        const frame = encodeRunnerFrame({ type: "response", id: 7, result: {} }, body);

        expect(decodeRunnerFrame(frame)).toEqual({
            header: { type: "response", id: 7, result: {} },
            body,
        });
        expect(frame.byteLength).toBeLessThan(64);
    });

    it("refuse to send a frame larger than the protocol allows", () => {
        const body = new Uint8Array(MAX_RUNNER_FRAME_BYTES);

        expect(() => encodeRunnerFrame({ type: "response", id: 1, result: {} }, body)).toThrow(
            expect.objectContaining({ code: "ERUNNERFRAMETOOLARGE" }),
        );
    });

    it("refuse headers that are cut short, not JSON, or not a protocol frame", () => {
        const notJson = new Uint8Array([0, 0, 0, 3, 123, 123, 123]);
        const unknown = encodeLooseHeader({ type: "shell", command: "rm -rf /" });

        expect(() => decodeRunnerFrame(new Uint8Array([0, 0, 0, 9, 1]))).toThrow("cut short");
        expect(() => decodeRunnerFrame(notJson)).toThrow("not JSON");
        expect(() => decodeRunnerFrame(unknown)).toThrow("does not define");
    });
});

function encodeLooseHeader(header: unknown): Uint8Array {
    const json = new TextEncoder().encode(JSON.stringify(header));
    const frame = new Uint8Array(4 + json.byteLength);
    new DataView(frame.buffer).setUint32(0, json.byteLength, false);
    frame.set(json, 4);
    return frame;
}
