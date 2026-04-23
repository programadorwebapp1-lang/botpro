import { NextResponse } from "next/server";
import { startBaileysSession } from "@/lib/baileys";
import { requireApiToken } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const authResponse = requireApiToken(request);
    if (authResponse) return authResponse;
    await startBaileysSession();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erro" }, { status: 500 });
  }
}
