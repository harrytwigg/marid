/**
 * `jinn setup`'s checks for the Muse Code CLI (`muse`), kept out of setup.ts so
 * that file does not grow with every engine it learns to look for.
 */

export interface SetupReporter {
  ok(message: string): void;
  warn(message: string): void;
  fail(message: string): void;
  info(message: string): void;
}

export const MUSE_INSTALL_HINT = "Install Muse Code: curl -fsSL https://dev.meta.ai/install.sh | bash";
export const MUSE_LOGIN_NUDGE = "First run? Run `muse login` to authenticate, or set META_API_KEY.";

/** Report whether `muse` is installed, and how to get it when it is not. */
export function checkMuse(whichBin: (name: string) => string | null, say: Pick<SetupReporter, "ok" | "fail" | "info">): string | null {
  const musePath = whichBin("muse");
  if (musePath) {
    say.ok(`muse found at ${musePath}`);
  } else {
    say.fail("muse not found");
    say.info(MUSE_INSTALL_HINT);
  }
  return musePath;
}

/** Report what `muse --version` printed, or that it failed. */
export function reportMuseVersion(version: string | null, say: Pick<SetupReporter, "ok" | "warn">): void {
  if (version) say.ok(`muse --version: ${version}`);
  else say.warn("muse --version failed");
}
