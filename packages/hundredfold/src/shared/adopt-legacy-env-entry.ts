import { adoptLegacyEnv } from "./codename-env.js";

/**
 * Import this first in a process entry. Modules evaluate in import order, so a variable an
 * older install sets under the old codename is already readable under the new one when the
 * modules that read it at load time (the home and the paths built from it) are evaluated.
 */
adoptLegacyEnv(process.env); // footgun: ok the one place a process entry adopts what an older install set, before any module reads it
