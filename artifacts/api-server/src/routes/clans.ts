import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { firestore, bucket } from "../lib/firebase.js";

const router = Router();

router.post("/clans/upload-banner", requireAuth, async (req: Request, res: Response) => {
  const uid = (req as Request & { uid?: string }).uid;
  const { clanId, imageBase64, mimeType } = req.body as {
    clanId?: string;
    imageBase64?: string;
    mimeType?: string;
  };

  if (!clanId || !imageBase64 || !mimeType) {
    res.status(400).json({ error: "Missing clanId, imageBase64, or mimeType" });
    return;
  }

  const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  if (!allowed.includes(mimeType)) {
    res.status(400).json({ error: "Unsupported image type" });
    return;
  }

  const clanDoc = await firestore.collection("clans").doc(clanId).get();
  if (!clanDoc.exists) {
    res.status(404).json({ error: "Clan not found" });
    return;
  }
  if (clanDoc.data()?.ownerId !== uid) {
    res.status(403).json({ error: "Only the clan owner can change the banner" });
    return;
  }

  try {
    const buffer = Buffer.from(imageBase64, "base64");
    if (buffer.byteLength > 5 * 1024 * 1024) {
      res.status(400).json({ error: "Image too large (max 5 MB)" });
      return;
    }

    const ext = mimeType.split("/")[1] ?? "jpg";
    const filePath = `clan-banners/${clanId}.${ext}`;
    const file = bucket.file(filePath);

    await file.save(buffer, {
      metadata: { contentType: mimeType },
      public: true,
    });

    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
    await firestore.collection("clans").doc(clanId).update({ bannerUrl: publicUrl });

    res.json({ ok: true, url: publicUrl });
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) });
  }
});

export default router;
