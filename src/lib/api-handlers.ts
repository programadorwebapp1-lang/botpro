import { NextResponse } from "next/server";
import {
  getCompanyLogs,
  getSessionStatus,
  sendWhatsAppMessage,
  startBaileysSession,
  updateSessionMetadata,
} from "./baileys";
import { requireApiToken } from "./auth";
import { DEFAULT_TENANT_ID } from "./app-config";
import { connectMongo } from "./mongo";

type SendMessagePayload = {
  number: string;
  message: string;
  tenantId: string;
};

type CreateSessionPayload = {
  tenantId: string;
  sessionId: string;
  name: string;
};

function jsonError(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveTenantId(value: unknown) {
  return normalizeString(value) || DEFAULT_TENANT_ID;
}

function requireTenantId(value: unknown, message = "tenant_id e obrigatorio") {
  const tenantId = normalizeString(value);
  if (!tenantId) {
    throw new Error(message);
  }
  return tenantId;
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
    const tenantId = resolveTenantId(formData.get("tenant_id") ?? formData.get("tenantId"));
    return { number, message, tenantId };
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
  const tenantId = resolveTenantId(body.tenant_id ?? body.tenantId);
  return { number, message, tenantId };
}

async function parseCreateSessionPayload(request: Request): Promise<CreateSessionPayload> {
  const contentType = request.headers.get("content-type");

  if (isFormContentType(contentType)) {
    const formData = await request.formData().catch(() => null);
    if (!formData || Array.from(formData.keys()).length === 0) {
      throw new Error("Corpo da requisicao vazio");
    }

    const tenantId = requireTenantId(formData.get("tenant_id") ?? formData.get("tenantId"));
    const sessionId = normalizeString(formData.get("session_id") ?? formData.get("sessionId"));
    if (sessionId && sessionId !== tenantId) {
      throw new Error("session_id deve ser igual a tenant_id");
    }

    return {
      tenantId,
      sessionId,
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
  const tenantId = requireTenantId(body.tenant_id ?? body.tenantId);
  const sessionId = normalizeString(body.session_id ?? body.sessionId);
  if (sessionId && sessionId !== tenantId) {
    throw new Error("session_id deve ser igual a tenant_id");
  }

  return {
    tenantId,
    sessionId,
    name: normalizeString(body.name),
  };
}

function formatStatusResponse(status: Awaited<ReturnType<typeof getSessionStatus>>) {
  return {
    ok: true,
    ...status,
    tenant_id: status.tenant_id,
    connected: status.status === "connected",
    phone: status.numero ?? null,
  };
}

function resolveRequestTenantId(request: Request) {
  const url = new URL(request.url);
  return resolveTenantId(url.searchParams.get("tenant_id") ?? url.searchParams.get("tenantId"));
}

async function resolveConnectTenantId(request: Request) {
  const contentType = request.headers.get("content-type");

  if (isFormContentType(contentType)) {
    const formData = await request.formData().catch(() => null);
    if (!formData) {
      return resolveRequestTenantId(request);
    }
    return resolveTenantId(formData.get("tenant_id") ?? formData.get("tenantId"));
  }

  if (contentType?.includes("application/json")) {
    const rawBody = await request.text();
    if (!rawBody.trim()) {
      return resolveRequestTenantId(request);
    }

    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      return resolveTenantId(parsed.tenant_id ?? parsed.tenantId);
    } catch {
      return resolveRequestTenantId(request);
    }
  }

  return resolveRequestTenantId(request);
}

export async function handleStatusRequest(request: Request) {
  const authResponse = requireApiToken(request);
  if (authResponse) return authResponse;

  try {
    const status = await getSessionStatus(resolveRequestTenantId(request));
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
    const url = new URL(request.url);
    const tenantId = requireTenantId(url.searchParams.get("tenant_id") ?? url.searchParams.get("tenantId"));
    const status = await getSessionStatus(tenantId);
    return NextResponse.json(formatStatusResponse(status));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Falha ao obter status da sessao";
    const status = detail.toLowerCase().includes("obrigatorio") ? 400 : 500;
    console.error("[sessions/status] failed", detail);
    return jsonError(status, detail);
  }
}

export async function handleCreateSessionRequest(request: Request) {
  const authResponse = requireApiToken(request);
  if (authResponse) return authResponse;

  try {
    const { tenantId, sessionId, name } = await parseCreateSessionPayload(request);

    if (name) {
      await updateSessionMetadata(tenantId, { name });
    }
    await startBaileysSession(tenantId);

    const status = await getSessionStatus(tenantId);
    return NextResponse.json({
      requested_session_id: sessionId || null,
      ...formatStatusResponse(status),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Erro ao criar sessao";
    const normalized = detail.toLowerCase();
    const status =
      normalized.includes("obrigatorio") ||
      normalized.includes("invalido") ||
      normalized.includes("vazio") ||
      normalized.includes("igual")
      ? 400
      : 500;

    console.error("[sessions/create] failed", detail);
    return jsonError(status, detail);
  }
}

export async function handleLogsRequest(request: Request) {
  const authResponse = requireApiToken(request);
  if (authResponse) return authResponse;

  try {
    return NextResponse.json({ logs: await getCompanyLogs(resolveRequestTenantId(request)) });
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
    const { number, message, tenantId } = await parseSendMessagePayload(request);

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

    const result = await sendWhatsAppMessage(number, message, tenantId);

    return NextResponse.json({
      ok: true,
      status: "sent",
      number,
      message,
      tenant_id: tenantId,
      session_id: tenantId,
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
    const tenantId = await resolveConnectTenantId(request);
    await startBaileysSession(tenantId);
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
