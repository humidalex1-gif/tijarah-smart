import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { ROLES, type Role } from "@/lib/constants";
import { formatDate } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { InviteUserForm, type InviteUserFormLabels } from "./InviteUserForm";
import { ResetPasswordButton, type ResetPasswordLabels } from "./ResetPasswordButton";

export default async function TeamPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  // The sharpest test of docs/decisions.md #2: loadAppContext() re-reads
  // Membership on every request, and requirePermission checks THIS role, not
  // a JWT claim — an admin demoted in another session loses this page (and
  // every action() call below re-checks again server-side) on their very
  // next request, not after their token expires.
  requirePermission(ctx, "users.manage", locale);
  const t = await getTranslator(locale);

  const memberships = await prisma.membership.findMany({
    where: { companyId: ctx.companyId, status: "ACTIVE" },
    include: { user: { select: { id: true, fullName: true, email: true, lastLoginAt: true } } },
    orderBy: { createdAt: "asc" },
  });

  const rows = memberships.map((m) => ({ ...m, id: m.id }));

  const roleOptions = Object.fromEntries(ROLES.map((r) => [r, t(`roles.${r}`)])) as Record<Role, string>;

  const resetLabels: ResetPasswordLabels = {
    resetPassword: t("settings.resetPassword"), newPassword: t("team.newPassword"),
    resetConfirmTitle: t("team.resetConfirmTitle"), resetConfirmMessageTemplate: t("team.resetConfirmMessageTemplate"),
    dismiss: t("app.cancel"), confirm: t("app.confirm"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.PASSWORD_TOO_SHORT": t("errors.PASSWORD_TOO_SHORT"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
    },
  };

  const columns: Column<typeof rows[number]>[] = [
    { key: "name", header: t("team.member"), render: (m) => m.user.fullName },
    { key: "email", header: t("suppliers.email"), render: (m) => m.user.email },
    { key: "role", header: t("settings.role"), render: (m) => t(`roles.${m.role as Role}`) },
    {
      key: "lastLogin", header: t("team.lastLogin"),
      // lastLoginAt is an INSTANT (see format.ts's own doc comment), not a
      // business-date column bucketed by UTC day — the viewer's own wall
      // clock is correct here, matching products/page.tsx's `updatedAt`
      // column (Stage 1B review, minors).
      render: (m) => (m.user.lastLoginAt ? formatDate(m.user.lastLoginAt, locale) : t("team.never")),
    },
    {
      // Rendered for the OWNER row ONLY when the viewer IS that owner —
      // /settings/team is the only password-setting surface in Stage 1 (no
      // forgot-password route, no self-service change, no profile page), so
      // hiding it unconditionally for OWNER would strand an owner who
      // forgets their own password with no recovery path at all. An ADMIN
      // (who also holds users.manage) still never sees it on the owner's
      // row. setUserPasswordAction re-enforces the identical
      // `target.userId !== ctx.userId` exception server-side; hiding the
      // button here is convenience, not the boundary.
      key: "actions", header: t("app.actions"), align: "end",
      render: (m) => (
        m.role === "OWNER" && m.user.id !== ctx.userId ? null : (
          <ResetPasswordButton userId={m.user.id} userName={m.user.fullName} labels={resetLabels} />
        )
      ),
    },
  ];

  const inviteLabels: InviteUserFormLabels = {
    fullName: t("auth.fullName"), email: t("suppliers.email"), tempPassword: t("team.tempPassword"),
    role: t("settings.role"), roleOptions,
    inviteUser: t("settings.inviteUser"), save: t("app.save"), cancel: t("app.cancel"), confirm: t("app.confirm"), loading: t("app.loading"),
    inviteConfirmTitle: t("team.inviteConfirmTitle"), inviteConfirmMessage: t("team.inviteConfirmMessage"),
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.EMAIL_ALREADY_REGISTERED": t("errors.EMAIL_ALREADY_REGISTERED"),
      "errors.PASSWORD_TOO_SHORT": t("errors.PASSWORD_TOO_SHORT"),
      "errors.INVALID_ROLE": t("errors.INVALID_ROLE"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
    },
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-navy">{t("team.title")}</h1>
      </div>

      <div className="mb-4">
        {/* Only the OWNER may invite another OWNER — inviteUserAction
            re-enforces this server-side; this list is convenience only. */}
        <InviteUserForm roles={ctx.role === "OWNER" ? [...ROLES] : ROLES.filter((r) => r !== "OWNER")} labels={inviteLabels} />
      </div>

      <DataTable columns={columns} rows={rows} empty={<EmptyState message={t("team.empty")} />} />
    </div>
  );
}
