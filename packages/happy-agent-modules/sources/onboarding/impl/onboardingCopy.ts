/**
 * Happy's own words before a provider is connected, in the inline action grammar. The desktop's
 * flow on `chat-onboarding` is the reference for their wording.
 */

/** Happy introduces itself and the example sidebar, and offers to start. */
export function openingMessage(): string {
    return [
        "Hi, I'm Happy, your main agent. I help you get things done with agents of your own. The sidebar shows an example of what that looks like.",
        "",
        "<menu>",
        '  <button data-action="onboarding.start" data-emphasis>Start onboarding</button>',
        "</menu>",
    ].join("\n");
}
