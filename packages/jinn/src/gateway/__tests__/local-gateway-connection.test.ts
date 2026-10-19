import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLocalGatewayConnection } from "../local-gateway-connection.js";

const scratch: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A home whose config.yaml records the binding the CLI is meant to reach. */
function homeOnPort(port: number, host = "127.0.0.1"): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-connection-"));
  scratch.push(home);
  fs.writeFileSync(path.join(home, "config.yaml"), `gateway:\n  host: ${host}\n  port: ${port}\n`);
  return home;
}

describe("resolveLocalGatewayConnection", () => {
  it("ignores a binding that belongs to another home", () => {
    const sandbox = homeOnPort(7899);
    const live = homeOnPort(7801);

    const connection = resolveLocalGatewayConnection(sandbox, 7801, {
      JINN_HOME: live,
      JINN_HOST: "0.0.0.0",
      JINN_PORT: "7777", // footgun: ok the leaked live port is the regression under test
    });

    expect(connection.port).toBe(7899);
    expect(connection.host).toBe("127.0.0.1");
  });

  it("applies the binding when the environment names the home being resolved", () => {
    const home = homeOnPort(7899);

    const connection = resolveLocalGatewayConnection(home, 7801, {
      JINN_HOME: home,
      JINN_HOST: "0.0.0.0",
      JINN_PORT: "8080",
    });

    expect(connection.port).toBe(8080);
    expect(connection.host).toBe("0.0.0.0");
  });

  it("applies the binding of an unset home to the default instance", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-connection-root-"));
    scratch.push(root);
    vi.spyOn(os, "homedir").mockReturnValue(root);
    const home = path.join(root, ".jinn");
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, "config.yaml"), "gateway:\n  port: 7899\n");

    const connection = resolveLocalGatewayConnection(home, 7801, { JINN_PORT: "8080" });

    expect(connection.port).toBe(8080);
  });

  it("falls back to the registry default when neither the home nor the environment binds", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-connection-bare-"));
    scratch.push(home);

    expect(resolveLocalGatewayConnection(home, 7801, {}).port).toBe(7801);
  });
});
