import type {
    Compute,
    ComputeProcess,
    ComputeProcessExit,
    ComputeProcessStartOptions,
} from "@slopus/happy-agent-compute";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { createMachineTerminalProcessFactory } from "../../sources/terminals/impl/createMachineTerminalProcessFactory.js";

describe("createMachineTerminalProcessFactory", () => {
    it("starts the machine's own shell under a terminal in the folder", async () => {
        const machine = new FakeMachine();
        const terminal = await factoryOn(machine, "linux").start({
            cols: 100,
            cwd: "/home/runner/project",
            rows: 30,
        });

        expect(machine.started).toEqual([
            {
                command: "/bin/sh",
                args: ["-c", 'exec "${SHELL:-/bin/sh}"'],
                cwd: "/home/runner/project",
                environment: expect.objectContaining({
                    PWD: "/home/runner/project",
                    TERM: "xterm-256color",
                    TMUX: null,
                }),
                terminal: { cols: 100, rows: 30, name: "xterm-256color" },
            },
        ]);

        const received: string[] = [];
        terminal.onData((chunk) => received.push(Buffer.from(chunk).toString()));
        machine.process.emit("prompt$ ");
        expect(received).toEqual(["prompt$ "]);
        await expect(terminal.write("ls\r")).resolves.toBe(true);
        expect(machine.process.written).toEqual(["ls\r"]);
    });

    it("hosts a command in the named shell, or in the machine's shell", async () => {
        const named = new FakeMachine();
        await factoryOn(named, "linux").start({
            cols: 80,
            command: "htop",
            cwd: "/srv",
            rows: 24,
            shell: "/bin/zsh",
        });
        expect(named.started[0]).toMatchObject({ command: "/bin/zsh", args: ["-lc", "htop"] });

        const own = new FakeMachine();
        await factoryOn(own, "darwin").start({ cols: 80, command: "htop", cwd: "/srv", rows: 24 });
        expect(own.started[0]).toMatchObject({
            command: "/bin/sh",
            args: ["-c", 'exec "${SHELL:-/bin/sh}" -lc "$1"', "sh", "htop"],
        });

        const windows = new FakeMachine();
        await factoryOn(windows, "win32").start({
            cols: 80,
            command: "dir",
            cwd: "C:\\work",
            rows: 24,
        });
        expect(windows.started[0]).toMatchObject({
            command: "cmd.exe",
            args: ["/d", "/s", "/c", "dir"],
        });
    });

    it("kills with SIGKILL and stops accepting input once the shell has exited", async () => {
        const machine = new FakeMachine();
        const terminal = await factoryOn(machine, "linux").start({ cols: 80, cwd: "/", rows: 24 });

        terminal.kill();
        expect(machine.process.signals).toEqual(["SIGKILL"]);
        machine.process.exit({ exitCode: null, signal: "SIGKILL" });

        await expect(terminal.wait()).resolves.toEqual({ exitCode: null });
        await expect(terminal.write("late")).resolves.toBe(false);
        terminal.kill();
        terminal.resize(120, 40);
        expect(machine.process.signals).toEqual(["SIGKILL"]);
        expect(machine.process.resizes).toEqual([]);
    });

    it("refuses a machine that cannot start programs", async () => {
        const machine = { processes: undefined } as unknown as Compute;
        await expect(
            createMachineTerminalProcessFactory({
                ctx: createRootContext(),
                machine: async () => machine,
                platform: () => "linux",
            }).start({ cols: 80, cwd: "/", rows: 24 }),
        ).rejects.toThrow("This folder's machine cannot open terminals.");
    });
});

function factoryOn(machine: FakeMachine, platform: NodeJS.Platform) {
    return createMachineTerminalProcessFactory({
        ctx: createRootContext(),
        machine: async () => machine as unknown as Compute,
        platform: () => platform,
    });
}

class FakeMachine {
    readonly started: ComputeProcessStartOptions[] = [];
    readonly process = new FakeProcess();
    readonly processes = {
        start: async (_ctx: unknown, options: ComputeProcessStartOptions) => {
            this.started.push(options);
            return this.process as ComputeProcess;
        },
    };
}

class FakeProcess implements ComputeProcess {
    readonly resizes: [number, number][] = [];
    readonly signals: string[] = [];
    readonly written: (string | Uint8Array)[] = [];
    readonly exited: Promise<ComputeProcessExit>;
    #listener: ((chunk: Uint8Array) => void) | undefined;
    #resolve!: (exit: ComputeProcessExit) => void;

    constructor() {
        this.exited = new Promise((resolve) => {
            this.#resolve = resolve;
        });
    }

    emit(text: string): void {
        this.#listener?.(Buffer.from(text));
    }

    exit(exit: ComputeProcessExit): void {
        this.#resolve(exit);
    }

    onStdout(listener: (chunk: Uint8Array) => void): () => void {
        this.#listener = listener;
        return () => {
            this.#listener = undefined;
        };
    }

    onStderr(): () => void {
        return () => undefined;
    }

    async write(data: string | Uint8Array): Promise<boolean> {
        this.written.push(data);
        return true;
    }

    endInput(): void {}

    resize(cols: number, rows: number): void {
        this.resizes.push([cols, rows]);
    }

    signal(signal: string): void {
        this.signals.push(signal);
    }

    pause(): void {}

    resume(): void {}
}
