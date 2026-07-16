import { NextResponse } from "next/server";
import { getCompanyLogs, getStatus, sendDocument, sendImage, sendMessage, sendTemplate, validateToken } from "./meta";
import { requireApiToken } from "./auth";

type SendTextPayload = {
  number: string;
  message: string;
};

type SendDocumentPayload = {
  number: string;
  document: string;
  filename?: string;
  caption?: string;
};

type SendImagePayload = {
  number: string;
  image: string;
  caption?: string;
};

type SendTemplatePayload = {
  number: string;
  name: string;
  language: string;
  components?: Array<Record<string, unknown>>;
};

type CreateSessionPayload = {
  name?: string;
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

async function parseBody(request: Request) {
  const contentType = request.headers.get("content-type");

  if (isFormContentType(contentType)) {
    const formData = await request.formData().catch(() => null);
    if (!formData || Array.from(formData.keys()).length === 0) {
      throw new Error("Corpo da requisicao vazio");
    }

    return Object.fromEntries(formData.entries()) as Record<string, FormDataEntryValue>;
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

  return parsed as Record<string, unknown>;
}

function readNestedObject(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

async function parseSendTextPayload(request: Request): Promise<SendTextPayload> {
  const body = await parseBody(request);
  return {
    number: normalizeString(body.number) || normalizeString(body.numero),
    message: normalizeString(body.message) || normalizeString(body.mensagem),
  };
}

async function parseSendDocumentPayload(request: Request): Promise<SendDocumentPayload> {
  const body = await parseBody(request);
  return {
    number: normalizeString(body.number) || normalizeString(body.numero),
    document: normalizeString(body.document) || normalizeString(body.url),
    filename: normalizeString(body.filename),
    caption: normalizeString(body.caption),
  };
}

async function parseSendImagePayload(request: Request): Promise<SendImagePayload> {
  const body = await parseBody(request);
  return {
    number: normalizeString(body.number) || normalizeString(body.numero),
    image: normalizeString(body.image) || normalizeString(body.url),
    caption: normalizeString(body.caption),
  };
}

async function parseSendTemplatePayload(request: Request): Promise<SendTemplatePayload> {
  const body = await parseBody(request);
  const template = readNestedObject(body, "template") ?? body;

  const components = Array.isArray(template.components) ? (template.components as Array<Record<string, unknown>>) : undefined;

  return {
    number: normalizeString(body.number) || normalizeString(body.numero),
    name: normalizeString(template.name) || normalizeString(body.name),
    language: normalizeString(template.language) || normalizeString(body.language),
    components,
  };
}

function formatStatusResponse(status: Awaited<ReturnType<typeof getStatus>>) {
  return {
    ok: true,
    ...status,
  };
}

export async function handleStatusRequest(request: Request) {
  const authResponse = requireApiToken(request);
  if (authResponse) return authResponse;

  try {
    return NextResponse.json(formatStatusResponse(await getStatus()));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Falha ao obter status";
    console.error("[status] failed", detail);
    return jsonError(500, detail);
  }
}

export async function handleSessionStatusRequest(request: Request) {
  return handleStatusRequest(request);
}

export async function handleCreateSessionRequest(request: Request) {
  const authResponse = requireApiToken(request);
  if (authResponse) return authResponse;

  try {
    const payload = (await parseBody(request)) as CreateSessionPayload;
    const status = await getStatus();

    return NextResponse.json({
      ok: true,
      ...status,
      name: normalizeString(payload.name) || null,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Erro ao validar credenciais";
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
    const { number, message } = await parseSendTextPayload(request);

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

    const result = await sendMessage({ number, message });

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

export async function handleSendDocumentRequest(request: Request) {
  const authResponse = requireApiToken(request);
  if (authResponse) return authResponse;

  try {
    const payload = await parseSendDocumentPayload(request);

    if (!payload.number || !payload.document) {
      return jsonError(400, "Campos obrigatorios ausentes: number e document");
    }

    const result = await sendDocument(payload);
    return NextResponse.json({
      ok: true,
      status: "sent",
      number: payload.number,
      document: payload.document,
      filename: payload.filename ?? null,
      caption: payload.caption ?? null,
      message_id: result.message_id,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Erro ao enviar documento";
    const normalized = detail.toLowerCase();
    const status =
      normalized.includes("invalido") ||
      normalized.includes("vazio") ||
      normalized.includes("ausentes") ||
      normalized.includes("obrigatorio")
        ? 400
        : 500;

    console.error("[send-document] failed", detail);
    return jsonError(status, detail);
  }
}

export async function handleSendImageRequest(request: Request) {
  const authResponse = requireApiToken(request);
  if (authResponse) return authResponse;

  try {
    const payload = await parseSendImagePayload(request);

    if (!payload.number || !payload.image) {
      return jsonError(400, "Campos obrigatorios ausentes: number e image");
    }

    const result = await sendImage(payload);
    return NextResponse.json({
      ok: true,
      status: "sent",
      number: payload.number,
      image: payload.image,
      caption: payload.caption ?? null,
      message_id: result.message_id,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Erro ao enviar imagem";
    const normalized = detail.toLowerCase();
    const status =
      normalized.includes("invalido") ||
      normalized.includes("vazio") ||
      normalized.includes("ausentes") ||
      normalized.includes("obrigatorio")
        ? 400
        : 500;

    console.error("[send-image] failed", detail);
    return jsonError(status, detail);
  }
}

export async function handleSendTemplateRequest(request: Request) {
  const authResponse = requireApiToken(request);
  if (authResponse) return authResponse;

  try {
    const payload = await parseSendTemplatePayload(request);

    if (!payload.number || !payload.name || !payload.language) {
      return jsonError(400, "Campos obrigatorios ausentes: number, name e language");
    }

    const result = await sendTemplate(payload);
    return NextResponse.json({
      ok: true,
      status: "sent",
      number: payload.number,
      template: {
        name: payload.name,
        language: payload.language,
        components: payload.components ?? [],
      },
      message_id: result.message_id,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Erro ao enviar template";
    const normalized = detail.toLowerCase();
    const status =
      normalized.includes("invalido") ||
      normalized.includes("vazio") ||
      normalized.includes("ausentes") ||
      normalized.includes("obrigatorio")
        ? 400
        : 500;

    console.error("[send-template] failed", detail);
    return jsonError(status, detail);
  }
}

export async function handleConnectRequest(request: Request) {
  const authResponse = requireApiToken(request);
  if (authResponse) return authResponse;

  try {
    const validation = await validateToken();
    return NextResponse.json({
      ok: true,
      ...validation,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Erro";
    console.error("[connect] failed", detail);
    return jsonError(500, detail);
  }
}

export async function handleHealthRequest() {
  return NextResponse.json({
    status: "ok",
    provider: "meta",
  });
}
