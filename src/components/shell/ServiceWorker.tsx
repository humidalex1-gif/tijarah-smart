"use client";

import { useEffect } from "react";

/**
 * Registers the service worker, which exists only so the app is installable.
 *
 * It caches nothing (see `public/sw.js`), so registering it cannot make any
 * screen show a stale figure. Registration failure is logged and swallowed:
 * losing the install button is not worth breaking a page over, and every
 * browser that refuses here still serves the app perfectly well.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // After load, so registration never competes with the first paint.
    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch((e) => console.error("Service worker registration failed:", e));
    };
    if (document.readyState === "complete") register();
    else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
