import { describe, it, expect } from "vitest";
import { GET } from "./route";

/**
 * The route, not just the builder.
 *
 * `buildManifest` being correct proves nothing if the response never reaches
 * the browser with the right content type — a manifest served as text/plain is
 * ignored, and the install button simply never appears, with no error anywhere.
 */

const call = (locale: string) => GET(new Request("http://localhost/x"), {
  params: Promise.resolve({ locale }),
});

describe("GET /[locale]/manifest.webmanifest", () => {
  it("serves the manifest media type browsers actually require", async () => {
    const res = await call("ar");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/manifest+json");
  });

  it("serves the Arabic app under /ar and the English one under /en", async () => {
    const ar = await (await call("ar")).json();
    const en = await (await call("en")).json();

    expect(ar.name).toBe("تجارة سمارت");
    expect(ar.start_url).toBe("/ar/quick");
    expect(en.name).toBe("Tijarah Smart");
    expect(en.start_url).toBe("/en/quick");
  });

  it("falls back to the default locale rather than serving a broken manifest", async () => {
    const body = await (await call("zz")).json();

    // A mistyped locale must not produce a manifest whose start_url 404s —
    // that would install an icon that opens a not-found page.
    expect(body.start_url).toBe("/ar/quick");
  });

  it("carries every field an install is refused without", async () => {
    const m = await (await call("ar")).json();
    const sizes = (m.icons as { sizes: string }[]).map((i) => i.sizes);

    expect(m.display).toBe("standalone");
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(m.theme_color).toBe("#002fa7");
  });
});
