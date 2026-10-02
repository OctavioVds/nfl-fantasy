import { describe, expect, it } from "vitest";
import { classifyRegistrationFailure } from "@/lib/flaim/oauth";

describe("Flaim OAuth registration errors", () => {
  it("surfaces a rejected callback URI as an allowlist failure", () => {
    expect(classifyRegistrationFailure("invalid_redirect_uri")).toBe("redirect_uri_rejected");
  });

  it("does not expose unrecognized provider errors as trusted UI codes", () => {
    expect(classifyRegistrationFailure("secret-bearing-provider-message")).toBe("client_registration_failed");
    expect(classifyRegistrationFailure(undefined)).toBe("client_registration_failed");
  });
});
