import os from "node:os";
import { describe, expect, it } from "vitest";
import type { Employee, JinnConfig } from "../../shared/types.js";
import { findTerminalHost, listTerminalHosts } from "../hosts.js";

function employee(name: string, extra: Partial<Employee> = {}): Employee {
  return { name, displayName: name, department: "general", rank: "employee", engine: "claude", model: "opus", persona: "", ...extra } as Employee;
}

const remote = { root: "/srv/jinn-work", mount: "/mnt/jinn-home" };

describe("listTerminalHosts", () => {
  it("offers the gateway alone when nothing else is configured", () => {
    const list = listTerminalHosts({}, []);
    expect(list.enabled).toBe(true);
    expect(list.hosts).toEqual([{ id: "local", label: os.hostname(), kind: "local", detail: "This gateway" }]);
    expect(list.problems).toEqual([]);
  });

  it("derives one host per distinct employee destination, starting in remote.root", () => {
    const list = listTerminalHosts({ remote }, [
      employee("senior", { remoteHost: "10.0.0.5", remoteCwd: "/srv/jinn-work/main" }),
      employee("junior", { remoteHost: "10.0.0.5", remoteCwd: "/srv/jinn-work/main" }),
      employee("qa", { remoteHost: "10.0.0.5", remoteUser: "ci", remoteCwd: "/srv/jinn-work/main" }),
      employee("local-one"),
    ]);
    expect(list.hosts.map((h) => [h.id, h.destination, h.cwd, h.detail])).toEqual([
      ["local", undefined, undefined, "This gateway"],
      ["ssh:10.0.0.5", "10.0.0.5", "/srv/jinn-work", "Runs senior, junior"],
      ["ssh:ci@10.0.0.5", "ci@10.0.0.5", "/srv/jinn-work", "Runs qa"],
    ]);
  });

  it("puts configured hosts first and lets one supersede a derived host with the same destination", () => {
    const config: Pick<JinnConfig, "terminal" | "remote"> = {
      remote,
      terminal: {
        localLabel: "Pi",
        hosts: [{ id: "build", label: "Build host", host: "10.0.0.5", cwd: "/srv/jinn-work/main" }],
      },
    };
    const list = listTerminalHosts(config, [employee("senior", { remoteHost: "10.0.0.5", remoteCwd: "/srv/jinn-work/x" })]);
    expect(list.hosts.map((h) => [h.id, h.label, h.cwd])).toEqual([
      ["local", "Pi", undefined],
      ["build", "Build host", "/srv/jinn-work/main"],
    ]);
  });

  it("refuses a configured host that would reach ssh's option parser, and says why", () => {
    const list = listTerminalHosts({
      terminal: {
        hosts: [
          { id: "evil", host: "-oProxyCommand=touch /tmp/pwned" },
          { id: "bad id!", host: "box" },
          { id: "local", host: "box" },
          { id: "rel", host: "box", cwd: "~/src" },
          { id: "ok", host: "box", user: "builder" },
        ],
      },
    }, []);
    expect(list.hosts.map((h) => h.id)).toEqual(["local", "ok"]);
    expect(list.hosts[1]).toMatchObject({ destination: "builder@box", label: "box" });
    expect(list.problems).toHaveLength(4);
    expect(list.problems[0]).toMatch(/evil.*ssh's own arguments/);
    expect(list.problems[2]).toMatch(/already taken/);
    expect(list.problems[3]).toMatch(/absolute path/);
  });

  it("keeps derived ids apart that differ only in punctuation", () => {
    const list = listTerminalHosts({ remote }, [
      employee("a", { remoteHost: "box", remoteUser: "ops", remoteCwd: "/srv/jinn-work" }),
      employee("b", { remoteHost: "ops-box", remoteCwd: "/srv/jinn-work" }),
    ]);
    expect(list.hosts.map((h) => h.id)).toEqual(["local", "ssh:ops@box", "ssh:ops-box"]);
  });

  it("is on by default everywhere, an auth-requiring gateway included; only enabled: false turns it off", () => {
    const exposed = { gateway: { port: 7777, host: "0.0.0.0", authRequired: true } } as unknown as Pick<JinnConfig, "terminal" | "remote">;
    expect(listTerminalHosts(exposed, []).enabled).toBe(true);
    const off = listTerminalHosts({ ...exposed, terminal: { enabled: false } }, []);
    expect(off).toMatchObject({ enabled: false, hosts: [] });
    expect(off.disabledReason).toMatch(/terminal\.enabled: false/);
  });

  it("reports a malformed terminal block instead of throwing", () => {
    const list = listTerminalHosts({ terminal: { hosts: { build: { host: "x" } }, localLabel: 42 } as never }, []);
    expect(list.enabled).toBe(true);
    expect(list.hosts.map((h) => [h.id, h.label])).toEqual([["local", os.hostname()]]);
    expect(list.problems).toEqual(["terminal.hosts must be a list of hosts; ignored"]);
    expect(listTerminalHosts({ terminal: "yes" as never }, []).hosts).toHaveLength(1);
  });

  it("offers nothing when disabled, and can skip employee hosts", () => {
    expect(listTerminalHosts({ terminal: { enabled: false } }, [])).toMatchObject({ enabled: false, hosts: [], problems: [] });
    const list = listTerminalHosts({ remote, terminal: { employeeHosts: false } }, [employee("s", { remoteHost: "10.0.0.5", remoteCwd: "/srv/jinn-work" })]);
    expect(list.hosts.map((h) => h.id)).toEqual(["local"]);
  });

  it("finds a host by id", () => {
    const list = listTerminalHosts({}, []);
    expect(findTerminalHost(list, "local")?.kind).toBe("local");
    expect(findTerminalHost(list, "nope")).toBeUndefined();
    expect(findTerminalHost(list, undefined)).toBeUndefined();
  });
});
