import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import { GoogleGenAI } from "@google/genai";
import { Client, GatewayIntentBits } from "discord.js";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import pino from "pino";

const app = express();
app.use(express.json());

// Future Web App / APK ke liye CORS headers
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3000;

// MongoDB Schema (User ka Prompt & Bot Config store karne ke liye)
const botConfigSchema = new mongoose.Schema({
  userId: { type: String, default: "default_user", unique: true },
  businessName: { type: String, default: "My Brand" },
  systemPrompt: {
    type: String,
    default:
      "Tum ek helpful customer aur viewer assistant ho. Short, clear aur friendly jawab do.",
  },
  whatsappEnabled: { type: Boolean, default: true },
  discordEnabled: { type: Boolean, default: true },
  updatedAt: { type: Date, default: Date.now },
});

const BotConfig = mongoose.model("BotConfig", botConfigSchema);

let activeConfig = {
  businessName: "My Brand",
  systemPrompt:
    "Tum ek helpful customer aur viewer assistant ho. Short, clear aur friendly jawab do.",
  whatsappEnabled: true,
  discordEnabled: true,
};

async function connectDB() {
  if (!process.env.MONGO_URI) {
    console.log("MONGO_URI set nahi hai, default memory config chal raha hai.");
    return;
  }
  await mongoose.connect(process.env.MONGO_URI);
  console.log("MongoDB connected!");

  let doc = await BotConfig.findOne({ userId: "default_user" });
  if (!doc) {
    doc = await BotConfig.create({ userId: "default_user" });
  }
  activeConfig = doc.toObject();
}

// API Endpoints: Web App / APK yahan se prompt padhegi aur update karegi
app.get("/", (req, res) => {
  res.json({ status: "online", service: "AI Omni-Bot Backend" });
});
// --- INSTAGRAM WEBHOOK (Meta DM / Events) ---
app.get("/webhook/instagram", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.IG_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook/instagram", async (req, res) => {
  // Meta ko turant 200 OK bhejna zaroori hai taaki retry na aaye
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const messaging = entry?.messaging?.[0];
    const senderId = messaging?.sender?.id;
    const messageText = messaging?.message?.text;

    if (!senderId || !messageText || messaging?.message?.is_echo) return;
    if (!process.env.IG_ACCESS_TOKEN) return;

    const reply = await generateAIReply("Instagram", "Viewer", messageText);

    await fetch(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${process.env.IG_ACCESS_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: senderId },
          message: { text: reply },
        }),
      }
    );
  } catch (err) {
    console.error("Instagram webhook error:", err.message);
  }
});

// --- YOUTUBE LIVE CHAT AUTO-REPLY (Optional: YT_LIVE_CHAT_ID & YT_ACCESS_TOKEN set ho to) ---
let seenYtMessageIds = new Set();

async function pollYouTubeLiveChat() {
  const liveChatId = process.env.YT_LIVE_CHAT_ID;
  const accessToken = process.env.YT_ACCESS_TOKEN;
  if (!liveChatId || !accessToken) return;

  try {
    const listUrl = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${encodeURIComponent(
      liveChatId
    )}&part=snippet,authorDetails&access_token=${encodeURIComponent(accessToken)}`;

    const response = await fetch(listUrl);
    const data = await response.json();
    const items = data?.items || [];

    for (const item of items) {
      const msgId = item.id;
      const text = item.snippet?.displayMessage;
      const authorName = item.authorDetails?.displayName || "Viewer";

      if (!msgId || !text || seenYtMessageIds.has(msgId)) continue;
      seenYtMessageIds.add(msgId);

      // Pehli baar load hone par purane messages ka spam bachane ke liye sirf naye messages ka reply karein
      const publishedTime = new Date(item.snippet?.publishedAt || 0).getTime();
      if (Date.now() - publishedTime > 20000) continue;

      const reply = await generateAIReply("YouTube", authorName, text);

      await fetch(
        `https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet&access_token=${encodeURIComponent(
          accessToken
        )}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            snippet: {
              liveChatId,
              type: "textMessageEvent",
              textMessageDetails: {
                messageText: reply.slice(0, 200),
              },
            },
          }),
        }
      );
    }
  } catch (err) {
    console.error("YouTube polling error:", err.message);
  }
}

setInterval(pollYouTubeLiveChat, 8000);
app.get("/api/config", (req, res) => {
  res.json(activeConfig);
});

app.post("/api/config", async (req, res) => {
  try {
    const { businessName, systemPrompt, whatsappEnabled, discordEnabled } =
      req.body;

    if (businessName !== undefined) activeConfig.businessName = businessName;
    if (systemPrompt !== undefined) activeConfig.systemPrompt = systemPrompt;
    if (whatsappEnabled !== undefined)
      activeConfig.whatsappEnabled = Boolean(whatsappEnabled);
    if (discordEnabled !== undefined)
      activeConfig.discordEnabled = Boolean(discordEnabled);

    if (mongoose.connection.readyState === 1) {
      const updated = await BotConfig.findOneAndUpdate(
        { userId: "default_user" },
        { ...activeConfig, updatedAt: new Date() },
        { new: true, upsert: true }
      );
      activeConfig = updated.toObject();
    }

    res.json({ success: true, config: activeConfig });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Gemini AI Reply Generator (4 Models + Retry/Fallback)
const extraModel = process.env.GEMINI_MODEL?.trim();

const MODELS_TO_TRY = [
  ...(extraModel ? [extraModel] : []),
  "gemini-3.8-flash-lite",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-3.8-flash",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateAIReply(platform, senderName, userMessage) {
  if (!process.env.GEMINI_API_KEY) {
    return "AI API key set nahi hai. Kripya GEMINI_API_KEY add karein.";
  }

  const fullInstruction = `
Brand/Creator: ${activeConfig.businessName}
Platform: ${platform}
User Instructions: ${activeConfig.systemPrompt}

Rule: Seedha, helpful aur natural jawab do. Zyada lamba mat likho.
`;

  const promptText = `${fullInstruction}\n\n${senderName} ne pucha: "${userMessage}"`;

  for (const modelName of MODELS_TO_TRY) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: promptText,
        });

        const text = response.text?.trim();
        if (text) {
          return text;
        }
      } catch (err) {
        const errMessage = err?.message || JSON.stringify(err) || "";
        const isRetryable =
          errMessage.includes("503") ||
          errMessage.includes("UNAVAILABLE") ||
          errMessage.includes("429") ||
          errMessage.includes("RESOURCE_EXHAUSTED");

        const isModelUnavailable =
          errMessage.includes("404") || errMessage.includes("NOT_FOUND");

        console.error(
          `AI error [${modelName}] (attempt ${attempt}):`,
          errMessage
        );

        if (isModelUnavailable) {
          break;
        }

        if (isRetryable && attempt < 2) {
          await sleep(1200);
          continue;
        }

        if (isRetryable) {
          break;
        }
      }
    }
  }

  return "Abhi AI models par load zyada hai, kripya thodi der baad dobara try karein.";
}

// Discord Bot Setup
function startDiscordBot() {
  if (!process.env.DISCORD_BOT_TOKEN) {
    console.log("DISCORD_BOT_TOKEN set nahi hai, Discord bot skip kiya gaya.");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  client.once("clientReady", () => {
    console.log(`Discord Bot online: ${client.user.tag}`);
  });

  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (!activeConfig.discordEnabled) return;
    if (!message.content?.trim()) return;

    try {
      await message.channel.sendTyping();
      const reply = await generateAIReply(
        "Discord",
        message.author.username,
        message.content
      );
      await message.reply(reply);
    } catch (err) {
      console.error("Discord AI reply error:", err.message);
    }
  });

  client.login(process.env.DISCORD_BOT_TOKEN).catch((err) => {
    console.error("Discord login failed:", err.message);
  });
}

// WhatsApp Bot Setup (Baileys)
async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./wa_auth_info");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;
      console.log("WhatsApp connection closed. Reconnect:", shouldReconnect);
      if (shouldReconnect) {
        startWhatsAppBot();
      }
    } else if (connection === "open") {
      console.log("WhatsApp Bot connected aur ready hai!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    if (!activeConfig.whatsappEnabled) return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid === "status@broadcast") continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      if (!text.trim()) continue;

      try {
        const senderName = msg.pushName || "Customer";
        const reply = await generateAIReply("WhatsApp", senderName, text);
        await sock.sendMessage(remoteJid, { text: reply });
      } catch (err) {
        console.error("WhatsApp AI reply error:", err.message);
      }
    }
  });
}

// Boot Everything
async function startServer() {
  await connectDB();

  app.listen(PORT, () => {
    console.log(`Backend server port ${PORT} par chal raha hai`);
  });

  startDiscordBot();
  await startWhatsAppBot();
}

startServer();
