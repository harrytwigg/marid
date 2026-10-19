import { describe, expect, it } from "vitest";
import { forwarderNotice, forwardTarget } from "../legacy-forwarder.js";
import { namesFor } from "../../shared/codename.js";

describe("legacy forwarder", () => {
  it("stays silent while the program still has the legacy name", () => {
    expect(forwarderNotice(namesFor("jinn"))).toBeUndefined();
  });

  it("tells the operator the new name once the program is renamed", () => {
    const notice = forwarderNotice(namesFor("acme"));
    expect(notice).toContain("`jinn`");
    expect(notice).toContain("`acme`");
  });

  it("hands over to the current binary, not to itself", () => {
    expect(forwardTarget(namesFor("acme"))).toBe("./acme.js");
  });
});
