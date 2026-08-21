/** The reducer's current relationship to the daemon update stream. */
export type HappyReducerConnection = "connecting" | "connected" | "disconnected";

/** The complete state currently maintained by `HappyReducer`. */
export interface HappyReducerState {
    readonly connection: HappyReducerConnection;
}
