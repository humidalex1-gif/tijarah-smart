"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ConnectionStatus } from "@/services/salla/connection";
import { FormField, inputClass } from "@/components/ui/FormField";

type Labels = Record<
  | "clientId" | "clientSecret" | "secretStored" | "save" | "saved"
  | "connect" | "connectHint" | "disconnect" | "disconnected" | "notConnected"
  | "storeName" | "connectedAt" | "scopes" | "accessValid" | "accessExpired"
  | "generic",
  string
>;

/**
 * The credential fields never render a stored value — the secret is not sent
 * to the browser at all, and an empty submission means "leave it unchanged".
 * `status` is deliberately the only server data here, and it carries no
 * secret and no token.
 */
export function SallaConnectionForm({
  status, connectedAtLabel, labels,
}: {
  status: ConnectionStatus;
  /** Pre-formatted on the server so this component needs no locale. */
  connectedAtLabel: string | null;
  labels: Labels;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A state flag alone does not stop a synchronous double-click: React batches
  // the update and the second handler runs against the old value.
  const submittingRef = useRef(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setPending(true);
    setMessage(null);
    setError(null);

    const form = event.currentTarget;
    try {
      const { saveSallaCredentialsAction } = await import("./actions");
      const result = await saveSallaCredentialsAction(new FormData(form));
      if (result.ok) {
        setMessage(labels.saved);
        // Clear only the secret field: the client id stays visible so the
        // owner can see what is stored.
        const secret = form.elements.namedItem("clientSecret");
        if (secret instanceof HTMLInputElement) secret.value = "";
        router.refresh();
      } else {
        setError(result.error);
      }
    } catch {
      setError(labels.generic);
    } finally {
      submittingRef.current = false;
      setPending(false);
    }
  }

  async function onDisconnect() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setPending(true);
    setMessage(null);
    setError(null);
    try {
      const { disconnectSallaAction } = await import("./actions");
      const result = await disconnectSallaAction(new FormData());
      if (result.ok) {
        setMessage(labels.disconnected);
        router.refresh();
      } else {
        setError(result.error);
      }
    } catch {
      setError(labels.generic);
    } finally {
      submittingRef.current = false;
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={onSubmit} className="max-w-md space-y-4">
        <FormField label={labels.clientId} required>
          <input
            name="clientId"
            defaultValue={status.clientId ?? ""}
            className={inputClass}
            autoComplete="off"
            required
          />
        </FormField>

        <FormField label={labels.clientSecret} hint={status.configured ? labels.secretStored : undefined}>
          <input
            name="clientSecret"
            type="password"
            className={inputClass}
            autoComplete="new-password"
            placeholder={status.configured ? labels.secretStored : undefined}
          />
        </FormField>

        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink disabled:opacity-50"
        >
          {labels.save}
        </button>
      </form>

      {message ? <p className="text-sm text-success">{message}</p> : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <div className="rounded-xl border border-line bg-panel p-4">
        {status.connected ? (
          <dl className="space-y-2 text-sm">
            <div className="flex gap-2">
              <dt className="text-muted">{labels.storeName}</dt>
              <dd className="font-medium">{status.storeName ?? "—"}</dd>
            </div>
            {connectedAtLabel ? (
              <div className="flex gap-2">
                <dt className="text-muted">{labels.connectedAt}</dt>
                <dd className="tabular-nums">{connectedAtLabel}</dd>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {/* Shown verbatim: a missing scope explains an empty sync far
                  faster than any stack trace does. */}
              <dt className="text-muted">{labels.scopes}</dt>
              <dd className="flex flex-wrap gap-1">
                {status.scopes.length === 0
                  ? "—"
                  : status.scopes.map((scope) => (
                      <span key={scope} className="rounded bg-subtle px-1.5 py-0.5 text-xs">
                        {scope}
                      </span>
                    ))}
              </dd>
            </div>
            <p className="text-xs text-muted">
              {status.accessValid ? labels.accessValid : labels.accessExpired}
            </p>
          </dl>
        ) : (
          <p className="text-sm text-muted">{labels.notConnected}</p>
        )}

        <div className="mt-4">
          {status.connected ? (
            <button
              type="button"
              onClick={onDisconnect}
              disabled={pending}
              className="rounded-lg border border-line px-4 py-2 text-sm disabled:opacity-50"
            >
              {labels.disconnect}
            </button>
          ) : (
            /* eslint-disable-next-line @next/next/no-html-link-for-pages --
               deliberately a plain <a>. This target is a route handler that
               302s to accounts.salla.sa; next/link would attempt a
               client-side RSC navigation and never leave the app. */
            <a
              href="/api/salla/authorize"
              aria-disabled={!status.configured}
              className={`inline-block rounded-lg px-4 py-2 text-sm font-medium ${
                status.configured
                  ? "bg-brand text-brand-ink"
                  : "pointer-events-none bg-subtle text-muted"
              }`}
            >
              {labels.connect}
            </a>
          )}
          {!status.connected && !status.configured ? (
            <p className="mt-2 text-xs text-muted">{labels.connectHint}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
