import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import friendsRouter from "./friends.js";
import tradesRouter from "./trades.js";
import dropsRouter from "./drops.js";
import trackRouter from "./track.js";
import bazaarRouter from "./bazaar.js";
import clansRouter from "./clans.js";
import backupRouter, { runBackup } from "./backup.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(friendsRouter);
router.use(tradesRouter);
router.use(dropsRouter);
router.use(trackRouter);
router.use(bazaarRouter);
router.use(clansRouter);
router.use(backupRouter);

// ── Scheduled auto-backup every 24 hours ─────────────────────────────────────
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
async function scheduleBackup() {
  try {
    console.log("[Backup] Running scheduled backup…");
    const url = await runBackup();
    console.log("[Backup] Done:", url);
  } catch (e) {
    console.error("[Backup] Scheduled backup failed:", e);
  }
  setTimeout(scheduleBackup, TWENTY_FOUR_HOURS);
}
// First backup 5 minutes after startup, then every 24 hours
setTimeout(scheduleBackup, 5 * 60 * 1000);

export default router;
