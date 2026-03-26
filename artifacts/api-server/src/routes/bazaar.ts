import { Router } from "express";
import { requireAuth, type AuthRequest } from "../middlewares/auth.js";
import { firestore, FieldValue } from "../lib/firebase.js";
import { type Request, type Response } from "express";

const router = Router();

// ── List a blook for sale ─────────────────────────────────────────────────────
router.post("/bazaar/list", requireAuth, async (req: Request, res: Response) => {
  const myUid = (req as AuthRequest).uid;
  const { blookId, price } = req.body as { blookId?: number; price?: number };

  if (!blookId || typeof price !== "number") {
    res.status(400).json({ error: "blookId and price are required" });
    return;
  }
  if (price < 1 || price > 1_000_000) {
    res.status(400).json({ error: "Price must be between 1 and 1,000,000 tokens" });
    return;
  }

  try {
    const listingId = await firestore.runTransaction(async tx => {
      const userRef = firestore.collection("users").doc(myUid);
      const userDoc = await tx.get(userRef);
      if (!userDoc.exists) throw new Error("User not found.");

      const col: Record<string, number> = { ...(userDoc.data()?.collection || {}) };
      if ((col[blookId] || 0) < 1) throw new Error("You don't own this blook.");

      col[blookId]--;
      const listingRef = firestore.collection("bazaar").doc();

      tx.update(userRef, { collection: col });
      tx.set(listingRef, {
        sellerUid: myUid,
        sellerUsername: userDoc.data()?.username ?? "Unknown",
        blookId,
        price,
        listedAt: Date.now(),
      });
      return listingRef.id;
    });
    res.json({ ok: true, listingId });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Buy a listing ─────────────────────────────────────────────────────────────
router.post("/bazaar/buy", requireAuth, async (req: Request, res: Response) => {
  const myUid = (req as AuthRequest).uid;
  const { listingId } = req.body as { listingId?: string };
  if (!listingId) { res.status(400).json({ error: "listingId is required" }); return; }

  try {
    await firestore.runTransaction(async tx => {
      const listingRef = firestore.collection("bazaar").doc(listingId);
      const buyerRef   = firestore.collection("users").doc(myUid);

      const [listingDoc, buyerDoc] = await Promise.all([tx.get(listingRef), tx.get(buyerRef)]);

      if (!listingDoc.exists) throw new Error("This listing is no longer available.");
      const listing = listingDoc.data()!;
      if (listing.sellerUid === myUid) throw new Error("You can't buy your own listing.");

      const buyerTokens: number = buyerDoc.data()?.tokens ?? 0;
      if (buyerTokens < listing.price) {
        throw new Error(`Not enough tokens. Need ${listing.price.toLocaleString()} but you have ${buyerTokens.toLocaleString()}.`);
      }

      const buyerCol: Record<string, number> = { ...(buyerDoc.data()?.collection || {}) };
      buyerCol[listing.blookId] = (buyerCol[listing.blookId] || 0) + 1;

      const sellerRef = firestore.collection("users").doc(listing.sellerUid);

      tx.delete(listingRef);
      tx.update(buyerRef,  { tokens: FieldValue.increment(-listing.price), collection: buyerCol });
      tx.update(sellerRef, { tokens: FieldValue.increment(listing.price) });
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Cancel a listing ─────────────────────────────────────────────────────────
router.post("/bazaar/cancel", requireAuth, async (req: Request, res: Response) => {
  const myUid = (req as AuthRequest).uid;
  const { listingId } = req.body as { listingId?: string };
  if (!listingId) { res.status(400).json({ error: "listingId is required" }); return; }

  try {
    await firestore.runTransaction(async tx => {
      const listingRef = firestore.collection("bazaar").doc(listingId);
      const listingDoc = await tx.get(listingRef);
      if (!listingDoc.exists) throw new Error("Listing not found.");
      const listing = listingDoc.data()!;
      if (listing.sellerUid !== myUid) throw new Error("Not your listing.");

      const userRef = firestore.collection("users").doc(myUid);
      const userDoc = await tx.get(userRef);
      const col: Record<string, number> = { ...(userDoc.data()?.collection || {}) };
      col[listing.blookId] = (col[listing.blookId] || 0) + 1;

      tx.delete(listingRef);
      tx.update(userRef, { collection: col });
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
