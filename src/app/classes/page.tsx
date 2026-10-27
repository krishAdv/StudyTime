import type { Metadata } from "next";
import { ClassesView } from "@/features/classes/classes-view";

export const metadata: Metadata = { title: "Classes" };

export default function ClassesPage() {
  return <ClassesView />;
}
