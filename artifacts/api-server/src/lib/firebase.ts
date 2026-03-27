import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";

const serviceAccountRaw = process.env["FIREBASE_SERVICE_ACCOUNT"];
if (!serviceAccountRaw) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT env var is missing");
}
const serviceAccount = JSON.parse(serviceAccountRaw);

if (!getApps().length) {
  initializeApp({
    credential: cert(serviceAccount),
    databaseURL: "https://spacelet-18ec8-default-rtdb.firebaseio.com",
    storageBucket: "spacelet-18ec8.firebasestorage.app",
  });
}

export const firestore = getFirestore();
export const auth = getAuth();
export const bucket = getStorage().bucket();
export { FieldValue };
