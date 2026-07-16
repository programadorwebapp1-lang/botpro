type RealtimePayload = Record<string, unknown>;

export function setRealtimeServer() {
  return undefined;
}

export function emitRealtime(event: string, payload: RealtimePayload) {
  void event;
  void payload;
  return undefined;
}
