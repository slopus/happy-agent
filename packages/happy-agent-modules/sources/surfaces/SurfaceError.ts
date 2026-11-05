import type { CalendarEvent, Todo, VaultEntry, VaultUpload } from "@slopus/happy-agent-client";

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
            | { readonly entry: VaultEntry }
            | { readonly upload: VaultUpload },
    ) {
        super(message);
    }
}
