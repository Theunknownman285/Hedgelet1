import {
  Client,
  GatewayIntentBits,
  TextChannel,
  EmbedBuilder,
} from "discord.js";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

// ── Firebase admin init ───────────────────────────────────────────────────────
const serviceAccountRaw = process.env["FIREBASE_SERVICE_ACCOUNT"];
if (!serviceAccountRaw) {
  console.error("FIREBASE_SERVICE_ACCOUNT secret is missing");
  process.exit(1);
}
const serviceAccount = JSON.parse(serviceAccountRaw);

if (!getApps().length) {
  initializeApp({
    credential: cert(serviceAccount),
    databaseURL: "https://hedgelet-292a4-default-rtdb.firebaseio.com",
  });
}

const db = getDatabase();
const chatRef = db.ref("globalChat");
const BRIDGE_BOT_UID = "DISCORD_BRIDGE";

// ── Discord client ────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env["DISCORD_BOT_TOKEN"];
const DISCORD_CHANNEL_ID = process.env["DISCORD_CHANNEL_ID"];

if (!DISCORD_TOKEN || !DISCORD_CHANNEL_ID) {
  console.error("DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID secret is missing");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let channelReady: TextChannel | null = null;
// Track the last 200 Firebase message keys we've seen so we don't echo them
// back into Discord after we write them ourselves.
const seenKeys = new Set<string>();
// Track Discord message IDs we sent (so we don't bounce them back into the game)
const sentByBridge = new Set<string>();

// ── Discord → Game ────────────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.channelId !== DISCORD_CHANNEL_ID) return;
  if (message.author.bot) return;

  const text = message.content.trim();
  if (!text) return;

  const newRef = chatRef.push();
  const key = newRef.key!;
  seenKeys.add(key);

  await newRef.set({
    uid: BRIDGE_BOT_UID,
    username: message.author.displayName || message.author.username,
    text: text,
    blookEmoji: "🎮",
    fromDiscord: true,
    timestamp: Date.now(),
  });

  console.log(`[Discord→Game] ${message.author.username}: ${text}`);
});

// ── Game → Discord ────────────────────────────────────────────────────────────
function startGameListener() {
  // Listen only to new messages going forward (skip backlog)
  const query = chatRef.limitToLast(1);

  // Prime with current latest so child_added only fires for truly new ones
  query.once("value", () => {
    chatRef.limitToLast(200).on("child_added", async (snap) => {
      const key = snap.key!;
      const msg = snap.val();

      if (!msg || !msg.text) return;
      // Don't echo messages we pushed ourselves
      if (seenKeys.has(key)) return;
      if (msg.fromDiscord) return;
      if (msg.uid === BRIDGE_BOT_UID) return;

      seenKeys.add(key);

      if (!channelReady) return;

      const blook = msg.blookEmoji && !msg.blookEmoji.startsWith("http")
        ? msg.blookEmoji
        : "🦔";

      const embed = new EmbedBuilder()
        .setColor(0x8b5a3e)
        .setAuthor({ name: `${blook} ${msg.username}` })
        .setDescription(msg.text)
        .setFooter({ text: "Hedgelet" })
        .setTimestamp(msg.timestamp ? new Date(msg.timestamp) : new Date());

      if (msg.replyTo) {
        embed.addFields({
          name: `↩ Replying to ${msg.replyTo.username}`,
          value: msg.replyTo.text.slice(0, 200),
        });
      }

      try {
        const sent = await channelReady!.send({ embeds: [embed] });
        sentByBridge.add(sent.id);
      } catch (e) {
        console.error("Failed to send to Discord:", e);
      }

      console.log(`[Game→Discord] ${msg.username}: ${msg.text}`);
    });
  });
}

// ── Bot ready ─────────────────────────────────────────────────────────────────
client.once("ready", async () => {
  console.log(`Discord bridge ready as ${client.user?.tag}`);
  const ch = await client.channels.fetch(DISCORD_CHANNEL_ID!);
  if (!ch || !ch.isTextBased()) {
    console.error("Channel not found or not a text channel");
    process.exit(1);
  }
  channelReady = ch as TextChannel;

  // Announce the bridge is live
  try {
    await channelReady.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xffd700)
          .setTitle("🦔 Hedgelet Chat Bridge Online")
          .setDescription(
            "Messages from the game will appear here. Reply in this channel to chat with in-game players!"
          ),
      ],
    });
  } catch (_) {}

  startGameListener();
});

client.login(DISCORD_TOKEN);

// ── Clean up old seen keys to prevent unbounded growth ───────────────────────
setInterval(() => {
  if (seenKeys.size > 500) {
    const arr = [...seenKeys];
    arr.slice(0, arr.length - 200).forEach((k) => seenKeys.delete(k));
  }
}, 60_000);
