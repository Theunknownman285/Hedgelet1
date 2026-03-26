import { Router } from "express";
import { requireAuth, type AuthRequest } from "../middlewares/auth.js";
import { firestore, FieldValue } from "../lib/firebase.js";

const router = Router();

router.post("/api/track", requireAuth, async (req, res) => {
  const uid = (req as AuthRequest).uid;
  const ip =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";

  try {
    await firestore.collection("users").doc(uid).update({
      lastIp: ip,
      knownIps: FieldValue.arrayUnion(ip),
      lastSeen: Date.now(),
    });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
