import { PageHeader } from "@/components/ui/page-header";
import { TimerCard } from "@/features/timer/timer-card";
import { TodaySummary } from "@/features/timer/today-summary";

export default function DashboardPage() {
  return (
    <>
      <PageHeader title="Dashboard" description="Pick a class, start the timer, and focus." />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <TimerCard />
        <TodaySummary />
      </div>
      <p className="mt-6 text-center text-xs text-muted-foreground">
        Sessions are saved in this browser on this device only. They don’t sync to other devices.
      </p>
    </>
  );
}
