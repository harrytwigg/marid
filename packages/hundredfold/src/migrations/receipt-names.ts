import { LEGACY_CODENAME, NAMES } from "../shared/codename.js"

/** The record of the skill names the program shipped the last time it synced, under the codename's name. */
export const RECEIPT_FILE = `.${NAMES.codename}-template-skills.json`

/** The receipt an earlier codename wrote: read when this one has none, so a rename does not make every retired skill look like the user's own. */
export const LEGACY_RECEIPT_FILE = `.${LEGACY_CODENAME}-template-skills.json`
