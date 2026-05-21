import { NextResponse } from "next/server";
import { getCompanyLogs, getSessionStatus, sendWhatsAppMessage, startBaileysSession } from "./baileys";
import { requireApiToken } from "./auth";

type SendMessagePayload = {
  number: string;
  message: string;
};

function jsonError(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isFormContentType(contentType: string | null) {
  if (!contentType) {
    return false;
  }

  return contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded");
}

async function parseSendMessagePayload(request: Request): Promise<SendMessagePayload> {
  const contentType = request.headers.get("content-type");

  if (isFormContentType(contentType)) {
    const formData = await request.formData().catch(() => null);
    if (!formData || Array.from(formData.keys()).length === 0) {
      throw new Error("Corpo da requisição vazio");
    }

    const number = normalizeString(formData.get("number")) || normalizeString(formData.get("numero"));
    const message = normalizeString(formData.get("message")) || normalizeString(formData.get("mensagem"));
    return { number, message };
  }

  const rawBody = await request.text();
  if (!rawBody.trim()) {
    throw new Error("Corpo da requisição vazio");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error("JSON inválido no corpo da requisição");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Body inválido");
  }

  const body = parsed as Record<string, unknown>;
  const number = normalizeString(body.number) || normalizeString(body.numero);
  const message = normalizeString(body.message) || normalizeString(body.mensagem);
  return { number, message };
}

function formatStatusResponse(status: Awaited<ReturnType<typeof getSessionStatus>>) {
  return {
    ...status,
    connected: status.status === "connected",
    phone: status.numero ?? null,
  };
}

export async function handleStatusRequest(request: Request) {
  const authResponse = requireApiToken(request);
  if (authResponse) return authResponse;

  try {
    const status = await getSessionStatus();
    return NextResponse.json(formatStatusResponse(status));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Falha ao obter status";
    console.error("[status] failed", detail);
    return jsonError(500, detail);
  }
}

export async function handleLogsRequest(request: Request) {
  const authResponse = requireApiToken(request);
  if (authResponse) return authResponse;

  try {
    return NextResponse.json({ logs: await getCompanyLogs() });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Falha ao obter logs";
    console.error("[logs] failed", detail);
    return jsonError(500, detail);
  }
}

export async function handleSendMessageRequest(request: Request) {
  const authResponse = requireApiToken(request);
  if (authResponse) return authResponse;

  try {
    const { number, message } = await parseSendMessagePayload(request);

    if (!number || !message) {
      console.warn("[send-message] validation failed: missing fields", {
        hasNumber: Boolean(number),
        hasMessage: Boolean(message),
      });
      return jsonError(400, "Campos obrigatórios ausentes: number e message");
    }

    console.info("[send-message] request accepted", {
      number,
      messageLength: message.length,
    });

    const result = await sendWhatsAppMessage(number, message);

    return NextResponse.json({
      ok: true,
      status: "sent",
      number,
      message,
      message_id: result.message_id,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Erro ao enviar mensagem";
    const normalized = detail.toLowerCase();
    const status = normalized.includes("inválido") || normalized.includes("vazia") || normalized.includes("ausentes")
      ? 400
      : 500;

    console.error("[send-message] failed", detail);
    return jsonError(status, detail);
  }
}

export async function handleConnectRequest(request: Request) {
  const authResponse = requireApiToken(request);
  if (authResponse) return authResponse;

  try {
    await startBaileysSession();
    return NextResponse.json({ ok: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Erro";
    console.error("[connect] failed", detail);
    return jsonError(500, detail);
  }
}
