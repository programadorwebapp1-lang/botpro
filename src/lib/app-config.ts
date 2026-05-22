export const DEFAULT_TENANT_ID = "default";
export const LEGACY_SESSION_ID = process.env.WHATSAPP_SESSION_ID ?? "primary";

// Backward-compatible alias kept for older code paths and env-driven setups.
export const DEFAULT_INSTANCE_ID = LEGACY_SESSION_ID;
