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
} from "discord.js";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { getFirestore } from "firebase-admin/firestore";
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
    ephemeral: true,
  });
}

// ── Slash command handlers ────────────────────────────────────────────────────
// ── Rarity colours ────────────────────────────────────────────────────────────
const RARITY_COLORS: Record<string, number> = {
  common: 0x777777, uncommon: 0x4caf50, rare: 0x2196f3,
  epic: 0x9c27b0, legendary: 0xff9800, chroma: 0xffd700,
};

const RARITY_LABELS: Record<string, string> = {
  common: "Common", uncommon: "Uncommon", rare: "Rare",
  epic: "Epic", legendary: "Legendary", chroma: "Chroma",
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

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  const username = interaction.options.getString("username", true);

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
  const durationRaw  = interaction.options.getString("duration");
  const reason       = interaction.options.getString("reason") ?? "No reason provided";
  const mod          = interaction.user.username;
  const { ms: durationMs, label: durationLabel } = parseDuration(durationRaw);

  if (!hasModRole(interaction)) {
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Access Denied")
        .setDescription("Only members with the **Owner**, **Co-Owner**, or **Admin** role can use Hedgelet mod commands.")],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

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
    const current: string[] = snap.exists ? (snap.data()?.roles ?? []) : [];

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
      console.log(`[ROLE] ${mod} added ${role} to ${username}`);
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
            .setDescription(`⚠️ **${username}** does not have the **${ROLE_LABELS[role] ?? role}** role.`)],
        });
        return;
      }
      const updated = current.filter(r => r !== role);
      await ref.update({ roles: updated });
      console.log(`[ROLE] ${mod} removed ${role} from ${username}`);
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
});

client.login(DISCORD_TOKEN);

// ── Clean up old seen keys ─────────────────────────────────────────────────────
setInterval(() => {
  if (seenKeys.size > 500) {
    const arr = [...seenKeys];
    arr.slice(0, arr.length - 200).forEach(k => seenKeys.delete(k));
  }
}, 60_000);
