import type {
    GymInferenceRequest,
    GymInferenceResponse,
} from "../../rig/sources/agent/gym-types.js";
import type { HttpInterceptHandler } from "./InterceptingHttpProxy.js";

export type GymMockResponse =
    | GymInferenceResponse
    | { disconnect: true }
    | {
          body?: string;
          httpStatus: number;
      };

export type GymInferenceHandler = (
    request: GymInferenceRequest,
    callIndex: number,
) => GymMockResponse | Promise<GymMockResponse>;

export type GymFixture =
    | string
    | Uint8Array
    | {
          content: string | Uint8Array;
          mode?: number;
      };

export interface GymOptions {
    args?: readonly string[];
    cols?: number;
    contextWindow?: number;
    dockerSocket?: boolean;
    entrypoint?: readonly [string, ...string[]];
    environment?: Readonly<Record<string, string>>;
    files?: Readonly<Record<string, GymFixture>>;
    homeFiles?: Readonly<Record<string, GymFixture>>;
    httpProxy?: true | { handler?: HttpInterceptHandler };
    image?: string;
    inference?: readonly GymMockResponse[] | GymInferenceHandler | undefined;
    mode?: "docker" | "just-bash";
    modelId?: string;
    mountWorkspaceIntoDockerSession?: boolean;
    permissionMode?: "auto" | "from_config" | "full_access" | "read_only" | "workspace_write";
    providerId?: "bedrock" | "claude" | "codex" | "grok" | "gym" | "kimi";
    providerOverrides?: readonly ("claude" | "codex" | "grok" | "kimi")[];
    rows?: number;
    startupText?: string;
    terminalBackgroundColorQuery?: boolean;
    terminalColorScheme?: TerminalColorScheme;
    timeoutMs?: number;
}

export type TerminalColorScheme = "dark" | "light";

export interface TerminalCursorSnapshot {
    visible: boolean;
    x: number;
    y: number;
}

export type TerminalColorSnapshot =
    | { kind: "palette"; index: number }
    | { kind: "rgb"; red: number; green: number; blue: number };

export interface TerminalCellSnapshot {
    background: TerminalColorSnapshot | null;
    blink?: boolean;
    bold: boolean;
    dim: boolean;
    foreground: TerminalColorSnapshot | null;
    hyperlink: string | null;
    invisible?: boolean;
    inverse?: boolean;
    italic: boolean;
    overline?: boolean;
    strikethrough?: boolean;
    text: string;
    underline?: "curly" | "dashed" | "dotted" | "double" | "none" | "single";
    underlineColor?: TerminalColorSnapshot | null;
    width?: 1 | 2;
    x: number;
    y: number;
}

export interface TerminalScrollSnapshot {
    atBottom: boolean;
    atTop: boolean;
    bottomDepartureCount: number;
    offset: number;
    topArrivalCount: number;
    totalRows: number;
    visibleRows: number;
}

export interface TerminalSnapshot {
    cells: readonly TerminalCellSnapshot[];
    cursor: TerminalCursorSnapshot;
    defaultBackground: TerminalColorSnapshot;
    defaultForeground: TerminalColorSnapshot;
    outputRevision: number;
    rows: readonly string[];
    scroll: TerminalScrollSnapshot;
    synchronizedOutputActive: boolean;
    text: string;
    title: string;
    wrappedRows?: readonly boolean[];
}

export interface TerminalScreenshotOptions {
    background?: string;
    cellHeight?: number;
    cellWidth?: number;
    fontFamily?: string;
    fontSize?: number;
    foreground?: string;
    padding?: number;
}
