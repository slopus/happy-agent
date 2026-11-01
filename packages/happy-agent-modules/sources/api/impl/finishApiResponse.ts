import type { ServerResponse } from "node:http";

/** Let a transport-changing response flush, but never let a stalled reader hold the change. */
export async function finishApiResponse(response: ServerResponse): Promise<void> {
    if (response.writableFinished || response.destroyed) return;
    await new Promise<void>((resolve) => {
        const done = () => {
            clearTimeout(timer);
            response.off("finish", done);
            response.off("close", done);
            resolve();
        };
        const timer = setTimeout(() => {
            response.destroy();
            done();
        }, 2_000);
        timer.unref();
        response.once("finish", done);
        response.once("close", done);
    });
}
