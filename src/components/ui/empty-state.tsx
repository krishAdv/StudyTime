export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-border px-6 py-12 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {icon}
      </div>
      <h3 className="font-medium">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
