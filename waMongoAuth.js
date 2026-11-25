import mongoose from "mongoose";
import { initAuthCreds, BufferJSON, proto } from "@whiskeysockets/baileys";

const waSessionSchema = new mongoose.Schema({
  sessionId: { type: String, default: "default_wa", unique: true },
  data: { type: String, required: true },
  updatedAt: { type: Date, default: Date.now },
});

const WaSession = mongoose.model("WaSession", waSessionSchema);

const reviveBuffers = (obj) =>
  JSON.parse(JSON.stringify(obj), BufferJSON.reviver);

const replaceBuffers = (obj) =>
  JSON.stringify(obj, BufferJSON.replacer);

export async function useMongoDBAuthState(sessionId = "default_wa") {
  let creds;
  let keys = {};

  if (mongoose.connection.readyState === 1) {
    const existing = await WaSession.findOne({ sessionId });
    if (existing?.data) {
      try {
        const parsed = reviveBuffers(existing.data);
        creds = parsed.creds || initAuthCreds();
        keys = parsed.keys || {};
      } catch {
        creds = initAuthCreds();
        keys = {};
      }
    } else {
      creds = initAuthCreds();
    }
  } else {
    creds = initAuthCreds();
  }

  async function persistState() {
    if (mongoose.connection.readyState !== 1) return;
    const serialized = replaceBuffers({ creds, keys });
    await WaSession.findOneAndUpdate(
      { sessionId },
      { data: serialized, updatedAt: new Date() },
      { upsert: true, new: true }
    );
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          const category = keys[type] || {};
          for (const id of ids) {
            let value = category[id];
            if (value && type === "app-state-sync-key") {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            if (value !== undefined) {
              result[id] = value;
            }
          }
          return result;
        },
        set: async (data) => {
          for (const category of Object.keys(data)) {
            keys[category] = keys[category] || {};
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              if (value) {
                keys[category][id] = value;
              } else {
                delete keys[category][id];
              }
            }
          }
          await persistState();
        },
      },
    },
    saveCreds: async () => {
      await persistState();
    },
  };
}
