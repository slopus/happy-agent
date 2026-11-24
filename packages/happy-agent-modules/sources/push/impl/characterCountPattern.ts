/**
 * A schema pattern for text of `minimum` to `maximum` characters, none of them in `excluded`,
 * which is written as the inside of a character class.
 *
 * A schema's `maxLength` counts UTF-16 units, so it charges two for a character outside the Basic
 * Multilingual Plane; Happy Cloud counts such a character once, and so does this. Half of a
 * surrogate pair is no character and is refused. The two alternatives never match the same text,
 * so refusing a long string cannot backtrack.
 */
export function characterCountPattern(minimum: number, maximum: number, excluded = ""): string {
    return `^(?:[\\ud800-\\udbff][\\udc00-\\udfff]|[^${excluded}\\ud800-\\udfff]){${minimum},${maximum}}$`;
}
