import { execFile } from "node:child_process";

export interface ClipboardCommandResult {
    ok: boolean;
    stdout: Buffer;
}

export async function runClipboardCommand(
    command: string,
    args: readonly string[],
    options: { maxBufferBytes: number; timeoutMs: number },
): Promise<ClipboardCommandResult> {
    return new Promise((resolve) => {
        execFile(
            command,
            [...args],
            {
                encoding: "buffer",
                maxBuffer: options.maxBufferBytes,
                timeout: options.timeoutMs,
            },
            (error, stdout) => {
                if (error !== null) {
                    resolve({ ok: false, stdout: Buffer.alloc(0) });
                    return;
                }
                resolve({
                    ok: true,
                    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
                });
            },
        );
    });
}
