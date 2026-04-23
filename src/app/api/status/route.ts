import { NextResponse } from "next/server";
import { getSessionStatus } from "@/lib/baileys";
import { requireApiToken } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const authResponse = requireApiToken(request);
    if (authResponse) return authResponse;
    return NextResponse.json(await getSessionStatus());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erro" }, { status: 500 });
  }
}
