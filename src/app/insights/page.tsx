import type { Metadata } from "next";
import { InsightsView } from "@/features/insights/insights-view";

export const metadata: Metadata = { title: "Insights" };

export default function InsightsPage() {
  return <InsightsView />;
}
