/**
 * A remote spawn refused because the profile it would run as cannot run
 * unattended (missing, signed out, never accepted bypass-permissions mode),
 * while the host itself is fine. A fallback walk takes this as the login being
 * down and moves on, the way it does an authentication failure, rather than
 * leaving the session on a substitute that cannot start.
 *
 * Its own module so the walk can recognise it without importing the remote
 * stage (engines/remote-stage.ts), which tests mock wholesale.
 */
export class RemoteProfileNotReadyError extends Error {
  override name = "RemoteProfileNotReadyError";
}
