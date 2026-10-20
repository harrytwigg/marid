/**
 * The shapes that travel over the gateway → browser wire. Types only, no
 * behaviour: index.ts owns the event protocol that carries them and the
 * runtime that decodes it.
 *
 * A shape lives here rather than on either side because both sides must agree
 * on it. Declaring it twice is how a gateway and a browser drift apart.
 */
export {};
//# sourceMappingURL=payloads.js.map