/*
 * The smallest service worker that makes this app installable.
 *
 * IT CACHES NOTHING, AND THAT IS THE POINT. Every figure this app shows is
 * money — a balance, a cost, a profit. A cached page served after the books
 * moved would show a stale number that looks exactly as authoritative as a
 * fresh one, and this project has already paid once for a number that was
 * wrong but confident.
 *
 * Chrome's installability criteria want a fetch handler to EXIST. This one
 * exists and deliberately never calls `respondWith`, so every request goes to
 * the network exactly as it would with no service worker at all. Nothing is
 * intercepted, nothing is stored, nothing can go stale.
 *
 * If offline use is ever wanted, it must be designed — deciding which screens
 * may be shown from cache and which must refuse — not bolted on here.
 */

self.addEventListener("install", () => {
  // Take over immediately rather than waiting for every tab to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // Intentionally empty: no respondWith, so the browser handles the request
  // itself. Present only so the app satisfies installability.
});
