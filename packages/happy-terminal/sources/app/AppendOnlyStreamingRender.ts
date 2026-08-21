import { endsAfterOpeningCodeFence } from "./endsAfterOpeningCodeFence.js";

export class AppendOnlyStreamingRender<Entry extends object> {
    #entries = new WeakMap<Entry, StreamingRenderState>();

    render(options: {
        entry: Entry;
        isStreaming: boolean;
        render: (text: string) => readonly string[];
        text: string;
        width: number;
    }): readonly string[] {
        const rendered = options.render(options.text);
        let state = this.#entries.get(options.entry);
        if (state !== undefined && state.width !== options.width) {
            this.#entries.delete(options.entry);
            state = undefined;
        }

        if (!options.isStreaming) {
            if (state === undefined) return rendered;
            return [...state.frozenLines, ...rendered.slice(state.frozenLines.length)];
        }

        state ??= { frozenLines: [], width: options.width };
        this.#entries.set(options.entry, state);
        const lastCompleteLine = options.text.lastIndexOf("\n");
        if (lastCompleteLine < 0) {
            return [...state.frozenLines, ...rendered.slice(state.frozenLines.length)];
        }

        const stableText = options.text.slice(0, lastCompleteLine + 1);
        const stableRender = options.render(stableText);
        const mutableTailLines = endsAfterOpeningCodeFence(stableText) ? 2 : 1;
        const freezeUntil = Math.min(
            Math.max(0, stableRender.length - mutableTailLines),
            rendered.length,
        );
        for (let index = state.frozenLines.length; index < freezeUntil; index += 1) {
            state.frozenLines.push(rendered[index] ?? "");
        }
        return [...state.frozenLines, ...rendered.slice(state.frozenLines.length)];
    }

    discard(entry: Entry): void {
        this.#entries.delete(entry);
    }

    clear(): void {
        this.#entries = new WeakMap();
    }
}

interface StreamingRenderState {
    frozenLines: string[];
    width: number;
}
