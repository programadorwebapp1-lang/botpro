import { NextResponse } from "next/server";
import { connectMongo } from "@/lib/mongo";
import { getSessionStatus } from "@/lib/baileys";

export const runtime = "nodejs";

export async function GET() {
  const health = {
    ok: true,
    uptime: process.uptime(),
    mongo: false,
    whatsapp: "unknown",
  };

  try {
    await connectMongo();
    health.mongo = true;
  } catch {
    health.mongo = false;
  }

  try {
    const status = await getSessionStatus();
    health.whatsapp = status.status;
  } catch {
    health.whatsapp = "error";
  }

  return NextResponse.json(health);
}
