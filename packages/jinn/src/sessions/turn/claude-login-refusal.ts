import { refuseClaudeLaunch } from "../claude-auth-watch.js";
import { resolveEmployeeClaudeProfile } from "../../shared/claude-profile.js";
import { verifyLocalClaudeProfile } from "../../shared/claude-profile-signin.js";
import type { TurnInput } from "./types.js";

/**
 * The Claude login gates, last among a turn's refusals because they read the
 * disk or the Keychain. Undefined when the turn may run.
 */
export function refuseClaudeLogin(input: TurnInput): string | undefined {
  if (input.session.engine !== "claude") return undefined;
  return refuseUnsignedClaudeProfile(input) ?? refuseDeadClaudeLogin(input);
}

/**
 * A named profile must exist and be signed in (FR-054). Unlike the default
 * login's check below, a terminal-view turn is not exempt: a signed-out profile
 * puts Claude Code's login screen in front of the turn.
 */
function refuseUnsignedClaudeProfile(input: TurnInput): string | undefined {
  return verifyLocalClaudeProfile(resolveEmployeeClaudeProfile(input.employee));
}

/**
 * A Claude launch on credentials a launch has already proved dead (or that the
 * disk says cannot work) costs a spawn and a guaranteed `authentication_failed`,
 * and says nothing new. The PTY view's engine override is a human at a terminal
 * who can read the error themselves.
 */
function refuseDeadClaudeLogin(input: TurnInput): string | undefined {
  if (input.engineOverride) return undefined;
  return refuseClaudeLaunch(input.employee);
}
