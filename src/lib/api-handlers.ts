import { NextResponse } from "next/server";
import { getCompanyLogs, getSessionStatus, sendWhatsAppMessage, startBaileysSession } from "./baileys";
import { requireApiToken } from "./auth";

export async function handleStatusRequest(request: Request) {
  const authResponse = requireApiToken(request);
  if (authResponse) return authResponse;
  return NextResponse.json(await getSessionStatus());
}

export async function handleLogsRequest(request: Request) {
  const authResponse = requireApiToken(request);
  if (authResponse) return authResponse;
  return NextResponse.json({ logs: await getCompanyLogs() });
}

export async function handleSendMessageRequest(request: Request) {
  const authResponse = requireApiToken(request);
  if (authResponse) return authResponse;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }
  const { numero, mensagem } = body ?? {};

  if (typeof numero !== "string" || typeof mensagem !== "string") {
    return NextResponse.json({ error: "Campos obrigatórios ausentes" }, { status: 400 });
  }

  try {
    const result = await sendWhatsAppMessage(numero, mensagem);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erro ao enviar mensagem" }, { status: 500 });
  }
}

export async function handleConnectRequest(request: Request) {
  const authResponse = requireApiToken(request);
  if (authResponse) return authResponse;

  try {
    await startBaileysSession();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erro" }, { status: 500 });
  }
}
