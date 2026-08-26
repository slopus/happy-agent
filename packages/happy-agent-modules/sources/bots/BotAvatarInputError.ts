/** The offered bot picture cannot be accepted; the message is safe to show. */
export class BotAvatarInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BotAvatarInputError";
    }
}
