import { ArrowLeft } from "lucide-react";

export function PageHeader({
  title,
  description,
  action,
  back,
  accent,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  /** Optional back arrow shown before the title, e.g. { label: "Back to Math", onClick }. */
  back?: { label: string; onClick: () => void };
  /** Optional color bar before the title, e.g. the class color on a class page. */
  accent?: string;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-1">
        {back && (
          <button
            type="button"
            onClick={back.onClick}
            aria-label={back.label}
            title={back.label}
            className="-ml-2 mt-px flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:mt-0.5"
          >
            <ArrowLeft className="h-5 w-5" aria-hidden />
          </button>
        )}
        {accent && (
          <span
            data-testid="page-accent"
            aria-hidden
            className="mr-2 mt-1.5 h-7 w-1.5 shrink-0 rounded-full sm:h-8"
            style={{ backgroundColor: accent }}
          />
        )}
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}
