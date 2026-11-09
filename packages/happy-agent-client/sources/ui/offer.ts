/**
 * Whether an offer still takes an action: the open-offer rule, the same pure function on every
 * server.
 *
 * - An action that is not `once` is always `"open"`.
 * - A `once` action is `"repeat"` when the component already has an accepted `once` answer with
 *   this exact action type and payload: it counts as accepted and changes nothing.
 * - It is `"closed"` when the component has a different accepted `once` answer, or none and a
 *   person's message the model read was recorded in the conversation after the offer's message.
 * - Otherwise it is `"open"`.
 */
export function uiOfferState(
    offer: {
        /** The action's `once`. */
        readonly once: boolean;
        /** The component's accepted `once` answer, its payload with secrets left out, if any. */
        readonly accepted?: { readonly type: string; readonly payload: unknown } | undefined;
        /** Whether a person's message was recorded after the offer's message. */
        readonly personSpokeAfter: boolean;
    },
    action: { readonly type: string; readonly payload: unknown },
): "open" | "repeat" | "closed" {
    if (!offer.once) return "open";
    if (offer.accepted !== undefined) {
        return offer.accepted.type === action.type &&
            canonicalJson(offer.accepted.payload) === canonicalJson(action.payload)
            ? "repeat"
            : "closed";
    }
    return offer.personSpokeAfter ? "closed" : "open";
}

/** JSON with object keys sorted, so two equal payloads compare equal. */
export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (typeof value === "object" && value !== null) {
        return `{${Object.keys(value)
            .sort()
            .map(
                (key) =>
                    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
            )
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}
