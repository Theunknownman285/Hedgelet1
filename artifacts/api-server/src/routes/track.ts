import { Router } from "express";
import { requireAuth, type AuthRequest } from "../middlewares/auth.js";
import { firestore, FieldValue } from "../lib/firebase.js";

const router = Router();

router.post("/track", requireAuth, async (req, res) => {
  const uid = (req as AuthRequest).uid;
  const ip =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";

  try {
    // Check if this IP is banned
    const docId = ip.replace(/[./]/g, "_");
    const ipBanSnap = await firestore.collection("ipBans").doc(docId).get();
    if (ipBanSnap.exists) {
      const banData = ipBanSnap.data();
      return res.status(403).json({
        ok: false,
        ipBanned: true,
        reason: banData?.reason ?? "You have been IP banned.",
      });
    }

    // Record IP normally
    await firestore.collection("users").doc(uid).update({
      lastIp: ip,
      knownIps: FieldValue.arrayUnion(ip),
      lastSeen: Date.now(),
    });

    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

export default router;
