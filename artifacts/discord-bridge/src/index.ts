import {
  Client,
  GatewayIntentBits,
  TextChannel,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChatInputCommandInteraction,
  Colors,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from "discord.js";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

// ── Firebase admin init ───────────────────────────────────────────────────────
const serviceAccountRaw = process.env["FIREBASE_SERVICE_ACCOUNT"];
if (!serviceAccountRaw) { console.error("FIREBASE_SERVICE_ACCOUNT missing"); process.exit(1); }
const serviceAccount = JSON.parse(serviceAccountRaw);

if (!getApps().length) {
  initializeApp({
    credential: cert(serviceAccount),
    databaseURL: "https://hedgelet-292a4-default-rtdb.firebaseio.com",
  });
}

const rtdb      = getDatabase();
const firestore = getFirestore();
const chatRef   = rtdb.ref("globalChat");
const BRIDGE_BOT_UID = "DISCORD_BRIDGE";

// ── Discord client ────────────────────────────────────────────────────────────
const DISCORD_TOKEN      = process.env["DISCORD_BOT_TOKEN"];
const DISCORD_CHANNEL_ID = process.env["DISCORD_CHANNEL_ID"];

if (!DISCORD_TOKEN || !DISCORD_CHANNEL_ID) {
  console.error("DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID missing");
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
const seenKeys    = new Set<string>();
const sentByBridge = new Set<string>();

// ── Allowed role names (case-insensitive) ─────────────────────────────────────
const ALLOWED_ROLES = ["owner", "co-owner", "co owner", "admin", "administrator"];

function hasModRole(interaction: ChatInputCommandInteraction): boolean {
  const member = interaction.member;
  if (!member || !("roles" in member)) return false;
  const roles = member.roles;
  // roles is a GuildMemberRoleManager or array of role IDs in partial members
  if (typeof roles === "object" && "cache" in roles) {
    return roles.cache.some(r =>
      ALLOWED_ROLES.includes(r.name.toLowerCase())
    );
  }
  return false;
}

// ── Slash command definitions ─────────────────────────────────────────────────
// Commands visible to members with Administrator Discord permission.
// Fine-grained access (Owner/Co-Owner/Admin role names) is enforced in code.
const commands = [
  new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Mute a player in Hedgelet (Owner / Co-Owner / Admin only)")
    .addStringOption(o =>
      o.setName("username").setDescription("Hedgelet username").setRequired(true))
    .addStringOption(o =>
      o.setName("duration").setDescription("How long: 10m · 1h · 6h · 1d · 7d · permanent (default)").setRequired(false))
    .addStringOption(o =>
      o.setName("reason").setDescription("Reason for mute").setRequired(false)),

  new SlashCommandBuilder()
    .setName("unmute")
    .setDescription("Unmute a player in Hedgelet (Owner / Co-Owner / Admin only)")
    .addStringOption(o =>
      o.setName("username").setDescription("Hedgelet username").setRequired(true)),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a player from Hedgelet (Owner / Co-Owner / Admin only)")
    .addStringOption(o =>
      o.setName("username").setDescription("Hedgelet username").setRequired(true))
    .addStringOption(o =>
      o.setName("reason").setDescription("Reason for ban").setRequired(false)),

  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a player from Hedgelet (Owner / Co-Owner / Admin only)")
    .addStringOption(o =>
      o.setName("username").setDescription("Hedgelet username").setRequired(true)),

  new SlashCommandBuilder()
    .setName("view")
    .setDescription("View a Hedgelet player's profile card")
    .addStringOption(o =>
      o.setName("username").setDescription("Hedgelet username").setRequired(true)),

  new SlashCommandBuilder()
    .setName("addrole")
    .setDescription("Add an in-game role to a player (Owner / Co-Owner / Admin only)")
    .addStringOption(o =>
      o.setName("username").setDescription("Hedgelet username").setRequired(true))
    .addStringOption(o =>
      o.setName("role").setDescription("Role to add").setRequired(true).addChoices(
        { name: "👑 Owner",          value: "owner"          },
        { name: "🔱 Co-Owner",       value: "co-owner"       },
        { name: "🛡️ Admin",          value: "admin"          },
        { name: "🔨 Moderator",      value: "moderator"      },
        { name: "🤝 Helper",         value: "helper"         },
        { name: "🧪 Tester",         value: "tester"         },
        { name: "🎨 Artist",         value: "artist"         },
        { name: "💎 Server Booster", value: "server-booster" },
        { name: "⭐ OG",             value: "og"             },
        { name: "🦔 True Hedgehog",  value: "true-hedgehog"  },
      )),

  new SlashCommandBuilder()
    .setName("removerole")
    .setDescription("Remove an in-game role from a player (Owner / Co-Owner / Admin only)")
    .addStringOption(o =>
      o.setName("username").setDescription("Hedgelet username").setRequired(true))
    .addStringOption(o =>
      o.setName("role").setDescription("Role to remove").setRequired(true).addChoices(
        { name: "👑 Owner",          value: "owner"          },
        { name: "🔱 Co-Owner",       value: "co-owner"       },
        { name: "🛡️ Admin",          value: "admin"          },
        { name: "🔨 Moderator",      value: "moderator"      },
        { name: "🤝 Helper",         value: "helper"         },
        { name: "🧪 Tester",         value: "tester"         },
        { name: "🎨 Artist",         value: "artist"         },
        { name: "💎 Server Booster", value: "server-booster" },
        { name: "⭐ OG",             value: "og"             },
        { name: "🦔 True Hedgehog",  value: "true-hedgehog"  },
      )),

  new SlashCommandBuilder()
    .setName("give")
    .setDescription("Give any Hedge to a player (Staff only)")
    .addStringOption(o =>
      o.setName("username").setDescription("Hedgelet username").setRequired(true))
    .addStringOption(o =>
      o.setName("blook").setDescription("Type to search blooks…").setRequired(true).setAutocomplete(true))
    .addIntegerOption(o =>
      o.setName("quantity").setDescription("How many to give (default: 1)").setRequired(false).setMinValue(1).setMaxValue(99)),

  new SlashCommandBuilder()
    .setName("addtokens")
    .setDescription("Add tokens to a player's account (Staff only)")
    .addStringOption(o =>
      o.setName("username").setDescription("Hedgelet username").setRequired(true))
    .addIntegerOption(o =>
      o.setName("amount").setDescription("Number of tokens to add").setRequired(true).setMinValue(1).setMaxValue(100000)),

  new SlashCommandBuilder()
    .setName("createpartnercode")
    .setDescription("Create a partner code for a content creator (Staff only)")
    .addStringOption(o =>
      o.setName("username").setDescription("Hedgelet username to create the code for").setRequired(true))
    .addStringOption(o =>
      o.setName("code").setDescription("Custom code (auto-generated if blank)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("setluck")
    .setDescription("Set global pack-opening luck for all players (Staff only)")
    .addIntegerOption(o =>
      o.setName("multiplier")
        .setDescription("Luck multiplier")
        .setRequired(true)
        .addChoices(
          { name: "Off (1x — normal odds)", value: 1 },
          { name: "3x Luck",                value: 3 },
          { name: "5x Luck",                value: 5 },
          { name: "10x Luck",               value: 10 },
        )),

  new SlashCommandBuilder()
    .setName("alt")
    .setDescription("Check if a player has alt accounts linked by IP (Staff only)")
    .addStringOption(o =>
      o.setName("username").setDescription("Hedgelet username to check").setRequired(true)),
].map(c => c.toJSON());

// ── Register slash commands for the guild ─────────────────────────────────────
async function registerCommands(guildId: string) {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN!);
  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user!.id, guildId),
      { body: commands }
    );
    console.log(`Slash commands registered in guild ${guildId}`);
  } catch (e) {
    console.error("Failed to register slash commands:", e);
  }
}

// ── Duration parser ───────────────────────────────────────────────────────────
function parseDuration(raw: string | null): { ms: number | null; label: string } {
  if (!raw || raw.toLowerCase() === "permanent") return { ms: null, label: "permanent" };
  const match = raw.match(/^(\d+)(m|h|d)$/i);
  if (!match) return { ms: null, label: "permanent" };
  const n = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const ms = unit === "m" ? n * 60_000
            : unit === "h" ? n * 3_600_000
            : n * 86_400_000;
  const label = unit === "m" ? `${n} minute${n !== 1 ? "s" : ""}`
              : unit === "h" ? `${n} hour${n !== 1 ? "s" : ""}`
              : `${n} day${n !== 1 ? "s" : ""}`;
  return { ms, label };
}

// Active auto-unmute timers so we can cancel them on /unmute
const muteTimers = new Map<string, ReturnType<typeof setTimeout>>();

async function scheduleAutoUnmute(uid: string, username: string, ms: number) {
  if (muteTimers.has(uid)) clearTimeout(muteTimers.get(uid)!);
  const timer = setTimeout(async () => {
    try {
      await firestore.collection("users").doc(uid).update({
        muted: false, mutedReason: null, mutedBy: null, mutedUntil: null,
      });
      muteTimers.delete(uid);
      console.log(`[AUTO-UNMUTE] ${username} unmuted after timeout`);
      channelReady?.send({
        embeds: [new EmbedBuilder().setColor(Colors.Green)
          .setDescription(`🔊 **${username}**'s mute has expired — they can chat again.`)],
      });
    } catch (e) { console.error("Auto-unmute failed:", e); }
  }, ms);
  muteTimers.set(uid, timer);
}

// ── Helper: find user doc by username ─────────────────────────────────────────
async function findUserByUsername(username: string) {
  // Try exact match first, then lowercase fallback
  for (const q of [username, username.toLowerCase()]) {
    const snap = await firestore.collection("users").where("username", "==", q).limit(1).get();
    if (!snap.empty) return { uid: snap.docs[0].id, data: snap.docs[0].data() };
  }
  return null;
}

// ── Moderation reply helper ───────────────────────────────────────────────────
async function modReply(
  interaction: ChatInputCommandInteraction,
  color: number,
  title: string,
  description: string
) {
  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(description)],
    flags: MessageFlags.Ephemeral,
  });
}

// ── Slash command handlers ────────────────────────────────────────────────────
// ── Rarity colours ────────────────────────────────────────────────────────────
const RARITY_COLORS: Record<string, number> = {
  common: 0x777777, uncommon: 0x4caf50, rare: 0x2196f3,
  epic: 0x9c27b0, legendary: 0xff9800, chroma: 0xffd700, mythical: 0xff0055,
};

const RARITY_LABELS: Record<string, string> = {
  common: "Common", uncommon: "Uncommon", rare: "Rare",
  epic: "Epic", legendary: "Legendary", chroma: "Chroma", mythical: "✨ Mythical",
};

const ROLE_LABELS: Record<string, string> = {
  "owner":          "👑 Owner",
  "co-owner":       "🔱 Co-Owner",
  "admin":          "🛡️ Admin",
  "moderator":      "🔨 Moderator",
  "helper":         "🤝 Helper",
  "tester":         "🧪 Tester",
  "artist":         "🎨 Artist",
  "server-booster": "💎 Server Booster",
  "og":             "⭐ OG",
  "true-hedgehog":  "🦔 True Hedgehog",
};

// ── Blook lookup table (mirrors index.html blookData) ─────────────────────────
interface BlookInfo { name: string; rarity: string; imageUrl?: string; emoji?: string; }
const BLOOK_DATA: Record<number, BlookInfo> = {
  // Hedgehog Pack (common)
  1:  { name: "Hedgehog 1",    rarity: "common",    emoji: "🦔" },
  2:  { name: "Hedgehog 2",    rarity: "common",    emoji: "🦔" },
  3:  { name: "Hedgehog 3",    rarity: "common",    emoji: "🦔" },
  4:  { name: "Hedgehog 4",    rarity: "common",    emoji: "🦔" },
  5:  { name: "Hedgehog 5",    rarity: "common",    emoji: "🦔" },
  6:  { name: "Hedgehog 6",    rarity: "common",    emoji: "🦔" },
  7:  { name: "Hedgehog 7",    rarity: "common",    emoji: "🦔" },
  8:  { name: "Hedgehog 8",    rarity: "common",    emoji: "🦔" },
  9:  { name: "Hedgehog 9",    rarity: "common",    emoji: "🦔" },
  10: { name: "Hedgehog 10",   rarity: "common",    emoji: "🦔" },
  // Fast Food Pack
  11: { name: "Ketchup",       rarity: "rare",      imageUrl: "https://i.postimg.cc/7PN2fhgB/Screenshot-2026-03-21-10-45-36-AM-removebg-preview.png" },
  12: { name: "Mustard",       rarity: "rare",      imageUrl: "https://i.postimg.cc/5yj9qTqz/Screenshot-2026-03-21-11-16-16-AM-removebg-preview-(1).png" },
  13: { name: "French Fries",  rarity: "epic",      imageUrl: "https://i.postimg.cc/FRxzr0Gx/Screenshot-2026-03-21-3-58-26-PM-removebg-preview.png" },
  14: { name: "Milkshake",     rarity: "legendary", imageUrl: "https://i.postimg.cc/tgyBZjp3/Screenshot-2026-03-21-3-48-41-PM-removebg-preview.png" },
  30: { name: "Hot Dog",       rarity: "uncommon",  emoji: "🌭" },
  31: { name: "Hamburger",     rarity: "uncommon",  emoji: "🍔" },
  32: { name: "Pizza",         rarity: "uncommon",  emoji: "🍕" },
  33: { name: "Taco",          rarity: "uncommon",  emoji: "🌮" },
  34: { name: "Soda",          rarity: "rare",      emoji: "🥤" },
  35: { name: "Golden Hot Dog",rarity: "chroma",    emoji: "🌭" },
  // Staff Exclusive
  36: { name: "Day 1 Hedgehog", rarity: "mythical",   emoji: "🦔🏆" },
  // ── Emoji Pack ──
  37: { name: "Money Mouth",    rarity: "common",    emoji: "🤑" },
  38: { name: "Beaming",        rarity: "common",    emoji: "😄" },
  39: { name: "Angry",          rarity: "common",    emoji: "😠" },
  40: { name: "Nerd",           rarity: "common",    emoji: "🤓" },
  41: { name: "Cool",           rarity: "uncommon",  emoji: "😎" },
  42: { name: "Clown",          rarity: "uncommon",  emoji: "🤡" },
  43: { name: "Sob",            rarity: "chroma",    emoji: "😭" },
  44: { name: "Heart Eyes",     rarity: "uncommon",  emoji: "😍" },
  45: { name: "Cold Face",      rarity: "rare",      emoji: "🥶" },
  46: { name: "Expressionless", rarity: "common",    emoji: "😑" },
  47: { name: "Smirk",          rarity: "epic",      emoji: "😏" },
  48: { name: "Relieved",       rarity: "uncommon",  emoji: "😌" },
  49: { name: "Zany",           rarity: "uncommon",  emoji: "🤪" },
  50: { name: "Shushing",       rarity: "rare",      emoji: "🤫" },
  51: { name: "Sleeping",       rarity: "uncommon",  emoji: "😴" },
  52: { name: "Yum",            rarity: "uncommon",  emoji: "😋" },
  // Breakfast Pack
  15: { name: "Pancakes",      rarity: "common",    emoji: "🥞" },
  16: { name: "Bacon",         rarity: "common",    emoji: "🥓" },
  17: { name: "Eggs",          rarity: "common",    emoji: "🍳" },
  18: { name: "Coffee",        rarity: "uncommon",  emoji: "☕" },
  19: { name: "Waffle",        rarity: "uncommon",  emoji: "🧇" },
  20: { name: "Toast",         rarity: "rare",      emoji: "🍞" },
  21: { name: "Donut",         rarity: "legendary", emoji: "🍩" },
  // Fruit Pack
  22: { name: "Apple",         rarity: "common",    emoji: "🍎" },
  23: { name: "Grapes",        rarity: "common",    emoji: "🍇" },
  24: { name: "Strawberry",    rarity: "common",    emoji: "🍓" },
  25: { name: "Banana",        rarity: "common",    emoji: "🍌" },
  26: { name: "Watermelon",    rarity: "uncommon",  emoji: "🍉" },
  27: { name: "Orange",        rarity: "uncommon",  emoji: "🍊" },
  28: { name: "Cherry",        rarity: "rare",      emoji: "🍒" },
  29: { name: "Peach",         rarity: "legendary", emoji: "🍑" },
};

// ── Partner code generator ────────────────────────────────────────────────────
function generatePartnerCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars (O/0, I/1)
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// ── Autocomplete: /give blook field ──────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isAutocomplete()) return;
  if (interaction.commandName !== "give") return;
  const focused = interaction.options.getFocused().toLowerCase();
  const choices = Object.entries(BLOOK_DATA)
    .filter(([, b]) => b.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map(([id, b]) => ({
      name: `${b.emoji || "🃏"} ${b.name} — ${RARITY_LABELS[b.rarity] || b.rarity}`,
      value: id,
    }));
  await interaction.respond(choices);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  const username = interaction.options.getString("username") ?? "";

  try {

  // ── /view — public, no role gate ──────────────────────────────────────────
  if (commandName === "view") {
    await interaction.deferReply();
    const user = await findUserByUsername(username);
    if (!user) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Player not found")
          .setDescription(`No Hedgelet player named **${username}**.`)],
      });
      return;
    }
    const d = user.data;
    const col: Record<string, number> = d.collection || {};
    const unlocked = Object.values(col).filter((v: any) => v > 0).length;
    const tokens   = (d.tokens   ?? 0).toLocaleString();
    const opened   = (d.opened   ?? 0).toLocaleString();
    const msgs     = (d.messagesSent ?? 0).toLocaleString();
    const friends  = (d.friends  ?? []).length;

    // Blook lookup
    const blookId   = typeof d.equippedBlook === "number" ? d.equippedBlook : null;
    const blookInfo = blookId ? BLOOK_DATA[blookId] : null;
    const rarity    = blookInfo?.rarity ?? "common";
    const blookName = blookInfo?.name   ?? "None";
    const titlePrefix = blookInfo?.emoji ? `${blookInfo.emoji} ` : "🦔 ";

    // Get join date from Firebase Auth
    let joinedStr = "Unknown";
    try {
      const authUser = await getAuth().getUser(user.uid);
      if (authUser.metadata.creationTime) {
        joinedStr = new Date(authUser.metadata.creationTime).toLocaleDateString("en-US", {
          year: "numeric", month: "long", day: "numeric",
        });
      }
    } catch (_) {}

    const statusParts: string[] = [];
    if (d.banned) statusParts.push("🔨 Banned");
    if (d.muted)  statusParts.push("🔇 Muted");
    const status = statusParts.length ? statusParts.join(" · ") : "✅ Active";

    const playerRoles: string[] = d.roles ?? [];
    const rolesStr = playerRoles.length
      ? playerRoles.map(r => ROLE_LABELS[r] ?? r).join("  ·  ")
      : "None";

    const embed = new EmbedBuilder()
      .setColor(RARITY_COLORS[rarity] ?? 0x777777)
      .setTitle(`${titlePrefix}${d.username || username}`)
      .addFields(
        { name: "🃏 Equipped Blook",   value: blookId ? `${blookName} *(${RARITY_LABELS[rarity] ?? rarity})*` : "None", inline: false },
        { name: "🪙 Tokens",           value: tokens,            inline: true  },
        { name: "📦 Packs Opened",     value: opened,            inline: true  },
        { name: "💬 Messages Sent",    value: msgs,              inline: true  },
        { name: "✨ Blooks Unlocked",  value: `${unlocked} / 35`,inline: true  },
        { name: "👥 Friends",          value: String(friends),   inline: true  },
        { name: "📅 Joined",           value: joinedStr,         inline: true  },
        { name: "🏷️ Roles",            value: rolesStr,          inline: false },
        { name: "🔰 Status",           value: status,            inline: false },
      )
      .setFooter({ text: "Hedgelet" })
      .setTimestamp();

    // Thumbnail — use image URL if available, else skip (Discord can't render SVG emoji URLs)
    if (blookInfo?.imageUrl) embed.setThumbnail(blookInfo.imageUrl);

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── Mod commands — role gate ───────────────────────────────────────────────
  if (["mute", "unmute", "ban", "unban", "addrole", "removerole"].includes(commandName)) {
  const durationRaw  = interaction.options.getString("duration");
  const reason       = interaction.options.getString("reason") ?? "No reason provided";
  const mod          = interaction.user.username;
  const { ms: durationMs, label: durationLabel } = parseDuration(durationRaw);

  if (!hasModRole(interaction)) {
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Access Denied")
        .setDescription("Only members with the **Owner**, **Co-Owner**, or **Admin** role can use Hedgelet mod commands.")],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = await findUserByUsername(username);
  if (!user) {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ User not found")
        .setDescription(`No Hedgelet player with username **${username}** was found.`)],
    });
    return;
  }

  const ref = firestore.collection("users").doc(user.uid);

  if (commandName === "mute") {
    const mutedUntil = durationMs ? Date.now() + durationMs : null;
    await ref.update({ muted: true, mutedReason: reason, mutedBy: mod, mutedUntil });
    if (durationMs) scheduleAutoUnmute(user.uid, username, durationMs);
    const durationText = durationLabel === "permanent" ? "permanently" : `for **${durationLabel}**`;
    console.log(`[MOD] ${mod} muted ${username} ${durationText}: ${reason}`);
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("🔇 Player Muted")
        .setDescription(`**${username}** has been muted ${durationText}.\n**Reason:** ${reason}`)],
    });
    channelReady?.send({
      embeds: [new EmbedBuilder().setColor(Colors.Orange)
        .setDescription(`🔇 **${username}** was muted ${durationText} by ${mod}. Reason: ${reason}`)],
    });

  } else if (commandName === "unmute") {
    // Cancel any pending auto-unmute timer
    if (muteTimers.has(user.uid)) { clearTimeout(muteTimers.get(user.uid)!); muteTimers.delete(user.uid); }
    await ref.update({ muted: false, mutedReason: null, mutedBy: null, mutedUntil: null });
    console.log(`[MOD] ${mod} unmuted ${username}`);
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("🔊 Player Unmuted")
        .setDescription(`**${username}** can now chat in Hedgelet again.`)],
    });
    channelReady?.send({
      embeds: [new EmbedBuilder().setColor(Colors.Green)
        .setDescription(`🔊 **${username}** was unmuted by ${mod}.`)],
    });

  } else if (commandName === "ban") {
    await ref.update({ banned: true, bannedReason: reason, bannedBy: mod });
    console.log(`[MOD] ${mod} banned ${username}: ${reason}`);
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("🔨 Player Banned")
        .setDescription(`**${username}** has been banned from Hedgelet.\n**Reason:** ${reason}`)],
    });
    channelReady?.send({
      embeds: [new EmbedBuilder().setColor(Colors.Red)
        .setDescription(`🔨 **${username}** was banned by ${mod}. Reason: ${reason}`)],
    });

  } else if (commandName === "unban") {
    await ref.update({ banned: false, bannedReason: null, bannedBy: null });
    console.log(`[MOD] ${mod} unbanned ${username}`);
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("✅ Player Unbanned")
        .setDescription(`**${username}** has been unbanned from Hedgelet.`)],
    });
    channelReady?.send({
      embeds: [new EmbedBuilder().setColor(Colors.Green)
        .setDescription(`✅ **${username}** was unbanned by ${mod}.`)],
    });

  } else if (commandName === "addrole" || commandName === "removerole") {
    const role = interaction.options.getString("role", true);
    const snap = await ref.get();
    const rawRoles = snap.exists ? snap.data()?.roles : undefined;
    const current: string[] = Array.isArray(rawRoles) ? rawRoles.map(String) : [];
    console.log(`[ROLE] ${commandName} by ${mod} on ${username} (uid:${user.uid}) role="${role}" current=${JSON.stringify(current)}`);

    if (commandName === "addrole") {
      if (current.includes(role)) {
        await interaction.editReply({
          embeds: [new EmbedBuilder().setColor(Colors.Yellow)
            .setDescription(`⚠️ **${username}** already has the **${ROLE_LABELS[role] ?? role}** role.`)],
        });
        return;
      }
      const updated = [...current, role];
      await ref.update({ roles: updated });
      console.log(`[ROLE] ${mod} added ${role} to ${username} → ${JSON.stringify(updated)}`);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0x4caf50).setTitle("✅ Role Added")
          .setDescription(`**${ROLE_LABELS[role] ?? role}** has been added to **${username}**.`)],
      });
      channelReady?.send({
        embeds: [new EmbedBuilder().setColor(0x4caf50)
          .setDescription(`🏷️ **${username}** was given the **${ROLE_LABELS[role] ?? role}** role by ${mod}.`)],
      });

    } else {
      if (!current.includes(role)) {
        await interaction.editReply({
          embeds: [new EmbedBuilder().setColor(Colors.Yellow)
            .setDescription(`⚠️ **${username}** does not have the **${ROLE_LABELS[role] ?? role}** role.\n*(Stored roles: ${current.length ? current.join(", ") : "none"})*`)],
        });
        return;
      }
      const updated = current.filter(r => r !== role);
      await ref.update({ roles: updated });
      console.log(`[ROLE] ${mod} removed ${role} from ${username} → ${JSON.stringify(updated)}`);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("🗑️ Role Removed")
          .setDescription(`**${ROLE_LABELS[role] ?? role}** has been removed from **${username}**.`)],
      });
      channelReady?.send({
        embeds: [new EmbedBuilder().setColor(Colors.Orange)
          .setDescription(`🏷️ **${username}**'s **${ROLE_LABELS[role] ?? role}** role was removed by ${mod}.`)],
      });
    }
  }
  } // end mod commands block

  // ── /alt ─────────────────────────────────────────────────────────────────
  if (commandName === "alt") {
    if (!hasModRole(interaction)) {
      await modReply(interaction, Colors.Red, "❌ No Permission", "Only staff can use the alt checker.");
      return;
    }
    await interaction.deferReply();

    const target = await findUserByUsername(username);
    if (!target) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Player Not Found")
          .setDescription(`No Hedgelet player named **${username}**.`)],
      });
      return;
    }

    const knownIps: string[] = Array.isArray(target.data.knownIps) ? target.data.knownIps : [];
    if (knownIps.length === 0) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0x888888).setTitle("🔍 No IP Data")
          .setDescription(`**${username}** has no IP data on record yet. They need to log in after this update is deployed.`)],
      });
      return;
    }

    // Query for all other users who share any known IP (one query per IP)
    const altMap = new Map<string, { username: string; ips: string[] }>();
    await Promise.all(knownIps.map(async (ip) => {
      const snap = await firestore.collection("users")
        .where("knownIps", "array-contains", ip)
        .get();
      for (const doc of snap.docs) {
        if (doc.id === target.uid) continue;
        const d = doc.data();
        const uname = d.username ?? doc.id;
        if (!altMap.has(doc.id)) {
          altMap.set(doc.id, { username: uname, ips: [ip] });
        } else {
          altMap.get(doc.id)!.ips.push(ip);
        }
      }
    }));

    const mod = interaction.user.username;
    console.log(`[ALT] ${mod} checked alts for ${username} (${target.uid}) — ${altMap.size} match(es)`);

    if (altMap.size === 0) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("✅ No Alts Detected")
          .setDescription(`**${username}** has no other accounts linked by IP address.`)
          .setFooter({ text: `IPs checked: ${knownIps.length}` })],
      });
      return;
    }

    // Build alt list
    const altLines = [...altMap.values()].map(a =>
      `• **${a.username}** *(${a.ips.length} shared IP${a.ips.length > 1 ? "s" : ""})*`
    );

    // Find staff role mentions in the guild
    const guild = interaction.guild;
    const staffMentions: string[] = [];
    if (guild) {
      const staffRoleNames = ["owner", "co-owner", "co owner", "admin", "administrator"];
      for (const [, role] of guild.roles.cache) {
        if (staffRoleNames.includes(role.name.toLowerCase())) {
          staffMentions.push(`<@&${role.id}>`);
        }
      }
    }

    const altEmbed = new EmbedBuilder()
      .setColor(Colors.Red)
      .setTitle("⚠️ Alts Detected")
      .setDescription(
        `**${username}** appears to share IP addresses with ${altMap.size} other account${altMap.size > 1 ? "s" : ""}:\n\n` +
        altLines.join("\n")
      )
      .setFooter({ text: `Checked by ${mod} · IPs on record: ${knownIps.length}` })
      .setTimestamp();

    await interaction.editReply({
      ...(staffMentions.length > 0 ? { content: staffMentions.join(" ") } : {}),
      embeds: [altEmbed],
    });
  }

  // ── /addtokens ────────────────────────────────────────────────────────────
  if (commandName === "addtokens") {
    if (!hasModRole(interaction)) {
      await modReply(interaction, Colors.Red, "❌ No Permission", "Only staff can add tokens.");
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const amount = interaction.options.getInteger("amount")!;
    const found  = await findUserByUsername(username);
    if (!found) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Player Not Found")
          .setDescription(`No Hedgelet player named **${username}**.`)],
      });
      return;
    }
    await firestore.collection("users").doc(found.uid).update({
      tokens: FieldValue.increment(amount),
    });
    const newTotal = (found.data.tokens || 0) + amount;
    const mod = interaction.user.username;
    console.log(`[TOKENS] ${mod} gave ${amount} tokens to ${found.data.username} (now ~${newTotal})`);
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle("🪙 Tokens Added")
        .setDescription(`**+${amount} tokens** added to **${found.data.username}**.\nNew balance: ~**${newTotal} 🪙**`)
        .setFooter({ text: `Added by ${mod}` })],
    });
  }

  // ── /createpartnercode ───────────────────────────────────────────────────
  if (commandName === "createpartnercode") {
    if (!hasModRole(interaction)) {
      await modReply(interaction, Colors.Red, "❌ No Permission", "Only staff can create partner codes.");
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const customCode = interaction.options.getString("code");
    const code = customCode
      ? customCode.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20)
      : generatePartnerCode();

    if (!code) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Invalid Code")
          .setDescription("Code must contain letters or numbers.")],
      });
      return;
    }

    const found = await findUserByUsername(username);
    if (!found) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Player Not Found")
          .setDescription(`No Hedgelet player named **${username}**.`)],
      });
      return;
    }

    // Prevent duplicate codes
    const existingSnap = await firestore.collection("partnerCodes").doc(code).get();
    if (existingSnap.exists) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚠️ Code Already Taken")
          .setDescription(`The code **\`${code}\`** already exists. Try a different one.`)],
      });
      return;
    }

    // Prevent giving a player two codes
    if (found.data.partnerCode) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚠️ Already Has a Code")
          .setDescription(`**${found.data.username}** already has partner code **\`${found.data.partnerCode}\`**.`)],
      });
      return;
    }

    await firestore.collection("partnerCodes").doc(code).set({
      ownerUid: found.uid,
      ownerUsername: found.data.username,
      uses: 0,
      createdAt: Date.now(),
    });
    await firestore.collection("users").doc(found.uid).update({ partnerCode: code });

    const mod = interaction.user.username;
    console.log(`[PARTNER] ${mod} created code ${code} for ${found.data.username}`);

    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle("🤝 Partner Code Created")
        .setDescription(`Partner code **\`${code}\`** created for **${found.data.username}**.\nEvery time a player redeems it, they earn **+5 🪙**.`)
        .setFooter({ text: `Created by ${mod}` })],
    });
  }

  // ── /setluck ─────────────────────────────────────────────────────────────
  if (commandName === "setluck") {
    if (!hasModRole(interaction)) {
      await modReply(interaction, Colors.Red, "❌ No Permission", "Only staff can set luck.");
      return;
    }
    const multiplier = interaction.options.getInteger("multiplier", true);
    const mod = interaction.user.username;
    await rtdb.ref("globalLuck").set({
      multiplier,
      activatedBy: mod,
      activatedAt: Date.now(),
    });
    if (multiplier === 1) {
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(Colors.Grey)
          .setTitle("🎲 Luck Reset")
          .setDescription("Pack odds are back to **normal** for all players.")
          .setFooter({ text: `Reset by ${mod}` })],
      });
      console.log(`[LUCK] ${mod} reset luck to 1x`);
    } else {
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle(`🍀 ${multiplier}x Luck Activated!`)
          .setDescription(`All players now have **${multiplier}x luck** when opening packs!\nOdds of rare+ blooks are multiplied — announced on all screens.`)
          .setFooter({ text: `Activated by ${mod}` })],
      });
      console.log(`[LUCK] ${mod} set luck to ${multiplier}x`);
    }
  }

  // ── /give ──────────────────────────────────────────────────────────────────
  if (commandName === "give") {
    if (!hasModRole(interaction)) {
      await modReply(interaction, Colors.Red, "❌ No Permission", "Only staff can use `/give`.");
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const blookIdStr = interaction.options.getString("blook", true);
    const qty        = interaction.options.getInteger("quantity") ?? 1;
    const blookId    = parseInt(blookIdStr, 10);
    const blookInfo  = BLOOK_DATA[blookId];

    if (!blookInfo) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Unknown Blook")
          .setDescription(`No blook found for ID \`${blookIdStr}\`. Use the autocomplete to pick one.`)],
      });
      return;
    }

    const found = await findUserByUsername(username);
    if (!found) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Player Not Found")
          .setDescription(`No Hedgelet player named **${username}**.`)],
      });
      return;
    }

    const current = found.data.collection?.[blookId] ?? 0;
    await firestore.collection("users").doc(found.uid).update({
      [`collection.${blookId}`]: current + qty,
    });

    const mod   = interaction.user.username;
    const emoji = blookInfo.emoji || "🃏";
    const rLabel = RARITY_LABELS[blookInfo.rarity] || blookInfo.rarity;
    console.log(`[GIVE] ${mod} gave ${qty}× ${blookInfo.name} to ${found.data.username}`);

    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(RARITY_COLORS[blookInfo.rarity] ?? Colors.Gold)
        .setTitle("✅ Blook Given")
        .setDescription(`Gave **${qty}×** ${emoji} **${blookInfo.name}** (${rLabel}) to **${found.data.username}**.`)
        .setFooter({ text: `Given by ${mod}` })],
    });
  }

  } catch (e: any) {
    console.error(`[Slash /${commandName}] Unhandled error:`, e?.message ?? e);
    try {
      const errEmbed = new EmbedBuilder().setColor(Colors.Red)
        .setTitle("❌ Error")
        .setDescription(`Something went wrong: ${e?.message ?? "Unknown error"}`);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ embeds: [errEmbed] });
      } else {
        await interaction.reply({ embeds: [errEmbed], flags: MessageFlags.Ephemeral });
      }
    } catch (_) {}
  }
});

// ── Reviewer Discord user IDs ─────────────────────────────────────────────────
const REVIEWER_IDS = [
  "1477329893766336663",
  "1426942471299928297",
  "1271214946843099249",
];

// ── Application listener — watch Firestore for new pending apps ───────────────
async function startApplicationListener() {
  // Only DM for applications submitted AFTER this bridge instance started.
  // This prevents re-DMing reviewers for existing pending apps on every restart.
  const bridgeStartedAt = Date.now();
  console.log("[Apps] Listening for new applications…");
  firestore.collection("applications")
    .where("status", "==", "pending")
    .onSnapshot(async (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== "added") continue;
        // Skip apps that already existed when the bridge started
        const submittedAt: number = change.doc.data().submittedAt ?? 0;
        if (submittedAt <= bridgeStartedAt) continue;
        const app = change.doc.data() as {
          uid: string; username: string; age: number;
          discord: string; email: string; reason: string; submittedAt: number;
        };
        console.log(`[Apps] New application from ${app.username} (${app.discord})`);

        const embed = new EmbedBuilder()
          .setColor(0x8b5a3e)
          .setTitle("🦔 New Hedgelet Application")
          .addFields(
            { name: "👤 Username",       value: app.username,          inline: true },
            { name: "🎂 Age",            value: String(app.age),       inline: true },
            { name: "💬 Discord",        value: app.discord,           inline: true },
            { name: "📝 Why they want to play", value: app.reason,    inline: false },
          )
          .setFooter({ text: `Application ID: ${app.uid}` })
          .setTimestamp(app.submittedAt);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`approve_${app.uid}`)
            .setLabel("✅ Approve")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`deny_${app.uid}`)
            .setLabel("❌ Deny")
            .setStyle(ButtonStyle.Danger),
        );

        for (const reviewerId of REVIEWER_IDS) {
          try {
            const user = await client.users.fetch(reviewerId);
            await user.send({ embeds: [embed], components: [row] });
            console.log(`[Apps] DMed reviewer ${reviewerId}`);
          } catch (e) {
            console.warn(`[Apps] Could not DM reviewer ${reviewerId}:`, (e as Error).message);
            // Fallback: ping them in the server channel with the embed + buttons
            try {
              const channel = await client.channels.fetch(process.env["DISCORD_CHANNEL_ID"]!);
              if (channel && channel.isTextBased() && "send" in channel) {
                await channel.send({
                  content: `<@${reviewerId}> ⚠️ Couldn't DM you — new application to review:`,
                  embeds: [embed],
                  components: [row],
                });
                console.log(`[Apps] Pinged reviewer ${reviewerId} in channel (DM failed)`);
              }
            } catch (e2) {
              console.error(`[Apps] Also failed to ping reviewer ${reviewerId} in channel:`, (e2 as Error).message);
            }
          }
        }
      }
    });
}

// ── Handle approve / deny button clicks ──────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  const { customId } = interaction;
  if (!customId.startsWith("approve_") && !customId.startsWith("deny_")) return;

  // Acknowledge immediately — Discord only gives 3 seconds before showing
  // "This interaction failed". All Firestore + DM work happens after this.
  try {
    await interaction.deferUpdate();
  } catch (e: any) {
    // Interaction already expired (e.g. bot restarted after button was sent)
    console.warn("[Button] deferUpdate failed — interaction expired:", e?.message ?? e);
    return;
  }

  const sepIdx = customId.indexOf("_");
  const action = customId.slice(0, sepIdx) as "approve" | "deny";
  const uid    = customId.slice(sepIdx + 1);
  const appRef = firestore.collection("applications").doc(uid);
  const appSnap = await appRef.get();
  if (!appSnap.exists) {
    await interaction.editReply({ content: "⚠️ Application not found — it may have already been processed.", embeds: [], components: [] });
    return;
  }
  const app = appSnap.data()!;
  if (app.status !== "pending") {
    await interaction.editReply({ content: `⚠️ This application was already **${app.status}**.`, embeds: [], components: [] });
    return;
  }

  const reviewer = interaction.user.username;

  if (action === "approve") {
    // Create player doc in users collection
    const initCollection: Record<number, number> = {};
    for (let i = 1; i <= 52; i++) initCollection[i] = 0;
    await firestore.collection("users").doc(uid).set({
      email: app.email, username: app.username, tokens: 500,
      opened: 0, collection: initCollection, messagesSent: 0,
      friends: [], friendRequests: [], roles: [],
    });
    await appRef.update({ status: "approved", reviewedBy: reviewer, reviewedAt: Date.now() });

    // DM all reviewers that it was approved
    const approvedEmbed = new EmbedBuilder().setColor(Colors.Green)
      .setTitle("✅ Application Approved")
      .setDescription(`**${app.username}**'s application was approved by **${reviewer}**.\nThey can now log in to Hedgelet.`);

    for (const rid of REVIEWER_IDS) {
      try {
        const u = await client.users.fetch(rid);
        await u.send({ embeds: [approvedEmbed] });
      } catch (_) {}
    }

    await interaction.editReply({
      content: `✅ Approved **${app.username}** — their account is now active.`,
      embeds: [], components: [],
    });
    console.log(`[Apps] ${reviewer} approved application for ${app.username}`);

  } else {
    await appRef.update({ status: "denied", reviewedBy: reviewer, reviewedAt: Date.now() });

    // DM all reviewers that it was denied
    const deniedEmbed = new EmbedBuilder().setColor(Colors.Red)
      .setTitle("❌ Application Denied")
      .setDescription(`**${app.username}**'s application was denied by **${reviewer}**.`);

    for (const rid of REVIEWER_IDS) {
      try {
        const u = await client.users.fetch(rid);
        await u.send({ embeds: [deniedEmbed] });
      } catch (_) {}
    }

    await interaction.editReply({
      content: `❌ Denied **${app.username}**'s application.`,
      embeds: [], components: [],
    });
    console.log(`[Apps] ${reviewer} denied application for ${app.username}`);
  }
});

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
    username: message.member?.displayName || message.author.username,
    text,
    blookEmoji: "🎮",
    fromDiscord: true,
    timestamp: Date.now(),
  });

  console.log(`[Discord→Game] ${message.author.username}: ${text}`);
});

// ── Game → Discord ────────────────────────────────────────────────────────────
function startGameListener() {
  chatRef.limitToLast(1).once("value", () => {
    chatRef.limitToLast(200).on("child_added", async (snap) => {
      const key = snap.key!;
      const msg = snap.val();

      if (!msg || !msg.text) return;
      if (seenKeys.has(key)) return;
      if (msg.fromDiscord) return;
      if (msg.uid === BRIDGE_BOT_UID) return;

      seenKeys.add(key);
      if (!channelReady) return;

      const blook = msg.blookEmoji && !msg.blookEmoji.startsWith("http")
        ? msg.blookEmoji : "🦔";

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
client.once("clientReady", async () => {
  console.log(`Discord bridge ready as ${client.user?.tag}`);

  // Register slash commands in all guilds
  for (const [guildId] of client.guilds.cache) {
    await registerCommands(guildId);
  }

  const ch = await client.channels.fetch(DISCORD_CHANNEL_ID!);
  if (!ch || !ch.isTextBased()) {
    console.error("Channel not found or not a text channel");
    process.exit(1);
  }
  channelReady = ch as TextChannel;

  try {
    await channelReady.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xffd700)
          .setTitle("🦔 Hedgelet Chat Bridge Online")
          .setDescription(
            "Messages from the game appear here. Reply to chat with in-game players!\n\n" +
            "**Mod commands (Ban Members permission required):**\n" +
            "`/mute <username> [reason]` · `/unmute <username>`\n" +
            "`/ban <username> [reason]` · `/unban <username>`"
          ),
      ],
    });
  } catch (_) {}

  startGameListener();
  startApplicationListener();
});

// ── Global error guard — prevents uncaught Discord API errors from crashing ───
client.on("error", (e) => {
  console.error("[Discord] Client error (non-fatal):", e?.message ?? e);
});

client.login(DISCORD_TOKEN);

// ── Clean up old seen keys ─────────────────────────────────────────────────────
setInterval(() => {
  if (seenKeys.size > 500) {
    const arr = [...seenKeys];
    arr.slice(0, arr.length - 200).forEach(k => seenKeys.delete(k));
  }
}, 60_000);
