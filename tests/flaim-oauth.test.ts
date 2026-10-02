import { describe, expect, it } from "vitest";
import { classifyRegistrationFailure, flaimReadOnlyScope } from "@/lib/flaim/oauth";

describe("Flaim OAuth registration errors", () => {
  it("surfaces a rejected callback URI as an allowlist failure", () => {
    expect(classifyRegistrationFailure("invalid_redirect_uri")).toBe("redirect_uri_rejected");
  });

  it("does not expose unrecognized provider errors as trusted UI codes", () => {
    expect(classifyRegistrationFailure("secret-bearing-provider-message")).toBe("client_registration_failed");
    expect(classifyRegistrationFailure(undefined)).toBe("client_registration_failed");
  });

  it("requests only Flaim's read scope when the provider also supports write", () => {
    expect(flaimReadOnlyScope(["mcp:read", "mcp:write"])).toBe("mcp:read");
    expect(flaimReadOnlyScope(["mcp:write"])).toBeUndefined();
    expect(flaimReadOnlyScope([], "mcp:read mcp:write")).toBe("mcp:read");
  });
});
