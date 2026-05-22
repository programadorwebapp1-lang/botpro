import { NextResponse } from "next/server";
import { connectMongo } from "./mongo";
import {
  getCompanyLogs,
  getSessionStatus,
  sendWhatsAppMessage,
  startBaileysSession,
  updateSessionMetadata,
} from "./baileys";
import { requireApiToken } from "./auth";

type SendMessagePayload = {
  number: string;
  message: string;
};

type CreateSessionPayload = {
  name: string;
};

function jsonError(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isFormContentType(contentType: string | null) {
  return Boolean(contentType && (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")));
}

async function parseSendMessagePayload(request: Request): Promise<SendMessagePayload> {
  const contentType = request.headers.get("content-type");

  if (isFormContentType(contentType)) {
    const formData = await request.formData().catch(() => null);
    if (!formData || Array.from(formData.keys()).length === 0) {
      throw new Error("Corpo da requisicao vazio");
    }

    return {
      number: normalizeString(formData.get("number")) || normalizeString(formData.get("numero")),
      message: normalizeString(formData.get("message")) || normalizeString(formData.get("mensagem")),
    };
  }

  const rawBody = await request.text();
  if (!rawBody.trim()) {
    throw new Error("Corpo da requisicao vazio");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error("JSON invalido no corpo da requisicao");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Body invalido");
  }

  const body = parsed as Record<string, unknown>;
  return {
    number: normalizeString(body.number) || normalizeString(body.numero),
    message: normalizeString(body.message) || normalizeString(body.mensagem),
  };
}

async function parseCreateSessionPayload(request: Request): Promise<CreateSessionPayload> {
  const contentType = request.headers.get("content-type");

  if (isFormContentType(contentType)) {
    const formData = await request.formData().catch(() => null);
    if (!formData || Array.from(formData.keys()).length === 0) {
      throw new Error("Corpo da requisicao vazio");
    }

    return {
      name: normalizeString(formData.get("name")),
    };
  }

  const rawBody = await request.text();
  if (!rawBody.trim()) {
    throw new Error("Corpo da requisicao vazio");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error("JSON invalido no corpo da requisicao");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Body invalido");
  }

  const body = parsed as Record<string, unknown>;
  return {
    name: normalizeString(body.name),
  };
}

function formatStatusResponse(status: Awaited<ReturnType<typeof getSessionStatus>>) {
  return {
    ok: true,
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

export async function handleSessionStatusRequest(request: Request) {
  const authResponse = requireApiToken(request);
  if (authResponse) return authResponse;

  try {
    const status = await getSessionStatus();
    return NextResponse.json(formatStatusResponse(status));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Falha ao obter status da sessao";
    console.error("[sessions/status] failed", detail);
    return jsonError(500, detail);
  }
}

export async function handleCreateSessionRequest(request: Request) {
  const authResponse = requireApiToken(request);
  if (authResponse) return authResponse;

  try {
    const { name } = await parseCreateSessionPayload(request);

    if (name) {
      await updateSessionMetadata({ name });
    }
    await startBaileysSession();

    const status = await getSessionStatus();
    return NextResponse.json({
      ...formatStatusResponse(status),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Erro ao criar sessao";
    const normalized = detail.toLowerCase();
    const status = normalized.includes("invalido") || normalized.includes("vazio") ? 400 : 500;

    console.error("[sessions/create] failed", detail);
    return jsonError(status, detail);
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
      return jsonError(400, "Campos obrigatorios ausentes: number e message");
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
    const status =
      normalized.includes("invalido") ||
      normalized.includes("vazia") ||
      normalized.includes("vazio") ||
      normalized.includes("ausentes") ||
      normalized.includes("obrigatorio")
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

export async function handleHealthRequest() {
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
