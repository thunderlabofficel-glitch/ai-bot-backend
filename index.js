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

app.get("/", (req, res) => {
  res.json({ status: "online", service: "AI Omni-Bot Backend" });
});

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

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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

  const response = await ai.models.generateContent({
   model: "gemini-3.8-flash",
    contents: `${fullInstruction}\n\n${senderName} ne pucha: "${userMessage}"`,
  });

  return response.text?.trim() || "Main abhi jawab nahi de pa raha hoon.";
}

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

  client.once("ready", () => {
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

async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./wa_auth_info");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
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

async function startServer() {
  await connectDB();

  app.listen(PORT, () => {
    console.log(`Backend server port ${PORT} par chal raha hai`);
  });

  startDiscordBot();
  await startWhatsAppBot();
}

startServer();
