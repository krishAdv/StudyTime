import { BarChart3, FolderTree, History, LayoutDashboard, Settings, type LucideIcon } from "lucide-react";

export type NavItem = { href: string; label: string; icon: LucideIcon };

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/classes", label: "Classes", icon: FolderTree },
  { href: "/history", label: "History", icon: History },
  { href: "/insights", label: "Insights", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];
