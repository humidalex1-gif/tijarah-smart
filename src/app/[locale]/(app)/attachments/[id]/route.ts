import { NextResponse } from "next/server";
import { loadAppContext } from "@/lib/appContext";
import { isLocale, DEFAULT_LOCALE } from "@/lib/i18n";
import { readUpload } from "@/lib/uploads";
import { can, type Permission } from "@/lib/permissions";

/**
 * Serves an uploaded document back to the owner who uploaded it.
 *
 * Never a static file route: the uploads directory is deliberately outside
 * `public/`, because anything under `public/` is world-readable and these are
 * the business's invoices. Every read goes through the session and the
 * company scope on the attachment row.
 *
 * `Content-Disposition: attachment` on everything, and no HTML in the allowed
 * types: a document rendered inline on this origin would run as this origin.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ locale: string; id: string }> },
) {
  const { locale: rawLocale, id } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  // Redirects to the login page when there is no session, exactly as every
  // other screen does.
  const ctx = await loadAppContext(locale);

  // The permission the SCREEN showing this document class already enforces.
  // Session + company alone let a role whose screens hide expense invoices
  // download them anyway with a shared link — the raw file was the one door
  // left unlocked. Unknown entity types fail CLOSED: an unmapped document is
  // exactly the one nobody has decided about yet.
  const PERMISSION_BY_ENTITY: Record<string, Permission> = {
    EXPENSE: "expenses.view",
    PAYMENT: "payments.view",
    WAREHOUSE_INVOICE: "expenses.view",
  };

  try {
    const file = await readUpload({ companyId: ctx.companyId, userId: ctx.userId }, id);

    const required = PERMISSION_BY_ENTITY[file.entityType];
    if (!required || !can(ctx.role, required)) {
      return new NextResponse(null, { status: 403 });
    }

    return new NextResponse(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.mimeType,
        // RFC 5987 for the Arabic filenames these invoices actually carry.
        "Content-Disposition":
          `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
