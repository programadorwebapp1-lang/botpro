import { getWebhookVerifyToken, handleWebhookPayload } from "@/lib/meta";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const verifyToken = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && verifyToken && verifyToken === getWebhookVerifyToken() && challenge) {
    return new Response(challenge, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  return NextResponse.json(
    {
      ok: false,
      error: "Webhook verify token invalido",
    },
    { status: 403 }
  );
}

export async function POST(request: Request) {
  try {
    const payload = await request.json();
    const result = await handleWebhookPayload(payload);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Falha ao processar webhook";
    return NextResponse.json({ ok: false, error: detail }, { status: 400 });
  }
}
