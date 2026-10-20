import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "freebuff");

/** A recorded Freebuff screen, one string per row, as the terminal emulator rendered it. */
export function screen(name: string): string[] {
  return fs.readFileSync(path.join(FIXTURES, name), "utf-8").split("\n").map((line) => line.trimEnd());
}
