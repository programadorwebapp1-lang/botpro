import { Schema, model, models } from "mongoose";

const MessageLogSchema = new Schema(
  {
    tenant_id: { type: String, required: false, index: true },
    session_id: { type: String, required: true, index: true },
    kind: { type: String, required: true, enum: ["message", "system", "error"] },
    direction: { type: String, required: false, enum: ["inbound", "outbound"] },
    numero: { type: String, required: false },
    mensagem: { type: String, required: false },
    status: { type: String, required: true },
    detail: { type: String, required: false },
    provider_message_id: { type: String, required: false },
    expire_at: { type: Date, required: true },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: false },
    collection: "message_logs",
  }
);

MessageLogSchema.index({ session_id: 1, created_at: -1 });
MessageLogSchema.index({ tenant_id: 1, created_at: -1 });
MessageLogSchema.index({ expire_at: 1 }, { expireAfterSeconds: 0 });

export default models.MessageLog || model("MessageLog", MessageLogSchema);
