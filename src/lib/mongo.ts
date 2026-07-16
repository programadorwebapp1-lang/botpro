import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI ?? process.env.MONGO_URI;

type Cached = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
};

declare global {
  var mongooseCache: Cached | undefined;
}

const cached: Cached = global.mongooseCache ?? { conn: null, promise: null };
global.mongooseCache = cached;

export async function connectMongo() {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is not defined");
  }
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    const uri = MONGODB_URI as string;
    cached.promise = mongoose.connect(uri, {
      dbName: process.env.MONGODB_DB ?? "whatsapp_panel",
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
  }
  cached.conn = await cached.promise;
  return cached.conn;
}
