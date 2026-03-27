import { Router } from "express";
import { requireAuth, type AuthRequest } from "../middlewares/auth.js";
import { firestore, FieldValue } from "../lib/firebase.js";
import { type Request, type Response } from "express";

const router = Router();

router.post("/friend-request", requireAuth, async (req: Request, res: Response) => {
  const myUid = (req as AuthRequest).uid;
  const { targetUid } = req.body as { targetUid?: string };
  if (!targetUid || targetUid === myUid) {
    res.status(400).json({ error: "Invalid target" });
    return;
  }
  try {
    const targetRef = firestore.collection("users").doc(targetUid);
    const targetSnap = await targetRef.get();
    if (!targetSnap.exists) { res.status(404).json({ error: "User not found" }); return; }
    const mySnap = await firestore.collection("users").doc(myUid).get();
    const myFriends: string[] = mySnap.data()?.friends || [];
    if (myFriends.includes(targetUid)) { res.status(409).json({ error: "Already friends" }); return; }
    const theirRequests: string[] = targetSnap.data()?.friendRequests || [];
    if (theirRequests.includes(myUid)) { res.status(409).json({ error: "Request already sent" }); return; }
    await targetRef.update({ friendRequests: FieldValue.arrayUnion(myUid) });
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) });
  }
});

router.post("/friend-accept", requireAuth, async (req: Request, res: Response) => {
  const myUid = (req as AuthRequest).uid;
  const { fromUid } = req.body as { fromUid?: string };
  if (!fromUid) { res.status(400).json({ error: "Missing fromUid" }); return; }
  try {
    const myRef   = firestore.collection("users").doc(myUid);
    const fromRef = firestore.collection("users").doc(fromUid);
    await Promise.all([
      myRef.update({
        friends:        FieldValue.arrayUnion(fromUid),
        friendRequests: FieldValue.arrayRemove(fromUid),
      }),
      fromRef.update({ friends: FieldValue.arrayUnion(myUid) }),
    ]);
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) });
  }
});

router.post("/friend-decline", requireAuth, async (req: Request, res: Response) => {
  const myUid = (req as AuthRequest).uid;
  const { fromUid } = req.body as { fromUid?: string };
  if (!fromUid) { res.status(400).json({ error: "Missing fromUid" }); return; }
  try {
    await firestore.collection("users").doc(myUid).update({
      friendRequests: FieldValue.arrayRemove(fromUid),
    });
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) });
  }
});

router.post("/friend-remove", requireAuth, async (req: Request, res: Response) => {
  const myUid = (req as AuthRequest).uid;
  const { friendUid } = req.body as { friendUid?: string };
  if (!friendUid) { res.status(400).json({ error: "Missing friendUid" }); return; }
  try {
    await Promise.all([
      firestore.collection("users").doc(myUid).update({ friends: FieldValue.arrayRemove(friendUid) }),
      firestore.collection("users").doc(friendUid).update({ friends: FieldValue.arrayRemove(myUid) }),
    ]);
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) });
  }
});

// Lookup public profile data for a list of UIDs (bypasses client Firestore rules)
router.post("/users/lookup", requireAuth, async (req: Request, res: Response) => {
  const { uids } = req.body as { uids?: string[] };
  if (!Array.isArray(uids) || uids.length === 0) {
    res.json({ users: {} });
    return;
  }
  const limited = uids.slice(0, 100);
  try {
    const snaps = await Promise.all(limited.map(uid => firestore.collection("users").doc(uid).get()));
    const users: Record<string, { username: string; equippedBlook: number | null }> = {};
    snaps.forEach(snap => {
      if (!snap.exists) return;
      const d = snap.data()!;
      users[snap.id] = { username: d.username || "Unknown", equippedBlook: d.equippedBlook ?? null };
    });
    res.json({ users });
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) });
  }
});

export default router;
