import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { assertCan, type Permission } from "@/lib/permissions";
import { ROLES, type Role } from "@/lib/constants";
import { ServiceError } from "@/services/errors";
import type { ServiceContext } from "@/services/context";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; fields?: Record<string, string> };

/**
 * Wraps a server action with the four things every mutation needs:
 * session, permission check, input validation, and error classification.
 * The UI never sees a raw exception or a stack trace — it gets a message
 * key it renders through `t()`.
 *
 * `permission` accepts a single Permission or an array — an array requires
 * ALL of them (AND, not OR). Needed when one action covers a broader
 * capability than its single most-obvious permission implies: e.g.
 * recordSupplierPaymentAction (finance/actions.ts) needs BOTH
 * `payments.create` (may record a payment at all) AND `purchases.view`
 * (may see supplier/PO data at all) — a role holding only the former must
 * still be refused, or a standalone payment page ends up granting it
 * supplier/PO visibility no other permission actually gates.
 */
export function action<TSchema extends z.ZodType, TResult>(config: {
  permission: Permission | Permission[];
  schema: TSchema;
  handler: (input: z.infer<TSchema>, ctx: ServiceContext) => Promise<TResult>;
}) {
  return async (formData: FormData): Promise<ActionResult<TResult>> => {
    let session;
    try {
      session = await requireSession();
    } catch {
      return { ok: false, error: "errors.FORBIDDEN", code: "UNAUTHENTICATED" };
    }

    // The JWT's role claim is a display cache and survives a demotion or a
    // deactivation until the token dies (docs/decisions.md #2), so authorize
    // off a fresh Membership row and validate the string against ROLES before
    // it reaches can() — can() maps an unknown role to zero permissions
    // silently (docs/decisions.md #3).
    const membership = await prisma.membership.findFirst({
      where: { userId: session.userId, companyId: session.companyId, status: "ACTIVE" },
      select: { role: true },
    });
    if (!membership || !(ROLES as readonly string[]).includes(membership.role)) {
      return { ok: false, error: "errors.FORBIDDEN", code: "FORBIDDEN" };
    }

    const requiredPermissions = Array.isArray(config.permission) ? config.permission : [config.permission];
    // An empty array would authorize UNCONDITIONALLY — the loop below never
    // calls assertCan, so nothing throws — the opposite of what "requires
    // these permissions" is supposed to mean. No caller passes `[]` today,
    // but the type permits it, so refuse it explicitly rather than trust
    // every future caller to never construct one dynamically.
    if (requiredPermissions.length === 0) {
      return { ok: false, error: "errors.FORBIDDEN", code: "FORBIDDEN" };
    }
    try {
      for (const permission of requiredPermissions) {
        assertCan(membership.role as Role, permission);
      }
    } catch {
      return { ok: false, error: "errors.FORBIDDEN", code: "FORBIDDEN" };
    }

    // Object.fromEntries(formData.entries()) silently keeps only the LAST
    // value for a repeated field name — a variant form posting two
    // `attrName`/`attrValue` pairs under the same names would lose every
    // attribute but the last with no error. getAll() per key preserves every
    // value; a field posted once still collapses to a scalar so every
    // existing single-valued schema (the overwhelming majority) is unaffected.
    const raw: Record<string, FormDataEntryValue | FormDataEntryValue[]> = {};
    for (const key of new Set(formData.keys())) {
      const values = formData.getAll(key);
      raw[key] = values.length > 1 ? values : values[0];
    }
    const parsed = config.schema.safeParse(raw);
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join(".");
        if (key && !fields[key]) fields[key] = issue.message;
      }
      return { ok: false, error: "errors.generic", code: "VALIDATION", fields };
    }

    try {
      const data = await config.handler(parsed.data, {
        companyId: session.companyId,
        userId: session.userId,
      });
      return { ok: true, data };
    } catch (error) {
      if (error instanceof ServiceError) {
        return { ok: false, error: `errors.${error.code}`, code: error.code };
      }
      // Services tenant-check with findFirstOrThrow({id, companyId}) in ~31
      // places; a miss is Prisma's P2025, never a ServiceError, so without
      // this branch errors.NOT_FOUND is unreachable.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        return { ok: false, error: "errors.NOT_FOUND", code: "NOT_FOUND" };
      }
      // Log the real error server-side; return nothing revealing to the client.
      console.error("Unhandled action error:", error);
      return { ok: false, error: "errors.generic", code: "UNEXPECTED" };
    }
  };
}
