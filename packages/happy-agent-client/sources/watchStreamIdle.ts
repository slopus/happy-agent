/**
 * Ends a byte stream that goes quiet.
 *
 * The daemon writes a heartbeat at least every 15 seconds on every stream, so a stream that
 * delivers nothing for much longer is dead even when no layer below has noticed, such as behind a
 * load balancer that keeps the client's side open. The returned stream fails with `onIdle`'s error
 * and cancels the original, which releases its connection.
 */
export function watchStreamIdle(
    body: ReadableStream<Uint8Array<ArrayBuffer>>,
    idleMs: number,
    idleError: () => Error,
): ReadableStream<Uint8Array<ArrayBuffer>> {
    const reader = body.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let output: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>> | undefined;
    const arm = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            output?.error(idleError());
            void reader.cancel().catch(() => undefined);
        }, idleMs);
    };
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            output = controller;
            arm();
        },
        async pull(controller) {
            let chunk: ReadableStreamReadResult<Uint8Array<ArrayBuffer>>;
            try {
                chunk = await reader.read();
            } catch (error: unknown) {
                clearTimeout(timer);
                controller.error(error);
                return;
            }
            if (chunk.done) {
                clearTimeout(timer);
                controller.close();
                return;
            }
            arm();
            controller.enqueue(chunk.value);
        },
        async cancel(reason: unknown) {
            clearTimeout(timer);
            await reader.cancel(reason);
        },
    });
}
