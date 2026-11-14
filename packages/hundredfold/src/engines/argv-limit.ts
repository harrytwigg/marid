/**
 * The operating system's cap on one command-line argument.
 *
 * Linux refuses to exec a program when any single argument is longer than
 * MAX_ARG_STRLEN: 32 pages, 131072 bytes counting the terminating NUL. The
 * interactive engines pass the prompt (and the system prompt) as arguments, so
 * a long enough message makes the exec fail. node-pty forks before it execs,
 * so that failure never reaches the caller as an error: the child prints
 * `execvp(3) failed.: Argument list too long` into the PTY and exits 1, and the
 * turn looks like a process that died for no reason. Checking first turns that
 * into an error that says what happened and what to do about it.
 *
 * macOS has no per-argument cap, only a total one far above any prompt, so a
 * local spawn is checked on Linux only. A remote spawn is always checked: its
 * whole command line is ONE argument to ssh and again to the remote shell, on a
 * host whose limits the gateway does not know.
 */

/** The longest argument, in bytes, that a Linux exec accepts. */
export const MAX_ARGUMENT_BYTES = 131_072 - 1;

export interface OversizedArgument {
  index: number;
  bytes: number;
}

/** The first argument over `limit` bytes of UTF-8, if any. */
export function findOversizedArgument(args: readonly string[], limit = MAX_ARGUMENT_BYTES): OversizedArgument | undefined {
  for (let index = 0; index < args.length; index++) {
    // Cheap pre-check: a string's UTF-8 form is at most three bytes per UTF-16 unit.
    if (args[index].length * 3 <= limit) continue;
    const bytes = Buffer.byteLength(args[index], "utf8");
    if (bytes > limit) return { index, bytes };
  }
  return undefined;
}

/** Whether a spawn on this host is bound by the per-argument cap. */
export function argumentLimitApplies(remote: boolean, platform: NodeJS.Platform = process.platform): boolean {
  return remote || platform === "linux";
}

const grouped = (n: number) => n.toLocaleString("en-US");

/**
 * Throw when an argument is too long to exec. `describe` names the argument
 * at an index for the person reading the error ("the message", "the system
 * prompt"). The message deliberately does not start with "Interrupted": the
 * turn failed, and must be reported as failed rather than as a quiet stop.
 */
export function assertArgumentsFit(engine: string, args: readonly string[], describe: (index: number) => string): void {
  const oversized = findOversizedArgument(args);
  if (!oversized) return;
  throw new Error(
    `${engine} cannot be started with this turn: ${describe(oversized.index)} is ${grouped(oversized.bytes)} bytes, `
    + `over the operating system's limit of ${grouped(MAX_ARGUMENT_BYTES)} bytes for one command-line argument. `
    + "Shorten it, or send the long text as an attached file.",
  );
}

/**
 * "The message", naming whatever was folded into it, so an error about its size
 * says what the person actually sent and not what a fresh session would carry.
 * Falsy entries are skipped, so callers can list every candidate.
 */
export function describeMessage(folded: ReadonlyArray<string | false | null | undefined>): string {
  const parts = folded.filter((part): part is string => !!part);
  return parts.length ? `the message (with ${parts.join(" and ")})` : "the message";
}
