import { Schema, model, models } from "mongoose";
import { DEFAULT_TENANT_ID } from "@/lib/app-config";

const WhatsAppSessionSchema = new Schema(
  {
    tenant_id: { type: String, required: true, unique: true, index: true, default: DEFAULT_TENANT_ID },
    session_id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: false, default: null },
    creds: { type: Schema.Types.Mixed, required: true, default: {} },
    keys: { type: Schema.Types.Mixed, required: true, default: {} },
    status: { type: String, required: true, default: "idle" },
    qr: { type: String, required: false, default: null },
    last_error: { type: String, required: false, default: null },
    last_connected_at: { type: Date, required: false, default: null },
    last_qr_at: { type: Date, required: false, default: null },
    reconnect_attempts: { type: Number, required: true, default: 0 },
    next_retry_at: { type: Date, required: false, default: null },
  },
  {
    timestamps: true,
    collection: "whatsapp_sessions",
  }
);

WhatsAppSessionSchema.index({ tenant_id: 1, updatedAt: -1 });
WhatsAppSessionSchema.index({ status: 1, updatedAt: -1 });

export default models.WhatsAppSession || model("WhatsAppSession", WhatsAppSessionSchema);
