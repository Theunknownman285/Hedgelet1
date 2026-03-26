import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import friendsRouter from "./friends.js";
import tradesRouter from "./trades.js";
import dropsRouter from "./drops.js";
import trackRouter from "./track.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(friendsRouter);
router.use(tradesRouter);
router.use(dropsRouter);
router.use(trackRouter);

export default router;
