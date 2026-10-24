/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { InstallPanel, type InstallPanelLabels } from "./InstallPanel";
import { DISMISS_KEY } from "@/lib/install";

/**
 * The panel that offers the app on a laptop, an Android phone and an iPhone.
 *
 * Three properties matter more than its looks, and each has an obvious wrong
 * version that would look fine in a screenshot:
 *
 *  - it NEVER shows inside the already-installed app,
 *  - it never renders a one-tap button the browser will not honour, and
 *  - dismissing it makes it stay gone.
 */

const LABELS: InstallPanelLabels = {
  title: "Install the app",
  body: "Add it to your home screen for one-tap entry.",
  install: "Install",
  installing: "Opening...",
  dismiss: "Not now",
  close: "Close",
  iosSteps: ["Tap Share", "Choose Add to Home Screen", "Tap Add"],
  androidSteps: ["Open the Chrome menu", "Choose Install app", "Confirm"],
  desktopSteps: ["Click the install icon in the address bar", "Choose Install"],
  stepsTitle: "How to install",
};

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36";

function setAgent(ua: string, extra: { maxTouchPoints?: number; standalone?: boolean } = {}) {
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
  Object.defineProperty(window.navigator, "maxTouchPoints", {
    value: extra.maxTouchPoints ?? 0, configurable: true,
  });
  // Always defined, never left over. `navigator.standalone` is a real property
  // on this fake navigator once set, so setting it only when asked let the
  // installed-iPhone case leak `true` into every test that ran after it, and
  // the panel then correctly hid itself in all of them.
  Object.defineProperty(window.navigator, "standalone", {
    value: extra.standalone ?? false, configurable: true,
  });
}

/** `mode` is the ONE display mode actually applied — they never cascade. */
function setDisplayMode(installedOrMode: boolean | string) {
  const mode = installedOrMode === true
    ? "standalone"
    : installedOrMode === false ? "browser" : installedOrMode;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (q: string) => ({
      matches: q.includes(`display-mode: ${mode}`),
      media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
}

/** Fires the event Chrome uses to say "this page can be installed". */
function fireInstallable() {
  const event = new Event("beforeinstallprompt") as Event & {
    prompt?: () => Promise<void>;
    userChoice?: Promise<{ outcome: string }>;
  };
  const prompt = vi.fn(async () => {});
  event.prompt = prompt;
  event.userChoice = Promise.resolve({ outcome: "accepted" });
  act(() => { window.dispatchEvent(event); });
  return prompt;
}

beforeEach(() => {
  localStorage.clear();
  setDisplayMode(false);
  setAgent(WINDOWS);
});
afterEach(cleanup);

const show = () => render(<InstallPanel labels={LABELS} delayMs={0} />);

/**
 * The panel appears on a zero-delay timer, so nothing about it is observable
 * in the same tick as the render. Absence has to be checked AFTER that timer
 * would have fired, or every "stays silent" test passes for the wrong reason.
 */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 1)); });

describe("InstallPanel", () => {
  it("stays silent inside the installed app", async () => {
    setDisplayMode(true);
    show();
    await settle();
    // The most annoying failure there is: an install banner in the installed app.
    expect(screen.queryByText("Install the app")).toBeNull();
  });

  it("stays silent inside an installed Windows app, whatever mode it runs in", async () => {
    // display-mode queries do not cascade — exactly one matches, the mode
    // actually applied. A check that asked only about `standalone` showed the
    // install panel INSIDE the installed desktop app.
    for (const mode of ["standalone", "minimal-ui", "window-controls-overlay"]) {
      cleanup();
      setDisplayMode(mode);
      show();
      await settle();
      expect(screen.queryByText("Install the app")).toBeNull();
    }
  });

  it("still offers itself in a browser tab put into fullscreen by F11", async () => {
    // Fullscreen is reachable without installing anything, so treating it as
    // installed would silence the panel for someone who never installed.
    setDisplayMode("fullscreen");
    show();
    expect(await screen.findByText("Install the app")).not.toBeNull();
  });

  it("stays silent inside an installed iPhone app, which reports it differently", async () => {
    setAgent(IPHONE, { standalone: true });
    show();
    await settle();
    expect(screen.queryByText("Install the app")).toBeNull();
  });

  it("offers written steps on an iPhone, and never a button Safari cannot honour", async () => {
    setAgent(IPHONE);
    show();

    expect(await screen.findByText("Install the app")).not.toBeNull();
    expect(await screen.findByText("Choose Add to Home Screen")).not.toBeNull();
    // Safari has no install API at all. A button here could only lie.
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("shows on a laptop even before the browser offers to install", async () => {
    show();
    // Gating this on Chrome's event left the laptop silent in a live check.
    expect(await screen.findByText("Install the app")).not.toBeNull();
    expect(await screen.findByText("Choose Install")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("swaps the steps for a real button once the browser says it can install", async () => {
    show();
    fireInstallable();

    expect(await screen.findByRole("button", { name: "Install" })).not.toBeNull();
    // The written fallback is now redundant and would compete with the button.
    expect(screen.queryByText("Choose Install")).toBeNull();
  });

  it("shows Android its own steps, not the desktop ones", async () => {
    setAgent(ANDROID);
    show();

    expect(await screen.findByText("Choose Install app")).not.toBeNull();
    expect(screen.queryByText("Choose Install")).toBeNull();
  });

  it("opens the browser's own dialog when the button is pressed", async () => {
    show();
    await settle();
    const prompt = fireInstallable();

    fireEvent.click(await screen.findByRole("button", { name: "Install" }));

    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
  });

  it("remembers a dismissal so it does not come back", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));

    expect(screen.queryByText("Install the app")).toBeNull();
    expect(localStorage.getItem(DISMISS_KEY)).not.toBeNull();

    cleanup();
    show();
    await settle();
    expect(screen.queryByText("Install the app")).toBeNull();
  });

  it("goes away once the app reports itself installed", async () => {
    show();
    expect(await screen.findByText("Install the app")).not.toBeNull();

    act(() => { window.dispatchEvent(new Event("appinstalled")); });

    // Leaving it up after a successful install invites a second attempt.
    expect(screen.queryByText("Install the app")).toBeNull();
  });

  it("survives storage being unavailable rather than taking the page down", async () => {
    const boom = () => { throw new Error("storage disabled"); };
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: boom, setItem: boom, clear: () => {}, removeItem: boom },
    });

    // Private browsing and locked-down enterprise profiles both throw here.
    expect(() => show()).not.toThrow();

    if (original) Object.defineProperty(window, "localStorage", original);
  });
});
