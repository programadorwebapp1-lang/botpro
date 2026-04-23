import { NextResponse } from "next/server";
import { getCompanyLogs } from "@/lib/baileys";
import { requireApiToken } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const authResponse = requireApiToken(request);
    if (authResponse) return authResponse;
    return NextResponse.json({ logs: await getCompanyLogs() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erro" }, { status: 500 });
  }
}
