import { appendFileSync } from "node:fs";

/**
 * Test-only record of exactly what the voice model was told, so a gym can prove an answer was in
 * context before the question. It runs only when `HAPPY_LIVE_CONTEXT_CAPTURE_FILE` names a file;
 * production diagnostics never contain this text. A failed write never affects the call.
 */
export function captureLiveContext(input: {
    kind: "context" | "directory" | "focus" | "reply" | "error" | "outcome" | "greeting" | "status";
    text: string;
    speakable: boolean;
}): void {
    const file = process.env.HAPPY_LIVE_CONTEXT_CAPTURE_FILE;
    if (file === undefined || file === "") return;
    try {
        appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...input })}\n`, { mode: 0o600 });
    } catch {
        // Capture is optional test evidence.
    }
}
