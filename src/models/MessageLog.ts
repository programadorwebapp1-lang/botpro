import { Schema, model, models } from "mongoose";

const MessageLogSchema = new Schema(
  {
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

MessageLogSchema.index({ expire_at: 1 }, { expireAfterSeconds: 0 });
MessageLogSchema.index({ created_at: -1 });

export default models.MessageLog || model("MessageLog", MessageLogSchema);
