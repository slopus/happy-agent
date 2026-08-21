import { isCuid } from "@paralleldrive/cuid2";

/**
 * Accepts an identity a client chose for something it is creating.
 *
 * A client names what it creates so it can show the thing before the daemon
 * answers, and so a retry lands on the entity the first attempt made. The
 * identity therefore has to be one the daemon would have minted itself.
 */
export function clientChosenId(value: string, entity: string): string {
    const id = value.trim();
    if (!isCuid(id)) {
        throw new Error(`The ${entity} ID must be a cuid2 identity.`);
    }
    return id;
}
