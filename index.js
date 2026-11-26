import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import { GoogleGenAI } from "@google/genai";
import { Client, GatewayIntentBits } from "discord.js";
import makeWASocket, { DisconnectReason } from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import { useMongoDBAuthState } from "./waMongoAuth.js";

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

// Gemini AI Reply Generator (Free-tier friendly models + Retry/Fallback)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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

  return `${activeConfig.businessName} ki taraf se: Abhi turant AI server par zyada load hai, kripya thodi der baad dobara try karein.`;
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

// WhatsApp Bot Setup (Baileys + MongoDB Session + QR + Phone Pairing Code)
let waConnected = false;
let latestWaQr = null;
let waSock = null;

function cleanPhoneNumber(rawPhone) {
  return String(rawPhone || "").replace(/\D/g, "");
}

app.get("/api/wa-status", (req, res) => {
  res.json({
    connected: waConnected,
    qr: latestWaQr,
  });
});

app.post("/api/wa-pair", async (req, res) => {
  try {
    if (waConnected) {
      return res.json({ success: true, connected: true, message: "WhatsApp already connected hai." });
    }

    const phone = cleanPhoneNumber(req.body?.phone);
    if (!phone || phone.length < 10) {
      return res.status(400).json({
        success: false,
        error: "Sahi phone number country code ke saath daalein (jaise 919876543210).",
      });
    }

    if (!waSock || typeof waSock.requestPairingCode !== "function") {
      return res.status(503).json({
        success: false,
        error: "WhatsApp socket abhi initialize ho raha hai, 3-4 second baad dobara try karein.",
      });
    }

    const rawCode = await waSock.requestPairingCode(phone);
    const formattedCode = rawCode?.match(/.{1,4}/g)?.join("-") || rawCode;

    res.json({
      success: true,
      phone,
      code: formattedCode,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/wa-pair", (req, res) => {
  if (waConnected) {
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;margin-top:50px">
        <h2>WhatsApp already connected hai!</h2>
        <p>Ab auto-reply active hai.</p>
      </div>
    `);
  }

  res.send(`
    <div style="font-family:sans-serif;max-width:420px;margin:40px auto;text-align:center;padding:20px;border:1px solid #ddd;border-radius:10px">
      <h2>WhatsApp Number Pairing</h2>
      <p style="color:#555;font-size:14px">Country code ke saath number daalein (jaise <b>916351643136</b>, bina + ke):</p>
      <input id="phoneInput" type="text" placeholder="916351643136" style="width:90%;padding:10px;font-size:16px;margin-bottom:12px;border:1px solid #aaa;border-radius:6px" />
      <br/>
      <button onclick="getCode()" style="padding:10px 20px;font-size:15px;cursor:pointer">Pairing Code Lo</button>
      <div id="result" style="margin-top:20px;font-size:18px;font-weight:bold"></div>
      <p style="color:#666;font-size:13px;margin-top:16px">Phone WhatsApp mein <b>Linked Devices &rarr; Link a Device &rarr; Link with phone number instead</b> dabayein.</p>
    </div>
    <script>
      async function getCode() {
        const phone = document.getElementById("phoneInput").value.trim();
        const box = document.getElementById("result");
        box.innerHTML = "Code generate ho raha hai...";
        try {
          const r = await fetch("/api/wa-pair", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone })
          });
          const data = await r.json();
          if (data.success) {
            box.innerHTML = "Aapka Code: <span style='letter-spacing:3px;background:#f3f4f6;padding:6px 12px;border-radius:6px'>" + data.code + "</span>";
          } else {
            box.innerHTML = "<span style='color:red'>" + (data.error || "Error aaya") + "</span>";
          }
        } catch (e) {
          box.innerHTML = "<span style='color:red'>Network error: " + e.message + "</span>";
        }
      }
    </script>
  `);
});

app.get("/wa-qr", async (req, res) => {
  if (waConnected) {
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;margin-top:50px">
        <h2>WhatsApp already connected hai!</h2>
        <p>Ab auto-reply active hai.</p>
      </div>
    `);
  }
  if (!latestWaQr) {
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;margin-top:50px">
        <h2>QR generate ho raha hai...</h2>
        <button onclick="location.reload()" style="padding:10px 18px;font-size:15px;cursor:pointer">Refresh</button>
      </div>
      <script>setTimeout(()=>location.reload(), 5000)</script>
    `);
  }

  const qrImageUrl = await QRCode.toDataURL(latestWaQr);
  res.send(`
    <div style="font-family:sans-serif;text-align:center;margin-top:35px">
      <h2>WhatsApp QR Scan Karein</h2>
      <img src="${qrImageUrl}" style="width:280px;height:280px;border:1px solid #ddd;padding:8px;border-radius:8px" />
      <p>Phone ke WhatsApp mein <b>Linked Devices &rarr; Link a Device</b> se scan karein.</p>
      <p><a href="/wa-pair">QR nahi chal raha? Phone number se pair karein</a></p>
      <button onclick="location.reload()" style="padding:10px 18px;font-size:15px;cursor:pointer">Naya QR / Refresh</button>
      <script>setTimeout(()=>location.reload(), 60000)</script>
    </div>
  `);
});

async function startWhatsAppBot() {
  const { state, saveCreds } = await useMongoDBAuthState("default_wa");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["Chrome", "Desktop", "120.0.0"],
  });

  waSock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestWaQr = qr;
      console.log(
        "Naya WhatsApp QR generate hua hai (/wa-qr ya /wa-pair use karein)."
      );
    }

    if (connection === "open") {
      waConnected = true;
      latestWaQr = null;
      console.log("WhatsApp Bot connected aur ready hai!");
    } else if (connection === "close") {
      waConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log("WhatsApp connection closed. Reconnect:", shouldReconnect);

      if (shouldReconnect) {
        await sleep(3000);
        startWhatsAppBot();
      }
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
