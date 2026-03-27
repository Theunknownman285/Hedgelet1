import { type Request, type Response, type NextFunction } from "express";
import { auth } from "../lib/firebase.js";

export interface AuthRequest extends Request {
  uid: string;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Missing auth token" });
    return;
  }
  try {
    const decoded = await auth.verifyIdToken(token);
    (req as AuthRequest).uid = decoded.uid;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired auth token" });
  }
}
