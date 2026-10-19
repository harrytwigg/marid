import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A throwaway home for the registry database; call before importing anything that opens it. */
export function useTempHome(prefix: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.JINN_HOME = home;
  return home;
}
