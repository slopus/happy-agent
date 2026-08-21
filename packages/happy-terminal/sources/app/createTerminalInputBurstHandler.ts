const INPUT_BURST_WINDOW_MS = 8;
const SUPPORTED_ALT_INPUTS = new Set(["m", "M", "v", "V", ",", "."]);

export interface TerminalInputBurstHandler {
    dispose(): void;
    handle(data: string): void;
}

export function createTerminalInputBurstHandler(
    onInput: (data: string) => void,
): TerminalInputBurstHandler {
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearTimer = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
    };

    const flush = (): void => {
        clearTimer();
        if (buffer.length === 0) return;
        const input = buffer;
        buffer = "";
        onInput(input);
    };

    const isTextInput = (data: string): boolean => {
        if (data.length === 0) return false;
        for (const character of data) {
            const codePoint = character.codePointAt(0) ?? 0;
            if (codePoint === 9 || codePoint === 10) continue;
            if (codePoint < 32 || codePoint === 127) return false;
        }
        return true;
    };

    return {
        dispose(): void {
            clearTimer();
            buffer = "";
        },
        handle(data: string): void {
            if (!isTextInput(data)) {
                flush();
                if (data.length >= 2 && data === "\x1b".repeat(data.length)) {
                    for (const _escape of data) onInput("\x1b");
                    return;
                }
                if (
                    data.startsWith("\x1b") &&
                    !data.startsWith("\x1b[") &&
                    !data.startsWith("\x1bO") &&
                    !data.startsWith("\x1b]") &&
                    isTextInput(data.slice(1)) &&
                    (data.length > 2 || !SUPPORTED_ALT_INPUTS.has(data.slice(1)))
                ) {
                    onInput("\x1b");
                    buffer = data.slice(1);
                    timer = setTimeout(flush, INPUT_BURST_WINDOW_MS);
                    timer.unref?.();
                    return;
                }
                onInput(data);
                return;
            }

            buffer += data;
            clearTimer();
            timer = setTimeout(flush, INPUT_BURST_WINDOW_MS);
            timer.unref?.();
        },
    };
}
