import { Type, type Static } from "@sinclair/typebox";

export type RemoteTerminalStatus = "exited" | "running";

export const remoteTerminalColorSchemeSchema = Type.Union([
    Type.Literal("dark"),
    Type.Literal("light"),
]);

export type RemoteTerminalColorScheme = Static<typeof remoteTerminalColorSchemeSchema>;

export interface RemoteTerminalScope {
    projectId: string;
    workspaceId?: string;
}

export interface CreateRemoteTerminalRequest {
    cols?: number;
    colorScheme?: RemoteTerminalColorScheme;
    command?: string;
    cwd?: string;
    maxScrollback?: number;
    rows?: number;
    shell?: string;
}

export interface RemoteTerminalSummary {
    cols: number;
    colorScheme: RemoteTerminalColorScheme;
    epoch: string;
    exitCode: number | null;
    id: string;
    rows: number;
    status: RemoteTerminalStatus;
}

export interface CreateRemoteTerminalResponse {
    terminal: RemoteTerminalSummary;
}

export interface ListRemoteTerminalsResponse {
    terminals: readonly RemoteTerminalSummary[];
}

export interface ResizeRemoteTerminalRequest {
    cols: number;
    rows: number;
}

export interface RemoteTerminalResponse {
    terminal: RemoteTerminalSummary;
}
