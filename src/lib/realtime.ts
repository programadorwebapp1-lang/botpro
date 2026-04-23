type RealtimePayload = Record<string, unknown>;

declare global {
  var realtimeIo: import("socket.io").Server | undefined;
}

export function setRealtimeServer(io: import("socket.io").Server) {
  global.realtimeIo = io;
}

export function emitRealtime(event: string, payload: RealtimePayload) {
  global.realtimeIo?.emit(event, payload);
}
