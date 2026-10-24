import { describe, it, expect, afterEach } from "vitest";
import { appOrigin, sallaRedirectUri } from "@/lib/appUrl";

/**
 * The app's public origin. Hardcoded to the loopback until the app moved to a
 * server, where a wrong value does not merely inconvenience: Salla compares
 * the redirect character for character and refuses the whole connection.
 */

const original = process.env.APP_URL;
afterEach(() => {
  if (original === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = original;
});

describe("appOrigin", () => {
  it("falls back to the loopback so local development needs no configuration", () => {
    delete process.env.APP_URL;
    expect(appOrigin()).toBe("http://127.0.0.1:3000");
  });

  it("uses APP_URL when the app is deployed", () => {
    process.env.APP_URL = "https://stock.example.com";
    expect(appOrigin()).toBe("https://stock.example.com");
  });

  it("drops a trailing slash, which would otherwise double up in every path", () => {
    // "https://x.com/" + "/api/salla/callback" is a URL Salla will reject as
    // a mismatch against the portal value.
    process.env.APP_URL = "https://stock.example.com/";
    expect(appOrigin()).toBe("https://stock.example.com");
  });

  it("ignores a blank APP_URL rather than producing an empty origin", () => {
    process.env.APP_URL = "   ";
    expect(appOrigin()).toBe("http://127.0.0.1:3000");
  });
});

describe("sallaRedirectUri", () => {
  it("is derived from the same origin, so the two can never drift apart", () => {
    process.env.APP_URL = "https://stock.example.com";
    expect(sallaRedirectUri()).toBe("https://stock.example.com/api/salla/callback");
  });

  it("is read at call time, not at import, so the server's value is the one used", () => {
    // A module-level constant would freeze whatever the environment held when
    // the module was first imported — which in Next can be a build step.
    process.env.APP_URL = "https://first.example.com";
    expect(sallaRedirectUri()).toBe("https://first.example.com/api/salla/callback");
    process.env.APP_URL = "https://second.example.com";
    expect(sallaRedirectUri()).toBe("https://second.example.com/api/salla/callback");
  });
});
