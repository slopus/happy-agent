/**
 * The person's sidebar as names, in its order: Happy, the other bots, their tasks, then the
 * Surfaces they joined. IDs travel beside the names only for targeting and are never spoken.
 */
export interface VoiceOutline {
    readonly rows: readonly VoiceOutlineRow[];
}

export interface VoiceOutlineRow {
    readonly name: string;
    /** The conversation the row opens, absent for a Surface. */
    readonly agentId: string | undefined;
}
