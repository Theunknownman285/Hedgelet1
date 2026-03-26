import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

router.post("/drops/announce", requireAuth, async (req: Request, res: Response) => {
  const { blookName, blookEmoji, rarity, username } = req.body as {
    blookName?: string;
    blookEmoji?: string;
    rarity?: string;
    username?: string;
  };

  const botToken  = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_DROPS_CHANNEL_ID;

  if (!botToken || !channelId) {
    res.status(503).json({ error: "Drops channel not configured" });
    return;
  }
  if (!blookName || !rarity || !username) {
    res.status(400).json({ error: "Missing fields" });
    return;
  }

  const rarityColors: Record<string, number> = {
    legendary: 0xFF9800,
    chroma:    0xFFD700,
    mythical:  0xFF0055,
  };
  const rarityLabels: Record<string, string> = {
    legendary: "🟠 Legendary",
    chroma:    "✨ Chroma",
    mythical:  "💎 Mythical",
  };

  const color = rarityColors[rarity] ?? 0xFFD700;
  const label = rarityLabels[rarity] ?? rarity.toUpperCase();
  const displayEmoji = blookEmoji && !blookEmoji.startsWith("http") && !blookEmoji.startsWith("/") ? blookEmoji : "";
  const blookDisplay = displayEmoji ? `${displayEmoji} **${blookName}**` : `**${blookName}**`;

  const payload = {
    embeds: [
      {
        title: `${label} Pull!`,
        description: `**${username}** just pulled ${blookDisplay}!`,
        color,
        footer: { text: "Hedgelet" },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bot ${botToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const text = await r.text();
      res.status(502).json({ error: `Discord returned ${r.status}: ${text}` });
      return;
    }
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) });
  }
});

export default router;
