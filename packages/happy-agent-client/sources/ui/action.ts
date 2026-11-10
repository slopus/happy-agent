import { Value } from "@sinclair/typebox/value";

import type { UiActionInput, UiActionRequest, UiActionResponse } from "../protocol/ui.js";
import { uiActionDefinition } from "./catalog.js";
import type { ActionNamesOf, PayloadOf, ResultOf, UiBundle } from "./defineUiComponent.js";
import { redactUiValue } from "./secret.js";

/** Where a click lands: the attempt's own ID, and the offer it answers. */
export interface UiActionTarget {
    /**
     * The idempotency key, and the ID of the attempt record: 2–96 characters matching
     * `^[a-z][a-z0-9]+$`. Sending it again replays the stored attempt, so a retry reuses it.
     */
    readonly id: string;
    /** The agent message holding the document. */
    readonly messageId: string;
    readonly uiId: string;
    readonly componentId: string;
}

/**
 * One click as `POST /v0/agents/:agentId/actions` takes it, typed by the component's bundle: the
 * action must be one of the bundle's, and the payload must be that action's.
 *
 * ```ts
 * await client.sendUiAction(
 *     agentId,
 *     uiActionRequest(providerSignInComponent, "submit_token", { token }, target),
 * );
 * ```
 */
export function uiActionRequest<B extends UiBundle, K extends ActionNamesOf<B>>(
    bundle: B,
    action: K,
    payload: PayloadOf<B, K>,
    target: UiActionTarget,
): UiActionRequest {
    return {
        id: target.id,
        messageId: target.messageId,
        uiId: target.uiId,
        componentId: target.componentId,
        action: { type: `${bundle.type}.${action}`, payload: payload as Record<string, unknown> },
    };
}

/**
 * What an action returned, typed by its bundle and checked against the bundle's result schema, or
 * undefined when the response carries none: the action declares no result, the module rejected the
 * click, the attempt was a replay, or a newer server returned a shape this build does not know. A
 * result may hold secrets, so keep it in memory and drop it with the widget.
 */
export function uiActionResult<B extends UiBundle, K extends ActionNamesOf<B>>(
    bundle: B,
    action: K,
    response: Pick<UiActionResponse, "result">,
): ResultOf<B, K> | undefined {
    const schema = bundle.actions[action]?.result;
    if (schema === undefined || response.result === null) return undefined;
    return Value.Check(schema, response.result) ? (response.result as ResultOf<B, K>) : undefined;
}

/**
 * An action with every secret left out of its payload, as the daemon stores it: what a client may
 * keep in state for an attempt in flight. An action this catalog does not know keeps no payload,
 * because nothing says which of its fields are secret.
 */
export function redactUiAction(action: UiActionInput): UiActionInput {
    const found = uiActionDefinition(action.type);
    if (found === undefined) return { type: action.type, payload: {} };
    return {
        type: action.type,
        payload: redactUiValue(found.definition.payload, action.payload) as Record<string, unknown>,
    };
}
