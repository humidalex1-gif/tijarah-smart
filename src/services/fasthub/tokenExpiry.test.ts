import { describe, it, expect } from "vitest";
import { describeAccessExpiry } from "./tokenExpiry";

/**
 * Fast Hub's access token is pasted by hand and never renewed by the app —
 * client.ts refuses an expired one on purpose. So the only warning the owner
 * ever got was the sync turning red the morning after. This says it a week
 * ahead, on the screen he opens every day.
 */
const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-09-11T08:00:00.000Z");
const connected = (accessExpiresAt: Date | null) => ({ connected: true, accessExpiresAt });

describe("describeAccessExpiry", () => {
  it("says nothing while the token has more than a week to live", () => {
    expect(describeAccessExpiry(connected(new Date(now.getTime() + 8 * DAY)), now)).toBeNull();
  });

  it("counts the days once the token is inside its last week", () => {
    // Two and a half days left is "3 days": the owner needs the ceiling, not
    // the floor — "2 days" on the morning of the 9th, for a token dying on
    // the evening of the 11th, invites leaving it to the 11th.
    const expiry = new Date(now.getTime() + 2.5 * DAY);
    expect(describeAccessExpiry(connected(expiry), now)).toEqual({ state: "soon", daysLeft: 3 });
  });

  it("says a token that expires later today is due today, not in zero days", () => {
    const expiry = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    expect(describeAccessExpiry(connected(expiry), now)).toEqual({ state: "soon", daysLeft: 1 });
  });

  it("says expired once the moment has passed", () => {
    expect(describeAccessExpiry(connected(new Date(now.getTime() - 1)), now)).toEqual({ state: "expired" });
  });

  it("says nothing when there is no connection to lose", () => {
    expect(describeAccessExpiry({ connected: false, accessExpiresAt: new Date(now.getTime() + DAY) }, now)).toBeNull();
    expect(describeAccessExpiry(connected(null), now)).toBeNull();
  });
});
