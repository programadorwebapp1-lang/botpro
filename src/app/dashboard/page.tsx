import { DashboardShell } from "@/components/dashboard-shell";
import { DashboardClient } from "@/components/dashboard-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function DashboardPage() {
  const authToken = process.env.API_TOKEN ?? process.env.WHATSAPP_API_TOKEN ?? process.env.ERP_API_TOKEN ?? "";

  return (
    <DashboardShell>
      <DashboardClient authToken={authToken} />
    </DashboardShell>
  );
}
