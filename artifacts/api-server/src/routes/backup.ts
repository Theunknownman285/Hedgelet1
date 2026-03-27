import { Router } from "express";
import { firestore, auth, bucket } from "../lib/firebase.js";

const router = Router();

const BACKUP_SECRET = process.env["BACKUP_SECRET"] ?? "hedgelet-backup-secret-2024";
const WEBHOOK_URL   = process.env["DISCORD_WEBHOOK_URL"];

async function notifyDiscord(msg: string) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: msg }),
    });
  } catch (_) {}
}

const COLLECTIONS = ["users", "clans", "bazaar", "applications", "partnerCodes", "ipBans", "trades"];

export async function runBackup(): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename  = `backups/hedgelet-backup-${timestamp}.json`;
  const data: Record<string, Record<string, unknown>> = {};

  for (const col of COLLECTIONS) {
    data[col] = {};
    const snap = await firestore.collection(col).get();
    snap.forEach(doc => { data[col][doc.id] = doc.data(); });
  }

  // Include Firebase Auth users
  data["_authUsers"] = {};
  let pageToken: string | undefined;
  do {
    const result = await auth.listUsers(1000, pageToken);
    result.users.forEach(u => {
      data["_authUsers"][u.uid] = {
        uid: u.uid,
        email: u.email,
        displayName: u.displayName,
        disabled: u.disabled,
        createdAt: u.metadata.creationTime,
      };
    });
    pageToken = result.pageToken;
  } while (pageToken);

  const json    = JSON.stringify(data, null, 2);
  const file    = bucket.file(filename);
  await file.save(Buffer.from(json, "utf8"), { contentType: "application/json" });
  await file.makePublic();
  const url = `https://storage.googleapis.com/${bucket.name}/${filename}`;

  const counts = Object.entries(data)
    .map(([k, v]) => `${k}: ${Object.keys(v).length}`)
    .join(", ");

  await notifyDiscord(
    `🛡️ **Hedgelet Backup Complete**\n` +
    `📦 Collections: ${counts}\n` +
    `🔗 [Download backup](${url})\n` +
    `🕐 ${new Date().toUTCString()}`
  );

  return url;
}

// POST /api/admin/backup  — requires secret header
router.post("/admin/backup", async (req, res) => {
  const secret = req.headers["x-backup-secret"] ?? req.body?.secret;
  if (secret !== BACKUP_SECRET) {
    await notifyDiscord(
      `⚠️ **Unauthorized backup attempt** from IP \`${req.ip}\`\n` +
      `Header: \`${secret ?? "(none)"}\``
    );
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const url = await runBackup();
    return res.json({ ok: true, url });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
});

// GET /api/admin/backup/list — lists all backup files
router.get("/admin/backup/list", async (req, res) => {
  const secret = req.headers["x-backup-secret"] ?? req.query?.secret;
  if (secret !== BACKUP_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const [files] = await bucket.getFiles({ prefix: "backups/" });
    const list = files.map(f => ({
      name: f.name,
      size: f.metadata.size,
      created: f.metadata.timeCreated,
      url: `https://storage.googleapis.com/${bucket.name}/${f.name}`,
    }));
    return res.json({ backups: list.reverse() });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
});

// POST /api/admin/restore  — restores Firestore from a backup JSON in Storage
router.post("/admin/restore", async (req, res) => {
  const secret   = req.headers["x-backup-secret"] ?? req.body?.secret;
  const filename = req.body?.filename as string | undefined;
  if (secret !== BACKUP_SECRET) {
    await notifyDiscord(`⚠️ **Unauthorized restore attempt** from IP \`${req.ip}\``);
    return res.status(403).json({ error: "Forbidden" });
  }
  if (!filename) return res.status(400).json({ error: "filename required" });

  try {
    const file = bucket.file(filename);
    const [exists] = await file.exists();
    if (!exists) return res.status(404).json({ error: "Backup file not found" });

    const [contents] = await file.download();
    const data: Record<string, Record<string, unknown>> = JSON.parse(contents.toString("utf8"));

    let docsWritten = 0;
    for (const [col, docs] of Object.entries(data)) {
      if (col === "_authUsers") continue; // Auth can't be restored this way
      const colRef = firestore.collection(col);
      const chunks = Object.entries(docs);
      for (let i = 0; i < chunks.length; i += 400) {
        const batch = firestore.batch();
        for (const [docId, docData] of chunks.slice(i, i + 400)) {
          batch.set(colRef.doc(docId), docData as Record<string, unknown>);
        }
        await batch.commit();
        docsWritten += chunks.slice(i, i + 400).length;
      }
    }

    const authCount = Object.keys(data["_authUsers"] ?? {}).length;
    await notifyDiscord(
      `✅ **Hedgelet Restore Complete**\n` +
      `📄 Docs restored: **${docsWritten}**\n` +
      `👤 Auth accounts in backup: **${authCount}** (Auth cannot be automatically restored — accounts will be recreated when players log in)\n` +
      `📦 Source: \`${filename}\``
    );

    return res.json({ ok: true, docsWritten });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
});

export default router;
