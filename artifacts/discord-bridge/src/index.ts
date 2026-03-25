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
// default_member_permissions(0) hides commands from regular members by default;
// role-based access is enforced in code via hasModRole().
const commands = [
  new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Mute a player in Hedgelet (they cannot send in-game chat)")
    .setDefaultMemberPermissions(0)
    .addStringOption(o =>
      o.setName("username").setDescription("Hedgelet username").setRequired(true))
    .addStringOption(o =>
      o.setName("reason").setDescription("Reason for mute").setRequired(false)),

  new SlashCommandBuilder()
    .setName("unmute")
    .setDescription("Unmute a player in Hedgelet")
    .setDefaultMemberPermissions(0)
    .addStringOption(o =>
      o.setName("username").setDescription("Hedgelet username").setRequired(true)),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a player from Hedgelet (they cannot log in)")
    .setDefaultMemberPermissions(0)
    .addStringOption(o =>
      o.setName("username").setDescription("Hedgelet username").setRequired(true))
    .addStringOption(o =>
      o.setName("reason").setDescription("Reason for ban").setRequired(false)),

  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a player from Hedgelet")
    .setDefaultMemberPermissions(0)
    .addStringOption(o =>
      o.setName("username").setDescription("Hedgelet username").setRequired(true)),
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

// ── Helper: find user doc by username ─────────────────────────────────────────
async function findUserByUsername(username: string) {
  const snap = await firestore
    .collection("users")
    .where("username", "==", username.toLowerCase())
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { uid: snap.docs[0].id, data: snap.docs[0].data() };
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

// ── Slash command handler ─────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  const username = interaction.options.getString("username", true).toLowerCase();
  const reason   = interaction.options.getString("reason") ?? "No reason provided";
  const mod      = interaction.user.username;

  // Role gate — only Owner, Co-Owner, Admin roles may use these commands
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
    await ref.update({ muted: true, mutedReason: reason, mutedBy: mod });
    console.log(`[MOD] ${mod} muted ${username}: ${reason}`);
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("🔇 Player Muted")
        .setDescription(`**${username}** has been muted in Hedgelet.\n**Reason:** ${reason}`)],
    });
    channelReady?.send({
      embeds: [new EmbedBuilder().setColor(Colors.Orange)
        .setDescription(`🔇 **${username}** was muted by ${mod}. Reason: ${reason}`)],
    });

  } else if (commandName === "unmute") {
    await ref.update({ muted: false, mutedReason: null, mutedBy: null });
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
