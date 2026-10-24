"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Renders nothing — its only job is closing the mobile nav drawer
 * (`#mobile-nav-toggle`, see `AppLayout` and `Sidebar.tsx`) whenever the
 * route changes. Needed because Next does NOT remount `(app)/layout.tsx`
 * on a client-side navigation between sibling routes underneath it
 * (docs/decisions.md #10) — without this, the drawer's checkbox keeps
 * whatever checked state it had before the user tapped a nav link, so the
 * open drawer would still be covering the very page they just navigated to.
 *
 * Deliberately a plain DOM mutation (`getElementById(...).checked = false`)
 * rather than React state: the drawer itself is pure CSS (a `peer`
 * checkbox + `peer-checked:` classes on `Sidebar`'s root `<nav>`) precisely
 * so it needs no client JS to open/close — this component only patches the
 * one behavior CSS-only can't cover, without pulling Sidebar/Header into a
 * shared client component tree.
 */
export function CloseMobileNavOnNavigate() {
  const pathname = usePathname();

  useEffect(() => {
    const toggle = document.getElementById("mobile-nav-toggle");
    if (toggle instanceof HTMLInputElement) toggle.checked = false;
  }, [pathname]);

  return null;
}
