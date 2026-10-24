"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { FastHubStatus } from "@/services/fasthub/connection";
import { FormField, inputClass } from "@/components/ui/FormField";

type Labels = Record<
  | "clientId" | "clientSecret" | "accessToken" | "refreshToken" | "webhookSecret"
  | "optional" | "stored" | "save" | "saved" | "disconnect" | "disconnected"
  | "notConnected" | "connected" | "accessExpires" | "refreshExpires"
  | "lastPolled" | "never" | "accessValid" | "accessExpired" | "whereFrom"
  | "generic",
  string
>;

/** Every secret renders empty, always. The stored values never reach the browser. */
function SecretField({
  name, label, hint, stored,
}: {
  name: string; label: string; hint: string; stored: boolean;
}) {
  return (
    <FormField label={label} hint={stored ? hint : undefined}>
      <input name={name} type="password" className={inputClass} autoComplete="new-password" />
    </FormField>
  );
}

export function FastHubConnectionForm({
  status, dates, labels,
}: {
  status: FastHubStatus;
  /** Pre-formatted on the server so this component needs no locale. */
  dates: { accessExpires: string | null; refreshExpires: string | null; lastPolled: string | null };
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
      const { saveFastHubCredentialsAction } = await import("./actions");
      const result = await saveFastHubCredentialsAction(new FormData(form));
      if (result.ok) {
        setMessage(labels.saved);
        // Clear the secrets only; the client id stays visible so the owner can
        // see which integration is wired up.
        for (const name of ["clientSecret", "accessToken", "refreshToken", "webhookSecret"]) {
          const field = form.elements.namedItem(name);
          if (field instanceof HTMLInputElement) field.value = "";
        }
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
      const { disconnectFastHubAction } = await import("./actions");
      const result = await disconnectFastHubAction(new FormData());
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
      <p className="rounded-lg bg-subtle p-3 text-xs text-muted">{labels.whereFrom}</p>

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

        <SecretField name="clientSecret" label={labels.clientSecret} hint={labels.stored} stored={status.configured} />
        <SecretField name="accessToken" label={labels.accessToken} hint={labels.stored} stored={status.connected} />
        <SecretField name="refreshToken" label={labels.refreshToken} hint={labels.stored} stored={status.connected} />
        <SecretField
          name="webhookSecret"
          label={`${labels.webhookSecret} — ${labels.optional}`}
          hint={labels.stored}
          stored={status.connected}
        />

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
              <dt className="text-muted">{labels.accessExpires}</dt>
              <dd className="tabular-nums">{dates.accessExpires ?? "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">{labels.refreshExpires}</dt>
              <dd className="tabular-nums">{dates.refreshExpires ?? "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">{labels.lastPolled}</dt>
              <dd className="tabular-nums">{dates.lastPolled ?? labels.never}</dd>
            </div>
            <p className={`text-xs ${status.accessValid ? "text-muted" : "text-danger"}`}>
              {status.accessValid ? labels.accessValid : labels.accessExpired}
            </p>
          </dl>
        ) : (
          <p className="text-sm text-muted">{labels.notConnected}</p>
        )}

        {status.connected ? (
          <button
            type="button"
            onClick={onDisconnect}
            disabled={pending}
            className="mt-4 rounded-lg border border-line px-4 py-2 text-sm disabled:opacity-50"
          >
            {labels.disconnect}
          </button>
        ) : null}
      </div>
    </div>
  );
}
