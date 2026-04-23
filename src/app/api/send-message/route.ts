import { NextResponse } from "next/server";
import { sendWhatsAppMessage } from "@/lib/baileys";
import { requireApiToken } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const authResponse = requireApiToken(request);
    if (authResponse) return authResponse;
    const body = await request.json();
    const { numero, mensagem } = body ?? {};
    if (!numero || !mensagem) {
      return NextResponse.json({ error: "Campos obrigatórios ausentes" }, { status: 400 });
    }
    const result = await sendWhatsAppMessage(numero, mensagem);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erro" }, { status: 500 });
  }
}
