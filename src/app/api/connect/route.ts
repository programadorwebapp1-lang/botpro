import { NextResponse } from "next/server";
import { startBaileysSession } from "@/lib/baileys";

export const runtime = "nodejs";

export async function POST() {
  try {
    await startBaileysSession();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erro" }, { status: 500 });
  }
}
