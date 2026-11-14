import { describe, expect, it } from "vitest";
import { buildProgram } from "../../../bin/hundredfold.js";

const EXPECTED: Record<string, (string | undefined)[]> = {
  run: ["--root", "--retention-days", "--max-total-gb", "--json"],
  list: ["--root", "--json"],
  verify: ["--json"],
  restore: ["--home", "--force", "--json"],
};

describe("hundredfold backup", () => {
  const backup = () => buildProgram().commands.find((command) => command.name() === "backup")!;

  it("registers run, list, verify and restore", () => {
    expect(backup().commands.map((command) => command.name())).toEqual(Object.keys(EXPECTED));
  });

  it("gives every subcommand its documented flags and its own help", () => {
    for (const command of backup().commands) {
      expect(command.options.map((option) => option.long), command.name()).toEqual(EXPECTED[command.name()]);
      expect(command.helpInformation()).toContain(`Usage: hundredfold backup ${command.name()}`);
      expect(command.description(), command.name()).not.toBe("");
    }
  });

  it("lists every subcommand in `hundredfold backup --help`", () => {
    const help = backup().helpInformation();
    for (const name of Object.keys(EXPECTED)) expect(help, name).toContain(name);
  });

  it("requires a home to restore into", () => {
    const restore = backup().commands.find((command) => command.name() === "restore")!;
    expect(restore.options.find((option) => option.long === "--home")!.required).toBe(true);
  });
});
