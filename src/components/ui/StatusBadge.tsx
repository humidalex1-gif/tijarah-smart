export function StatusBadge({
  label, tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  const classes = {
    neutral: "bg-surface text-muted border-line",
    success: "bg-success/10 text-success border-success/20",
    warning: "bg-warning/10 text-warning border-warning/20",
    danger: "bg-danger/10 text-danger border-danger/20",
  }[tone];

  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${classes}`}>
      {/* A dot as well as colour, so status is not colour-only. */}
      <span className="me-1.5 h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
