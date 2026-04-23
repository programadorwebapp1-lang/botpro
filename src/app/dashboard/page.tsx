import { DashboardShell } from "@/components/dashboard-shell";
import { DashboardClient } from "@/components/dashboard-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return (
    <DashboardShell>
      <DashboardClient />
    </DashboardShell>
  );
}
