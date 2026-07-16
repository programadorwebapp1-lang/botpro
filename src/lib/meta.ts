import MessageLog from "@/models/MessageLog";
import { connectMongo } from "./mongo";
import { emitRealtime } from "./realtime";

type MetaConfig = {
  accessToken: string;
  phoneNumberId: string;
  businessId: string;
  apiVersion: string;
  webhookVerifyToken: string;
};

type MetaRequestResult<T = unknown> = {
  ok: boolean;
  status: number;
  data: T | null;
  raw: string;
  error: string | null;
};

type WriteLogPayload = {
  endpoint: string;
  numero?: string | null;
  status: string;
  http_status: number;
  response?: unknown;
  error?: string | null;
  direction?: "inbound" | "outbound";
  provider_message_id?: string | null;
};

type ValidationResult = {
  connected: boolean;
  provider: "meta";
  phone: string | null;
  status: "connected" | "disconnected";
  tokenValid: boolean;
  phoneNumberIdValid: boolean;
  apiAccessible: boolean;
  businessValid: boolean | null;
  lastError: string | null;
  httpStatus: number | null;
  meta: {
    displayPhoneNumber: string | null;
    verifiedName: string | null;
    businessName: string | null;
  };
};

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

const DEFAULT_API_VERSION = "v23.0";
const REQUEST_TIMEOUT_MS = Number(process.env.META_REQUEST_TIMEOUT_MS ?? 15000);
const MESSAGE_DEDUPE_WINDOW_MS = Number(process.env.META_MESSAGE_DEDUPE_WINDOW_MS ?? 15000);
const MAX_MESSAGE_LENGTH = Number(process.env.META_MAX_MESSAGE_LENGTH ?? 4096);

const recentMessages = new Map<string, number>();

function getMetaConfig(): MetaConfig {
  return {
    accessToken: process.env.META_ACCESS_TOKEN ?? "",
    phoneNumberId: process.env.META_PHONE_NUMBER_ID ?? "",
    businessId: process.env.META_BUSINESS_ID ?? "",
    apiVersion: process.env.META_API_VERSION ?? DEFAULT_API_VERSION,
    webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN ?? "",
  };
}

function normalizePhoneNumber(input: string) {
  return input.replace(/\D/g, "");
}

function isValidPhoneNumber(input: string) {
  const digits = normalizePhoneNumber(input);
  return /^\d{12,15}$/.test(digits);
}

function trimString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function tryParseJson(raw: string) {
  if (!raw.trim()) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function extractErrorMessage(data: unknown, fallback: string) {
  if (!data || typeof data !== "object") {
    return fallback;
  }

  const error = (data as Record<string, unknown>).error;
  if (error && typeof error === "object") {
    const errorObject = error as Record<string, unknown>;
    const message = trimString(errorObject.message);
    const details = trimString(errorObject.error_data);
    return message || details || fallback;
  }

  return fallback;
}

function buildUrl(path: string) {
  const config = getMetaConfig();
  const normalizedPath = path.replace(/^\/+/, "");
  return `https://graph.facebook.com/${config.apiVersion}/${normalizedPath}`;
}

function pruneRecentMessages() {
  const now = Date.now();
  for (const [key, timestamp] of recentMessages.entries()) {
    if (now - timestamp > MESSAGE_DEDUPE_WINDOW_MS * 4) {
      recentMessages.delete(key);
    }
  }
}

function trackRecentMessage(numero: string, fingerprint: string) {
  pruneRecentMessages();
  const key = `${numero}:${fingerprint}`;
  const now = Date.now();
  const lastSent = recentMessages.get(key);
  if (lastSent && now - lastSent < MESSAGE_DEDUPE_WINDOW_MS) {
    return false;
  }
  recentMessages.set(key, now);
  return true;
}

async function writeLog(payload: WriteLogPayload) {
  try {
    await connectMongo();
    const log = await MessageLog.create({
      kind: payload.direction ? "message" : payload.status === "error" ? "error" : "system",
      direction: payload.direction,
      numero: payload.numero ?? undefined,
      mensagem: undefined,
      status: payload.status,
      detail: payload.error ?? undefined,
      endpoint: payload.endpoint,
      response: payload.response,
      error: payload.error ?? null,
      http_status: payload.http_status,
      provider_message_id: payload.provider_message_id ?? undefined,
      expire_at: (() => {
        const expireAt = new Date();
        expireAt.setDate(expireAt.getDate() + Number(process.env.MESSAGE_LOG_TTL_DAYS ?? 30));
        return expireAt;
      })(),
    });

    emitRealtime("log:new", { log });
    return log;
  } catch (error) {
    console.error("[meta] log write failed", error);
    return null;
  }
}

async function metaRequest<T>(path: string, init: RequestInit & { endpoint: string; numero?: string | null; logStatus?: string; direction?: "inbound" | "outbound"; providerMessageId?: string | null; }) {
  const config = getMetaConfig();

  if (!config.accessToken) {
    throw new Error("META_ACCESS_TOKEN is not defined");
  }

  const url = buildUrl(path);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.accessToken}`);

  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      headers,
      signal: controller.signal,
    });

    const raw = await response.text();
    const data = tryParseJson(raw) as T | null;
    const error = response.ok ? null : extractErrorMessage(data, raw || `HTTP ${response.status}`);

    await writeLog({
      endpoint: init.endpoint,
      numero: init.numero ?? null,
      status: init.logStatus ?? (response.ok ? "ok" : "error"),
      http_status: response.status,
      response: data ?? raw,
      error,
      direction: init.direction,
      provider_message_id: init.providerMessageId ?? null,
    });

    return {
      ok: response.ok,
      status: response.status,
      data,
      raw,
      error,
    } satisfies MetaRequestResult<T>;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha na comunicacao com a Meta";
    await writeLog({
      endpoint: init.endpoint,
      numero: init.numero ?? null,
      status: "error",
      http_status: 0,
      response: null,
      error: message,
      direction: init.direction,
      provider_message_id: init.providerMessageId ?? null,
    });
    return {
      ok: false,
      status: 0,
      data: null,
      raw: "",
      error: message,
    } satisfies MetaRequestResult<T>;
  } finally {
    clearTimeout(timeout);
  }
}

function requirePhoneNumberId() {
  const config = getMetaConfig();
  if (!config.phoneNumberId) {
    throw new Error("META_PHONE_NUMBER_ID is not defined");
  }
  return config.phoneNumberId;
}

function buildTextBody(message: string) {
  return {
    messaging_product: "whatsapp",
    to: "",
    type: "text",
    text: {
      body: message,
    },
  };
}

function buildDocumentBody(payload: SendDocumentPayload) {
  return {
    messaging_product: "whatsapp",
    to: "",
    type: "document",
    document: {
      link: payload.document,
      filename: payload.filename,
      caption: payload.caption,
    },
  };
}

function buildImageBody(payload: SendImagePayload) {
  return {
    messaging_product: "whatsapp",
    to: "",
    type: "image",
    image: {
      link: payload.image,
      caption: payload.caption,
    },
  };
}

function buildTemplateBody(payload: SendTemplatePayload) {
  return {
    messaging_product: "whatsapp",
    to: "",
    type: "template",
    template: {
      name: payload.name,
      language: {
        code: payload.language,
      },
      components: payload.components ?? undefined,
    },
  };
}

async function sendPayload<TResponse>(
  endpoint: string,
  payload: Record<string, unknown>,
  numero: string,
  fingerprint: string
) {
  const normalizedNumber = normalizePhoneNumber(numero);

  if (!isValidPhoneNumber(normalizedNumber)) {
    throw new Error("Numero de telefone invalido");
  }

  if (!trackRecentMessage(normalizedNumber, fingerprint)) {
    throw new Error("Mensagem duplicada bloqueada por anti-spam");
  }

  const phoneNumberId = requirePhoneNumberId();
  const requestPayload = {
    ...payload,
    to: normalizedNumber,
  };

  const response = await metaRequest<TResponse>(`/${phoneNumberId}/messages`, {
    method: "POST",
    body: JSON.stringify(requestPayload),
    endpoint,
    numero: normalizedNumber,
    logStatus: "sent",
    direction: "outbound",
  });

  if (!response.ok) {
    throw new Error(response.error ?? `Meta retornou HTTP ${response.status}`);
  }

  const messageId = (response.data as Record<string, unknown> | null)?.messages;
  const providerMessageId = Array.isArray(messageId) ? ((messageId[0] as Record<string, unknown> | undefined)?.id as string | undefined) : undefined;

  return {
    success: true,
    message_id: providerMessageId ?? null,
    response: response.data,
  };
}

export async function sendMessage(payload: SendTextPayload) {
  const message = payload.message.trim();
  if (!message) {
    throw new Error("Mensagem vazia");
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Mensagem excede o limite de ${MAX_MESSAGE_LENGTH} caracteres`);
  }

  return sendPayload(
    "/send-message",
    buildTextBody(message),
    payload.number,
    `text:${message}`
  );
}

export async function sendDocument(payload: SendDocumentPayload) {
  const document = trimString(payload.document);
  if (!document) {
    throw new Error("Documento vazio");
  }

  const filename = trimString(payload.filename);
  const caption = trimString(payload.caption);

  return sendPayload(
    "/send-document",
    buildDocumentBody({
      ...payload,
      document,
      filename: filename || undefined,
      caption: caption || undefined,
    }),
    payload.number,
    `document:${document}:${filename}:${caption}`
  );
}

export async function sendImage(payload: SendImagePayload) {
  const image = trimString(payload.image);
  if (!image) {
    throw new Error("Imagem vazia");
  }

  const caption = trimString(payload.caption);

  return sendPayload(
    "/send-image",
    buildImageBody({
      ...payload,
      image,
      caption: caption || undefined,
    }),
    payload.number,
    `image:${image}:${caption}`
  );
}

export async function sendTemplate(payload: SendTemplatePayload) {
  const name = trimString(payload.name);
  const language = trimString(payload.language);

  if (!name) {
    throw new Error("Nome do template vazio");
  }

  if (!language) {
    throw new Error("Idioma do template vazio");
  }

  return sendPayload(
    "/send-template",
    buildTemplateBody({
      ...payload,
      name,
      language,
    }),
    payload.number,
    `template:${name}:${language}:${JSON.stringify(payload.components ?? [])}`
  );
}

export async function validateToken() {
  const phoneNumberId = requirePhoneNumberId();
  const config = getMetaConfig();

  const phoneResult = await metaRequest<{
    display_phone_number?: string;
    verified_name?: string;
  }>(`/${phoneNumberId}?fields=display_phone_number,verified_name`, {
    method: "GET",
    endpoint: "/status",
    logStatus: "validate",
  });

  const businessResult = config.businessId
    ? await metaRequest<{
        name?: string;
      }>(`/${config.businessId}?fields=name`, {
        method: "GET",
        endpoint: "/status",
        logStatus: "validate",
      })
    : null;

  const phoneValid = phoneResult.ok && Boolean(phoneResult.data);
  const businessValid = config.businessId ? Boolean(businessResult?.ok) : null;
  const connected = Boolean(phoneValid && (businessValid !== false));

  return {
    connected,
    provider: "meta" as const,
    phone: phoneResult.data?.display_phone_number ?? null,
    status: connected ? ("connected" as const) : ("disconnected" as const),
    tokenValid: phoneResult.status > 0 && phoneResult.status !== 401 && phoneResult.status !== 403,
    phoneNumberIdValid: phoneResult.ok,
    apiAccessible: phoneResult.status > 0,
    businessValid,
    lastError: phoneResult.error ?? businessResult?.error ?? null,
    httpStatus: phoneResult.status || businessResult?.status || null,
    meta: {
      displayPhoneNumber: phoneResult.data?.display_phone_number ?? null,
      verifiedName: phoneResult.data?.verified_name ?? null,
      businessName: businessResult?.data?.name ?? null,
    },
  } satisfies ValidationResult;
}

export async function getStatus() {
  const validation = await validateToken();

  return {
    connected: validation.connected,
    provider: validation.provider,
    phone: validation.phone,
    status: validation.status,
    numero: validation.phone,
    qr: null,
    lastError: validation.lastError,
    lastConnectedAt: null,
    lastQrAt: null,
    reconnectAttempts: 0,
    nextRetryAt: null,
    validation,
  };
}

export async function getCompanyLogs() {
  await connectMongo();
  return MessageLog.find({}).sort({ created_at: -1 }).limit(200).lean().exec();
}

export function getWebhookVerifyToken() {
  return getMetaConfig().webhookVerifyToken;
}

export async function handleWebhookPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return { processed: 0 };
  }

  const body = payload as {
    object?: string;
    entry?: Array<{
      id?: string;
      changes?: Array<{
        field?: string;
        value?: {
          metadata?: {
            display_phone_number?: string;
            phone_number_id?: string;
          };
          messages?: Array<Record<string, unknown>>;
          statuses?: Array<Record<string, unknown>>;
        };
      }>;
    }>;
  };

  let processed = 0;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const metadata = value?.metadata ?? {};
      const phone = metadata.display_phone_number ?? null;

      for (const message of value?.messages ?? []) {
        processed += 1;
        await writeLog({
          endpoint: "/webhook",
          numero: phone,
          status: "inbound",
          http_status: 200,
          response: {
            object: body.object,
            entryId: entry.id ?? null,
            field: change.field ?? null,
            type: "message",
            message,
          },
          direction: "inbound",
        });

        emitRealtime("meta:message-inbound", { phone, message });
      }

      for (const status of value?.statuses ?? []) {
        processed += 1;
        const statusValue = typeof status.status === "string" ? status.status : "status";
        await writeLog({
          endpoint: "/webhook",
          numero: phone,
          status: statusValue,
          http_status: 200,
          response: {
            object: body.object,
            entryId: entry.id ?? null,
            field: change.field ?? null,
            type: "status",
            status,
          },
          error: statusValue === "failed" ? JSON.stringify(status) : null,
          direction: "outbound",
          provider_message_id: typeof status.id === "string" ? status.id : null,
        });

        emitRealtime("meta:message-status", { phone, status });
      }
    }
  }

  return { processed };
}
