import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "@/lib/crypto";

describe("secret encryption", () => {
  it("round-trips a secret", () => {
    expect(decryptSecret(encryptSecret("s3cr3t-value"))).toBe("s3cr3t-value");
  });

  it("produces different ciphertext each time for the same input", () => {
    // A deterministic ciphertext would leak that two values are identical —
    // e.g. that a re-entered secret is unchanged — straight out of the column.
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("never leaves the plaintext visible in the stored form", () => {
    expect(encryptSecret("super-secret")).not.toContain("super-secret");
  });

  it("carries a version prefix so the scheme can be rotated later", () => {
    expect(encryptSecret("x").startsWith("v1.")).toBe(true);
  });

  it("round-trips Arabic and other multi-byte text", () => {
    expect(decryptSecret(encryptSecret("مفتاح سرّي"))).toBe("مفتاح سرّي");
  });

  it("refuses a tampered payload rather than returning garbage", () => {
    const parts = encryptSecret("value").split(".");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });

  it("refuses a payload of an unknown version", () => {
    expect(() => decryptSecret("v9.a.b.c")).toThrow();
  });

  it("refuses a malformed payload", () => {
    expect(() => decryptSecret("not-a-payload")).toThrow();
  });
});
