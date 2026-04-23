import { Schema, models, model } from "mongoose";

const LogSchema = new Schema(
  {
    instance_id: { type: String, required: true, default: "default" },
    numero: { type: String, required: true },
    mensagem: { type: String, required: true },
    status: { type: String, required: true },
  },
  { timestamps: { createdAt: "created_at", updatedAt: false } }
);

export default models.Log || model("Log", LogSchema);
