import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn("rounded-2xl border border-border bg-card p-5 sm:p-6", className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 className={cn("text-sm font-semibold tracking-tight", className)} {...props} />;
}
