/** A proven account-pool selection, with a fixed explanation safe for the public API. */
export class VoiceCredentialPoolError extends Error {
    constructor() {
        super(
            "Select an individual OpenAI account for voice; account pools cannot supply voice credentials.",
        );
        this.name = "VoiceCredentialPoolError";
    }
}
