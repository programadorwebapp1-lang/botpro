import makeWASocket, {
  BufferJSON,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  proto,
  type AuthenticationState,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from "@whiskeysockets/baileys";
import { delay } from "@whiskeysockets/baileys";
import { connectMongo } from "./mongo";
import { DEFAULT_TENANT_ID, LEGACY_SESSION_ID } from "./app-config";
import { normalizePhoneNumber, jidFromPhone } from "./wa-utils";
import { emitRealtime } from "./realtime";
import WhatsAppSession from "@/models/WhatsAppSession";
import MessageLog from "@/models/MessageLog";

type ConnectionStatus = "idle" | "connecting" | "connected" | "disconnected";

type AuthCache = {
  creds: AuthenticationState["creds"];
  keys: Record<string, Record<string, unknown>>;
};

type RuntimeState = {
  socket: ReturnType<typeof makeWASocket> | null;
  connectPromise: Promise<RuntimeState> | null;
  status: ConnectionStatus;
  qr: string | null;
  lastError: string | null;
  lastQrAt: Date | null;
  lastConnectedAt: Date | null;
  reconnectAttempts: number;
  nextRetryAt: Date | null;
  reconnectTimer: NodeJS.Timeout | null;
  stopRequested: boolean;
  authResetAttempts: number;
  writeChain: Promise<void>;
  socketGeneration: number;
  authCache: AuthCache | null;
};

type ConnectionUpdate = {
  connection?: "close" | "connecting" | "open";
  qr?: string;
  lastDisconnect?: {
    error?: {
      message?: string;
      output?: { statusCode?: number };
    };
  };
};

const SESSION_TENANT_ID = DEFAULT_TENANT_ID;
const SESSION_ID = LEGACY_SESSION_ID;
const MESSAGE_LOG_TTL_DAYS = Number(process.env.MESSAGE_LOG_TTL_DAYS ?? 30);
const RECONNECT_BASE_DELAY_MS = Number(process.env.WHATSAPP_RECONNECT_BASE_MS ?? 1500);
const RECONNECT_MAX_DELAY_MS = Number(process.env.WHATSAPP_RECONNECT_MAX_MS ?? 60000);
const RECONNECT_MAX_ATTEMPTS = Number(process.env.WHATSAPP_RECONNECT_MAX_ATTEMPTS ?? 8);
const AUTH_RESET_MAX_ATTEMPTS = Number(process.env.WHATSAPP_AUTH_RESET_MAX_ATTEMPTS ?? 2);
const SEND_DELAY_MS = Number(process.env.WHATSAPP_SEND_DELAY_MS ?? 900);
const SEND_WAIT_TIMEOUT_MS = Number(process.env.WHATSAPP_SEND_WAIT_TIMEOUT_MS ?? 15000);
const MESSAGE_DEDUPE_WINDOW_MS = Number(process.env.WHATSAPP_MESSAGE_DEDUPE_WINDOW_MS ?? 15000);
const MAX_MESSAGE_LENGTH = Number(process.env.WHATSAPP_MAX_MESSAGE_LENGTH ?? 4096);

const state = createRuntimeState();
const recentMessages = new Map<string, number>();
let bootPromise: Promise<void> | null = null;

function createRuntimeState(): RuntimeState {
  return {
    socket: null,
    connectPromise: null,
    status: "idle",
    qr: null,
    lastError: null,
    lastQrAt: null,
    lastConnectedAt: null,
    reconnectAttempts: 0,
    nextRetryAt: null,
    reconnectTimer: null,
    stopRequested: false,
    authResetAttempts: 0,
    writeChain: Promise.resolve(),
    socketGeneration: 0,
    authCache: null,
  };
}

function getSessionFilter() {
  return {
    $or: [{ tenant_id: SESSION_TENANT_ID }, { session_id: SESSION_ID }],
  };
}

function getSessionWriteFilter() {
  return { tenant_id: SESSION_TENANT_ID };
}

function getSessionAlias() {
  return SESSION_ID;
}

async function normalizeSessionDocument() {
  await connectMongo();

  const [defaultDoc, legacyDoc] = await Promise.all([
    WhatsAppSession.findOne({ tenant_id: SESSION_TENANT_ID }).lean().exec(),
    WhatsAppSession.findOne({ session_id: SESSION_ID }).lean().exec(),
  ]);

  if (defaultDoc && legacyDoc && String(defaultDoc._id) !== String(legacyDoc._id)) {
    const preferLegacy =
      !isUsableAuthCreds(defaultDoc.creds as Partial<AuthenticationState["creds"]> | null | undefined) &&
      isUsableAuthCreds(legacyDoc.creds as Partial<AuthenticationState["creds"]> | null | undefined);
    const source = preferLegacy ? legacyDoc : defaultDoc;

    await WhatsAppSession.updateOne(
      { _id: defaultDoc._id },
      {
        $set: {
          tenant_id: SESSION_TENANT_ID,
          session_id: SESSION_ID,
          creds: source.creds,
          keys: source.keys,
          status: source.status,
          qr: source.qr ?? null,
          last_error: source.last_error ?? null,
          last_connected_at: source.last_connected_at ?? null,
          last_qr_at: source.last_qr_at ?? null,
          reconnect_attempts: source.reconnect_attempts ?? 0,
          next_retry_at: source.next_retry_at ?? null,
        },
      }
    ).exec();
    return;
  }

  if (defaultDoc) {
    if (defaultDoc.session_id !== SESSION_ID) {
      await WhatsAppSession.updateOne(
        { _id: defaultDoc._id },
        { $set: { tenant_id: SESSION_TENANT_ID, session_id: SESSION_ID } }
      ).exec();
    }
    return;
  }

  if (legacyDoc) {
    await WhatsAppSession.updateOne(
      { _id: legacyDoc._id },
      { $set: { tenant_id: SESSION_TENANT_ID, session_id: SESSION_ID } }
    ).exec();
    return;
  }

  await WhatsAppSession.updateOne(
    { tenant_id: SESSION_TENANT_ID },
    {
      $setOnInsert: {
        tenant_id: SESSION_TENANT_ID,
        session_id: SESSION_ID,
        creds: serializeValue(initAuthCreds()),
        keys: {},
        status: "idle",
        qr: null,
        last_error: null,
        reconnect_attempts: 0,
        next_retry_at: null,
        last_connected_at: null,
        last_qr_at: null,
      },
    },
    { upsert: true }
  ).exec();
}

async function ensureSessionDocument() {
  await normalizeSessionDocument();
}

function serializeValue<T>(value: T) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer)) as T;
}

function reviveValue<T>(value: unknown) {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T;
}

function isUsableAuthCreds(
  creds: Partial<AuthenticationState["creds"]> | null | undefined
): creds is AuthenticationState["creds"] {
  return Boolean(
    creds &&
      creds.noiseKey?.public &&
      creds.signedIdentityKey?.public &&
      creds.signedPreKey?.keyPair?.public &&
      creds.registrationId != null &&
      creds.advSecretKey
  );
}

function isAuthShapeError(error: unknown) {
  const message = error instanceof Error ? `${error.message} ${error.stack ?? ""}` : String(error);
  return message.includes("reading 'public'") || (message.includes("public") && message.includes("baileys"));
}

function encodeAuthId(id: string) {
  return encodeURIComponent(id).replace(/\./g, "%2E").replace(/\$/g, "%24");
}

function clearReconnectTimer(runtime: RuntimeState) {
  if (runtime.reconnectTimer) {
    clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = null;
  }
}

function computeReconnectDelay(attempt: number) {
  const delayMs = RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(delayMs, RECONNECT_MAX_DELAY_MS);
}

function isDisconnectCode(code: number | undefined, reason: number) {
  return code === reason;
}

function parseDisconnect(update: ConnectionUpdate) {
  const code = update.lastDisconnect?.error?.output?.statusCode;
  const message = update.lastDisconnect?.error?.message ?? (typeof code === "number" ? `statusCode:${code}` : "desconhecido");
  return { code, message };
}

function isValidPhoneNumber(input: string) {
  const digits = normalizePhoneNumber(input);
  return /^\d{12,15}$/.test(digits);
}

function buildMessageLogExpireAt() {
  const expireAt = new Date();
  expireAt.setDate(expireAt.getDate() + MESSAGE_LOG_TTL_DAYS);
  return expireAt;
}

function pruneRecentMessages() {
  const now = Date.now();
  for (const [key, timestamp] of recentMessages.entries()) {
    if (now - timestamp > MESSAGE_DEDUPE_WINDOW_MS * 4) {
      recentMessages.delete(key);
    }
  }
}

async function writeMessageLog(payload: {
  kind: "message" | "system" | "error";
  status: string;
  numero?: string;
  mensagem?: string;
  detail?: string;
  direction?: "inbound" | "outbound";
  provider_message_id?: string;
}) {
  const log = await MessageLog.create({
    tenant_id: SESSION_TENANT_ID,
    session_id: SESSION_ID,
    expire_at: buildMessageLogExpireAt(),
    ...payload,
  });
  emitRealtime("log:new", { session_id: SESSION_ID, log });
  return log;
}

async function persistSessionPatch(patch: Record<string, unknown>) {
  state.writeChain = state.writeChain.then(async () => {
    await WhatsAppSession.updateOne(
      getSessionWriteFilter(),
      { $set: { ...patch, tenant_id: SESSION_TENANT_ID, session_id: SESSION_ID } },
      { upsert: true }
    ).exec();
  }, async () => undefined);
  return state.writeChain;
}

async function updateSessionDoc(patch: Record<string, unknown>) {
  await persistSessionPatch(patch);
}

async function loadAuthState(): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  resetAuth: () => Promise<void>;
}> {
  await ensureSessionDocument();

  const session = await WhatsAppSession.findOneAndUpdate(
    getSessionFilter(),
    {
      $setOnInsert: {
        tenant_id: SESSION_TENANT_ID,
        session_id: SESSION_ID,
        creds: serializeValue(initAuthCreds()),
        keys: {},
        status: "idle",
        qr: null,
        last_error: null,
        reconnect_attempts: 0,
        next_retry_at: null,
        last_connected_at: null,
        last_qr_at: null,
      },
    },
    { upsert: true, returnDocument: "after" }
  ).lean().exec();

  const storedCreds = session?.creds ? (reviveValue(session.creds) as Partial<AuthenticationState["creds"]>) : null;
  const storedKeys = session?.keys ? (reviveValue(session.keys) as AuthCache["keys"]) : {};

  const cache: AuthCache = {
    creds: isUsableAuthCreds(storedCreds) ? storedCreds : initAuthCreds(),
    keys: storedKeys && typeof storedKeys === "object" ? storedKeys : {},
  };
  state.authCache = cache;

  const saveCreds = async () => {
    if (!state.authCache) {
      return;
    }
    await updateSessionDoc({
      creds: serializeValue(state.authCache.creds),
    });
  };

  const keysStore = {
    get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      const result = {} as Record<string, SignalDataTypeMap[T]>;
      const typeStore = state.authCache?.keys?.[type as string] ?? {};

      for (const id of ids) {
        const stored = typeStore[encodeAuthId(id)];
        if (stored == null) {
          result[id] = undefined as never;
          continue;
        }

        let value = reviveValue<unknown>(stored);
        if (type === "app-state-sync-key" && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value as never);
        }

        result[id] = value as SignalDataTypeMap[T];
      }

      return result;
    },
    set: async (data) => {
      if (!state.authCache) {
        state.authCache = {
          creds: initAuthCreds(),
          keys: {},
        };
      }

      const $set: Record<string, unknown> = {};
      const $unset: Record<string, string> = {};

      for (const [category, entries] of Object.entries(data)) {
        const keyCategory = category as keyof AuthCache["keys"];
        state.authCache.keys[keyCategory] ??= {};

        for (const [id, value] of Object.entries(entries)) {
          const path = `keys.${category}.${encodeAuthId(id)}`;
          if (value == null) {
            delete state.authCache.keys[keyCategory][encodeAuthId(id)];
            $unset[path] = "";
            continue;
          }

          const serialized = serializeValue(value);
          state.authCache.keys[keyCategory][encodeAuthId(id)] = serialized;
          $set[path] = serialized;
        }
      }

      await WhatsAppSession.updateOne(
        getSessionFilter(),
        {
          ...(Object.keys($set).length ? { $set } : {}),
          ...(Object.keys($unset).length ? { $unset } : {}),
          $setOnInsert: {
            tenant_id: SESSION_TENANT_ID,
            session_id: SESSION_ID,
            creds: serializeValue(initAuthCreds()),
            keys: {},
            status: "idle",
            qr: null,
            last_error: null,
            reconnect_attempts: 0,
            next_retry_at: null,
            last_connected_at: null,
            last_qr_at: null,
          },
        },
        { upsert: true }
      ).exec();
    },
    clear: async () => {
      if (!state.authCache) {
        state.authCache = {
          creds: initAuthCreds(),
          keys: {},
        };
      }
      state.authCache.creds = initAuthCreds();
      state.authCache.keys = {};
      await WhatsAppSession.updateOne(
        getSessionFilter(),
        {
          $set: {
            creds: serializeValue(state.authCache.creds),
            keys: {},
            tenant_id: SESSION_TENANT_ID,
            session_id: SESSION_ID,
          },
        },
        { upsert: true }
      ).exec();
    },
  } satisfies SignalKeyStore & { clear: () => Promise<void> };

  return {
    state: {
      creds: cache.creds,
      keys: makeCacheableSignalKeyStore(keysStore),
    },
    saveCreds,
    resetAuth: async () => {
      if (!state.authCache) {
        state.authCache = {
          creds: initAuthCreds(),
          keys: {},
        };
      }
      state.authCache.creds = initAuthCreds();
      await keysStore.clear();
      await saveCreds();
    },
  };
}

async function connectFreshSocket() {
  if (state.socket || state.connectPromise) {
    return state;
  }

  state.connectPromise = (async () => {
    await connectMongo();
    await ensureSessionDocument();
    if (state.stopRequested) {
      state.status = "disconnected";
      return state;
    }
    state.stopRequested = false;
    state.status = "connecting";
    state.lastError = null;
    await updateSessionDoc({
      status: state.status,
      last_error: null,
      next_retry_at: null,
    });

    let resetAuth: (() => Promise<void>) | null = null;

    try {
      const { state: authState, saveCreds, resetAuth: resetAuthFn } = await loadAuthState();
      resetAuth = resetAuthFn;
      if (state.stopRequested) {
        return state;
      }
      const { version } = await fetchLatestBaileysVersion();
      const sock = makeWASocket({
        version,
        auth: {
          creds: authState.creds,
          keys: authState.keys,
        },
        printQRInTerminal: false,
        generateHighQualityLinkPreview: true,
        markOnlineOnConnect: true,
        syncFullHistory: false,
      });

      state.socketGeneration += 1;
      const generation = state.socketGeneration;
      state.socket = sock;
      clearReconnectTimer(state);

      const onCredsUpdate = async (update: Partial<typeof authState.creds>) => {
        if (state.socketGeneration !== generation) {
          return;
        }
        Object.assign(authState.creds, update);
        if (state.authCache) {
          state.authCache.creds = authState.creds;
        }
        await saveCreds();
      };

      const onConnectionUpdate = async (update: ConnectionUpdate) => {
        if (state.socketGeneration !== generation) {
          return;
        }

        if (update.qr) {
          state.qr = await import("qrcode").then((mod) => mod.default.toDataURL(update.qr as string));
          state.lastQrAt = new Date();
          state.status = "connecting";
          await updateSessionDoc({
            status: state.status,
            qr: state.qr,
            last_qr_at: state.lastQrAt,
          });
          emitRealtime("whatsapp:qr", {
            session_id: SESSION_ID,
            tenant_id: SESSION_TENANT_ID,
            qr: state.qr,
            status: state.status,
          });
        }

        if (update.connection === "open") {
          state.socket = sock;
          state.status = "connected";
          state.qr = null;
          state.lastError = null;
          state.lastConnectedAt = new Date();
          state.reconnectAttempts = 0;
          state.authResetAttempts = 0;
          state.nextRetryAt = null;
          clearReconnectTimer(state);
          await updateSessionDoc({
            status: state.status,
            qr: null,
            last_error: null,
            last_connected_at: state.lastConnectedAt,
            reconnect_attempts: 0,
            next_retry_at: null,
          });
          emitRealtime("whatsapp:status", {
            session_id: SESSION_ID,
            tenant_id: SESSION_TENANT_ID,
            status: state.status,
            numero: normalizePhoneNumber(sock.user?.id?.split(":")[0] ?? ""),
          });
          await writeMessageLog({
            kind: "system",
            status: "connected",
            detail: "WhatsApp connection opened",
          });
        }

        if (update.connection === "close") {
          const { code, message } = parseDisconnect(update);
          state.socket = null;
          state.status = "disconnected";
          state.lastError = message;
          sock.ev.removeAllListeners("creds.update");
          sock.ev.removeAllListeners("connection.update");

          await updateSessionDoc({
            status: state.status,
            last_error: state.lastError,
          });

          emitRealtime("whatsapp:status", {
            session_id: SESSION_ID,
            tenant_id: SESSION_TENANT_ID,
            status: state.status,
            error: state.lastError,
          });
          await writeMessageLog({
            kind: "system",
            status: "disconnected",
            detail: `WhatsApp connection closed: ${message}`,
          });

          if (state.stopRequested) {
            return;
          }

          if (isDisconnectCode(code, DisconnectReason.loggedOut) || isDisconnectCode(code, DisconnectReason.badSession)) {
            state.authResetAttempts += 1;
            await writeMessageLog({
              kind: "error",
              status: "auth_reset",
              detail: `Auth reset triggered after disconnect code ${code ?? "unknown"}`,
            });

            if (state.authResetAttempts > AUTH_RESET_MAX_ATTEMPTS) {
              state.lastError = "Falha repetida de autenticacao. QR precisa ser revalidado manualmente.";
              await updateSessionDoc({
                last_error: state.lastError,
              });
              return;
            }

            try {
              await resetAuth?.();
            } catch (resetError) {
              state.lastError = resetError instanceof Error ? resetError.message : "Falha ao resetar auth";
            }
          }

          if (isDisconnectCode(code, DisconnectReason.connectionReplaced)) {
            state.lastError = "Conexao substituida por outro socket. Auto-reconnect pausado.";
            await updateSessionDoc({
              last_error: state.lastError,
            });
            await writeMessageLog({
              kind: "error",
              status: "connection_replaced",
              detail: state.lastError,
            });
            return;
          }

          const nextAttempt = Math.min(state.reconnectAttempts + 1, RECONNECT_MAX_ATTEMPTS);
          state.reconnectAttempts = nextAttempt;
          const reconnectDelay = isDisconnectCode(code, DisconnectReason.restartRequired) ? 1000 : computeReconnectDelay(nextAttempt);
          state.nextRetryAt = new Date(Date.now() + reconnectDelay);

          await updateSessionDoc({
            reconnect_attempts: state.reconnectAttempts,
            next_retry_at: state.nextRetryAt,
          });
          await writeMessageLog({
            kind: "system",
            status: "reconnect_scheduled",
            detail: `Reconnect scheduled in ${reconnectDelay}ms (attempt ${state.reconnectAttempts})`,
          });

          clearReconnectTimer(state);
          state.reconnectTimer = setTimeout(() => {
            state.reconnectTimer = null;
            void connectFreshSocket().catch(async (error) => {
              const detail = error instanceof Error ? error.message : "Falha ao reconectar";
              state.lastError = detail;
              await updateSessionDoc({ last_error: detail });
              await writeMessageLog({
                kind: "error",
                status: "reconnect_failed",
                detail,
              });
            });
          }, reconnectDelay);
        }
      };

      sock.ev.on("creds.update", onCredsUpdate);
      sock.ev.on("connection.update", onConnectionUpdate);
    } catch (error) {
      if (!state.stopRequested && resetAuth && isAuthShapeError(error)) {
        await resetAuth().catch(() => undefined);
      }
      if (state.stopRequested) {
        state.status = "disconnected";
        state.socket = null;
        return state;
      }
      state.status = "disconnected";
      state.socket = null;
      state.lastError = error instanceof Error ? error.message : "Falha ao iniciar conexao";
      await updateSessionDoc({
        status: state.status,
        last_error: state.lastError,
      }).catch(() => undefined);
      await writeMessageLog({
        kind: "error",
        status: "start_failed",
        detail: state.lastError,
      }).catch(() => undefined);

      const nextAttempt = Math.min(state.reconnectAttempts + 1, RECONNECT_MAX_ATTEMPTS);
      state.reconnectAttempts = nextAttempt;
      const reconnectDelay = computeReconnectDelay(nextAttempt);
      state.nextRetryAt = new Date(Date.now() + reconnectDelay);
      await updateSessionDoc({
        reconnect_attempts: state.reconnectAttempts,
        next_retry_at: state.nextRetryAt,
      }).catch(() => undefined);

      clearReconnectTimer(state);
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;
        void connectFreshSocket().catch(() => undefined);
      }, reconnectDelay);
    } finally {
      state.connectPromise = null;
    }

    return state;
  })();

  return state.connectPromise;
}

async function waitForConnectedSocket(timeoutMs = SEND_WAIT_TIMEOUT_MS) {
  const startedAt = Date.now();

  if (!state.socket && !state.connectPromise) {
    void connectFreshSocket().catch(() => undefined);
  }

  while (Date.now() - startedAt < timeoutMs) {
    if (state.socket && state.status === "connected") {
      return state.socket;
    }
    await delay(500);
  }

  throw new Error("WhatsApp indisponivel para envio no momento");
}

function trackRecentMessage(numero: string, mensagem: string) {
  pruneRecentMessages();
  const key = `${SESSION_TENANT_ID}:${numero}:${mensagem}`;
  const now = Date.now();
  const lastSent = recentMessages.get(key);
  if (lastSent && now - lastSent < MESSAGE_DEDUPE_WINDOW_MS) {
    return false;
  }
  recentMessages.set(key, now);
  return true;
}

export async function startBaileysSession() {
  state.stopRequested = false;
  return connectFreshSocket();
}

export async function stopBaileysSession() {
  state.stopRequested = true;
  clearReconnectTimer(state);
  if (state.socket) {
    try {
      state.socket.ev.removeAllListeners("creds.update");
      state.socket.ev.removeAllListeners("connection.update");
      state.socket.end(undefined);
    } catch {
      // ignore shutdown errors
    }
  }
  state.socket = null;
  state.status = "disconnected";
}

export async function stopAllBaileysSessions() {
  await stopBaileysSession();
}

export async function getSessionStatus() {
  await connectMongo();
  await ensureSessionDocument();
  const sessionDoc = await WhatsAppSession.findOne(getSessionFilter()).lean().exec();
  return {
    tenant_id: SESSION_TENANT_ID,
    session_id: getSessionAlias(),
    name: typeof sessionDoc?.name === "string" && sessionDoc.name.trim() ? sessionDoc.name : null,
    status: state.status,
    qr: state.qr,
    numero: state.socket?.user?.id ? normalizePhoneNumber(state.socket.user.id.split(":")[0] ?? "") : null,
    lastQrAt: state.lastQrAt,
    lastConnectedAt: state.lastConnectedAt,
    lastError: state.lastError,
    reconnectAttempts: state.reconnectAttempts,
    nextRetryAt: state.nextRetryAt,
  };
}

export async function updateSessionMetadata(metadata: { name?: string | null }) {
  await connectMongo();
  await ensureSessionDocument();
  const name = typeof metadata.name === "string" && metadata.name.trim() ? metadata.name.trim() : null;
  await WhatsAppSession.updateOne(
    getSessionWriteFilter(),
    {
      $set: {
        tenant_id: SESSION_TENANT_ID,
        session_id: SESSION_ID,
        name,
      },
    },
    { upsert: true }
  ).exec();
}

export async function sendWhatsAppMessage(numero: string, mensagem: string) {
  await connectMongo();
  await ensureSessionDocument();
  const normalizedNumber = normalizePhoneNumber(numero);
  const messageText = mensagem.trim();

  if (!isValidPhoneNumber(numero)) {
    throw new Error("Numero de telefone invalido");
  }

  if (!messageText) {
    throw new Error("Mensagem vazia");
  }

  if (messageText.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Mensagem excede o limite de ${MAX_MESSAGE_LENGTH} caracteres`);
  }

  if (!trackRecentMessage(normalizedNumber, messageText)) {
    throw new Error("Mensagem duplicada bloqueada por anti-spam");
  }

  return enqueueSend(async () => {
    const sock = await waitForConnectedSocket();
    await delay(SEND_DELAY_MS);
    const jid = jidFromPhone(normalizedNumber);
    const result = await sock.sendMessage(jid, { text: messageText });

    const log = await writeMessageLog({
      kind: "message",
      direction: "outbound",
      numero: normalizedNumber,
      mensagem: messageText,
      status: "sent",
      provider_message_id: result?.key?.id ?? undefined,
    });

    emitRealtime("whatsapp:message-sent", {
      session_id: SESSION_ID,
      tenant_id: SESSION_TENANT_ID,
      numero: normalizedNumber,
      status: "sent",
      message_id: result?.key?.id ?? null,
    });

    return { success: true, message_id: result?.key?.id ?? null, log };
  });
}

function enqueueSend<T>(task: () => Promise<T>) {
  const nextTask = state.writeChain.then(task, task);
  state.writeChain = nextTask.then(() => undefined, () => undefined);
  return nextTask;
}

export async function getCompanyLogs() {
  await connectMongo();
  await ensureSessionDocument();
  return MessageLog.find(getSessionFilter()).sort({ created_at: -1 }).limit(200).lean().exec();
}

export async function ensureWhatsAppBoot() {
  if (bootPromise) {
    return bootPromise;
  }

  bootPromise = (async () => {
    await startBaileysSession();
  })();

  try {
    await bootPromise;
  } finally {
    bootPromise = null;
  }
}
