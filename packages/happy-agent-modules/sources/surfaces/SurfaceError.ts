import type {
    CalendarEvent,
    Todo,
    VaultFile,
    VaultFolder,
    VaultItem,
    VaultUpload,
} from "@slopus/happy-agent-client";

export class SurfaceError extends Error {
    constructor(
        readonly code:
            | "invalid_request"
            | "not_found"
            | "conflict"
            | "forbidden"
            | "not_initialized"
            | "name_taken"
            | "hash_mismatch"
            | "too_large",
        message: string,
        /** The authoritative record a conflict reports, under the key its route uses. */
        readonly current?:
            | { readonly todo: Todo }
            | { readonly event: CalendarEvent }
            | { readonly folder: VaultFolder }
            | { readonly file: VaultFile }
            | { readonly item: VaultItem }
            | { readonly upload: VaultUpload },
    ) {
        super(message);
    }
}
