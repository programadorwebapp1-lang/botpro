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
import pino from "pino";
import { connectMongo } from "./mongo";
import { jidFromPhone, normalizePhoneNumber } from "./wa-utils";
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
  authWriteChain: Promise<void>;
  writeChain: Promise<void>;
  socketGeneration: number;
  authCache: AuthCache | null;
  sessionDocId: string | null;
  authFlushTimer: NodeJS.Timeout | null;
  pendingAuthCreds: AuthenticationState["creds"] | null;
  pendingAuthSet: Record<string, unknown>;
  pendingAuthUnset: Record<string, string>;
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

const MESSAGE_LOG_TTL_DAYS = Number(process.env.MESSAGE_LOG_TTL_DAYS ?? 30);
const RECONNECT_BASE_DELAY_MS = Number(process.env.WHATSAPP_RECONNECT_BASE_MS ?? 1500);
const RECONNECT_MAX_DELAY_MS = Number(process.env.WHATSAPP_RECONNECT_MAX_MS ?? 60000);
const RECONNECT_MAX_ATTEMPTS = Number(process.env.WHATSAPP_RECONNECT_MAX_ATTEMPTS ?? 4);
const AUTH_RESET_MAX_ATTEMPTS = Number(process.env.WHATSAPP_AUTH_RESET_MAX_ATTEMPTS ?? 0);
const SEND_DELAY_MS = Number(process.env.WHATSAPP_SEND_DELAY_MS ?? 900);
const SEND_WAIT_TIMEOUT_MS = Number(process.env.WHATSAPP_SEND_WAIT_TIMEOUT_MS ?? 15000);
const MESSAGE_DEDUPE_WINDOW_MS = Number(process.env.WHATSAPP_MESSAGE_DEDUPE_WINDOW_MS ?? 15000);
const MAX_MESSAGE_LENGTH = Number(process.env.WHATSAPP_MAX_MESSAGE_LENGTH ?? 4096);
const AUTH_FLUSH_DEBOUNCE_MS = Number(process.env.WHATSAPP_AUTH_FLUSH_DEBOUNCE_MS ?? 250);
const silentLogger = pino({ level: "silent" });

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
    authWriteChain: Promise.resolve(),
    writeChain: Promise.resolve(),
    socketGeneration: 0,
    authCache: null,
    sessionDocId: null,
    authFlushTimer: null,
    pendingAuthCreds: null,
    pendingAuthSet: {},
    pendingAuthUnset: {},
  };
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

function sanitizeKeyValue(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

function sanitizeAuthKeys(input: unknown): AuthCache["keys"] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const output: AuthCache["keys"] = {};
  for (const [category, entries] of Object.entries(input as Record<string, unknown>)) {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      continue;
    }

    const normalizedEntries: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(entries as Record<string, unknown>)) {
      const safeValue = sanitizeKeyValue(value);
      if (safeValue != null) {
        normalizedEntries[id] = safeValue;
      }
    }
    output[category] = normalizedEntries;
  }

  return output;
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

function waitForAuthWrites() {
  if (state.authFlushTimer) {
    clearTimeout(state.authFlushTimer);
    state.authFlushTimer = null;
  }
  return flushPendingAuthWrites();
}

function scheduleAuthFlush() {
  if (state.authFlushTimer) {
    clearTimeout(state.authFlushTimer);
  }
  state.authFlushTimer = setTimeout(() => {
    state.authFlushTimer = null;
    void flushPendingAuthWrites().catch(() => undefined);
  }, AUTH_FLUSH_DEBOUNCE_MS);
}

function queueAuthSet(path: string, value: unknown) {
  state.pendingAuthUnset[path] = "";
  delete state.pendingAuthSet[path];
  state.pendingAuthSet[path] = value;
}

function queueAuthUnset(path: string) {
  delete state.pendingAuthSet[path];
  state.pendingAuthUnset[path] = "";
}

function queueAuthCredsSnapshot(snapshot: AuthenticationState["creds"]) {
  state.pendingAuthCreds = snapshot;
}

async function flushPendingAuthWrites() {
  const sessionDocId = await resolveSessionDocId();
  const snapshotCreds = state.pendingAuthCreds;
  const snapshotSet = { ...state.pendingAuthSet };
  const snapshotUnset = { ...state.pendingAuthUnset };

  if (
    snapshotCreds == null &&
    Object.keys(snapshotSet).length === 0 &&
    Object.keys(snapshotUnset).length === 0
  ) {
    return;
  }

  state.pendingAuthCreds = null;
  state.pendingAuthSet = {};
  state.pendingAuthUnset = {};

  state.authWriteChain = state.authWriteChain.then(
    async () => {
      const update: Record<string, unknown> = {};
      if (snapshotCreds != null) {
        update.$set = { ...(update.$set as Record<string, unknown> | undefined), creds: snapshotCreds };
      }
      if (Object.keys(snapshotSet).length) {
        update.$set = { ...(update.$set as Record<string, unknown> | undefined), ...snapshotSet };
      }
      if (Object.keys(snapshotUnset).length) {
        update.$unset = snapshotUnset;
      }
      await WhatsAppSession.updateOne({ _id: sessionDocId }, update).exec();
    },
    async () => undefined
  );

  await state.authWriteChain;
}

async function resolveSessionDocId() {
  if (state.sessionDocId) {
    return state.sessionDocId;
  }

  await connectMongo();
  const docs = await WhatsAppSession.find({}).sort({ updatedAt: -1 }).lean().exec();

  if (docs.length === 0) {
    const created = await WhatsAppSession.create({
      creds: serializeValue(initAuthCreds()),
      keys: {},
      status: "idle",
      qr: null,
      last_error: null,
      reconnect_attempts: 0,
      next_retry_at: null,
      last_connected_at: null,
      last_qr_at: null,
    });
    state.sessionDocId = String(created._id);
    return state.sessionDocId;
  }

  const connected = docs.find((doc) => doc.status === "connected" || doc.status === "connecting");
  const usableCreds = docs.find((doc) => isUsableAuthCreds(doc.creds as Partial<AuthenticationState["creds"]> | null | undefined));
  const best = connected ?? usableCreds ?? docs[0];
  state.sessionDocId = String(best._id);
  return state.sessionDocId;
}

async function ensureSessionDocument() {
  await resolveSessionDocId();
}

async function updateSessionDoc(patch: Record<string, unknown>) {
  const sessionDocId = await resolveSessionDocId();
  await WhatsAppSession.updateOne({ _id: sessionDocId }, { $set: patch }).exec();
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
    expire_at: buildMessageLogExpireAt(),
    ...payload,
  });
  emitRealtime("log:new", { log });
  return log;
}

async function loadAuthState(): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  resetAuth: () => Promise<void>;
}> {
  await ensureSessionDocument();
  const sessionDocId = await resolveSessionDocId();
  const session = await WhatsAppSession.findById(sessionDocId).lean().exec();

  const storedCreds = session?.creds ? (reviveValue(session.creds) as Partial<AuthenticationState["creds"]>) : null;
  const storedKeys = sanitizeAuthKeys(session?.keys ? reviveValue(session.keys) : {});

  const cache: AuthCache = {
    creds: isUsableAuthCreds(storedCreds) ? storedCreds : initAuthCreds(),
    keys: storedKeys,
  };
  state.authCache = cache;

  const saveCreds = async () => {
    if (!state.authCache) {
      return;
    }

    queueAuthCredsSnapshot(serializeValue(state.authCache.creds));
    scheduleAuthFlush();
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

      for (const [category, entries] of Object.entries(data)) {
        const keyCategory = category as keyof AuthCache["keys"];
        state.authCache.keys[keyCategory] ??= {};

        for (const [id, value] of Object.entries(entries)) {
          const path = `keys.${category}.${encodeAuthId(id)}`;
          if (value == null) {
            delete state.authCache.keys[keyCategory][encodeAuthId(id)];
            queueAuthUnset(path);
            continue;
          }

          const serialized = serializeValue(value);
          state.authCache.keys[keyCategory][encodeAuthId(id)] = serialized;
          queueAuthSet(path, serialized);
        }
      }

      scheduleAuthFlush();
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
      state.pendingAuthCreds = serializeValue(state.authCache.creds);
      state.pendingAuthSet = { keys: {} };
      state.pendingAuthUnset = {};
      await flushPendingAuthWrites();
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
    await waitForAuthWrites();
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
        logger: silentLogger,
        version,
        auth: {
          creds: authState.creds,
          keys: authState.keys,
        },
        emitOwnEvents: false,
        printQRInTerminal: false,
        generateHighQualityLinkPreview: true,
        markOnlineOnConnect: true,
        syncFullHistory: false,
        fireInitQueries: false,
        retryRequestDelayMs: 500,
        maxMsgRetryCount: 1,
        transactionOpts: {
          maxCommitRetries: 1,
          delayBetweenTriesMs: 100,
        },
        enableAutoSessionRecreation: false,
        enableRecentMessageCache: true,
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

          if (state.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
            state.lastError = state.lastError ?? "Limite de reconexoes atingido";
            state.nextRetryAt = null;
            await updateSessionDoc({
              last_error: state.lastError,
              next_retry_at: null,
              reconnect_attempts: state.reconnectAttempts,
            });
            await writeMessageLog({
              kind: "error",
              status: "reconnect_limit_reached",
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
          clearReconnectTimer(state);
          state.reconnectTimer = setTimeout(() => {
            state.reconnectTimer = null;
            void (async () => {
              await waitForAuthWrites();
              await connectFreshSocket().catch(() => undefined);
            })();
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
      if (state.reconnectAttempts < RECONNECT_MAX_ATTEMPTS) {
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
          void (async () => {
            await waitForAuthWrites();
            await connectFreshSocket().catch(() => undefined);
          })();
        }, reconnectDelay);
      }
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
  const key = `${numero}:${mensagem}`;
  const now = Date.now();
  const lastSent = recentMessages.get(key);
  if (lastSent && now - lastSent < MESSAGE_DEDUPE_WINDOW_MS) {
    return false;
  }
  recentMessages.set(key, now);
  return true;
}

function enqueueSend<T>(task: () => Promise<T>) {
  const nextTask = state.writeChain.then(task, task);
  state.writeChain = nextTask.then(() => undefined, () => undefined);
  return nextTask;
}

export async function startBaileysSession() {
  if (state.socket) {
    await stopBaileysSession();
  }
  state.stopRequested = false;
  clearReconnectTimer(state);
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
  await ensureSessionDocument();
  const sessionDocId = await resolveSessionDocId();
  const sessionDoc = await WhatsAppSession.findById(sessionDocId).lean().exec();
  return {
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
  const name = typeof metadata.name === "string" && metadata.name.trim() ? metadata.name.trim() : null;
  await updateSessionDoc({ name });
}

export async function sendWhatsAppMessage(numero: string, mensagem: string) {
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
      numero: normalizedNumber,
      status: "sent",
      message_id: result?.key?.id ?? null,
    });

    return { success: true, message_id: result?.key?.id ?? null, log };
  });
}

export async function getCompanyLogs() {
  await ensureSessionDocument();
  return MessageLog.find({}).sort({ created_at: -1 }).limit(200).lean().exec();
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
