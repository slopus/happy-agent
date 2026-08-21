export interface HappyTerminalDebugRoot {
    kind: "daemon" | "tui";
    [name: string]: unknown;
}

export function registerHappyTerminalDebugRoot(root: HappyTerminalDebugRoot): void {
    Object.defineProperty(globalThis, "__happyTerminalDebug", {
        configurable: true,
        enumerable: false,
        value: root,
        writable: true,
    });
}
