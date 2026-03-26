import { Router } from "express";
import { requireAuth, type AuthRequest } from "../middlewares/auth.js";
import { firestore, FieldValue } from "../lib/firebase.js";
import { type Request, type Response } from "express";

const router = Router();

router.post("/trade/send", requireAuth, async (req: Request, res: Response) => {
  const myUid = (req as AuthRequest).uid;
  const { toUid, toUsername, fromUsername, offerBlooks, requestBlooks } =
    req.body as {
      toUid?: string; toUsername?: string; fromUsername?: string;
      offerBlooks?: number[]; requestBlooks?: number[];
    };
  if (!toUid || toUid === myUid) { res.status(400).json({ error: "Invalid target" }); return; }
  if ((!offerBlooks?.length) && (!requestBlooks?.length)) {
    res.status(400).json({ error: "Select at least one blook" }); return;
  }
  try {
    const mySnap = await firestore.collection("users").doc(myUid).get();
    const myCol  = mySnap.data()?.collection || {};
    for (const id of offerBlooks || []) {
      if ((myCol[id] || 0) < 1) {
        res.status(400).json({ error: `You don't own blook #${id}` }); return;
      }
    }
    await firestore.collection("trades").add({
      fromUid: myUid, fromUsername,
      toUid, toUsername,
      offerBlooks: offerBlooks || [],
      requestBlooks: requestBlooks || [],
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
    });
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) });
  }
});

router.get("/trade/incoming", requireAuth, async (req: Request, res: Response) => {
  const myUid = (req as AuthRequest).uid;
  try {
    const snap = await firestore.collection("trades")
      .where("toUid", "==", myUid)
      .where("status", "==", "pending")
      .get();
    const trades = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ trades });
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) });
  }
});

router.post("/trade/accept", requireAuth, async (req: Request, res: Response) => {
  const myUid = (req as AuthRequest).uid;
  const { tradeId } = req.body as { tradeId?: string };
  if (!tradeId) { res.status(400).json({ error: "Missing tradeId" }); return; }
  try {
    const tradeRef = firestore.collection("trades").doc(tradeId);
    await firestore.runTransaction(async tx => {
      const tradeDoc = await tx.get(tradeRef);
      if (!tradeDoc.exists || tradeDoc.data()?.status !== "pending") {
        throw new Error("Trade is no longer valid.");
      }
      const trade = tradeDoc.data()!;
      if (trade.toUid !== myUid) throw new Error("Not your trade.");
      const myRef    = firestore.collection("users").doc(myUid);
      const theirRef = firestore.collection("users").doc(trade.fromUid);
      const [myDoc, theirDoc] = await Promise.all([tx.get(myRef), tx.get(theirRef)]);
      const myCol    = { ...(myDoc.data()?.collection || {}) };
      const theirCol = { ...(theirDoc.data()?.collection || {}) };
      for (const id of trade.requestBlooks) {
        if ((myCol[id] || 0) < 1) throw new Error(`You no longer have blook #${id}.`);
      }
      for (const id of trade.offerBlooks) {
        if ((theirCol[id] || 0) < 1) throw new Error(`Sender no longer has blook #${id}.`);
      }
      for (const id of trade.requestBlooks) {
        myCol[id]    = (myCol[id] || 0) - 1;
        theirCol[id] = (theirCol[id] || 0) + 1;
      }
      for (const id of trade.offerBlooks) {
        theirCol[id] = (theirCol[id] || 0) - 1;
        myCol[id]    = (myCol[id] || 0) + 1;
      }
      tx.update(myRef,    { collection: myCol });
      tx.update(theirRef, { collection: theirCol });
      tx.update(tradeRef, { status: "accepted" });
    });
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(500).json({ error: String(e instanceof Error ? e.message : String(e)) });
  }
});

router.post("/trade/decline", requireAuth, async (req: Request, res: Response) => {
  const myUid = (req as AuthRequest).uid;
  const { tradeId } = req.body as { tradeId?: string };
  if (!tradeId) { res.status(400).json({ error: "Missing tradeId" }); return; }
  try {
    const tradeDoc = await firestore.collection("trades").doc(tradeId).get();
    if (!tradeDoc.exists) { res.status(404).json({ error: "Trade not found" }); return; }
    if (tradeDoc.data()?.toUid !== myUid) { res.status(403).json({ error: "Forbidden" }); return; }
    await firestore.collection("trades").doc(tradeId).update({ status: "declined" });
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) });
  }
});

export default router;
