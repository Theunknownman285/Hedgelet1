import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import friendsRouter from "./friends.js";
import tradesRouter from "./trades.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(friendsRouter);
router.use(tradesRouter);

export default router;
