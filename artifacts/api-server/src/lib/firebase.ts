import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

const serviceAccountRaw = process.env["FIREBASE_SERVICE_ACCOUNT"];
if (!serviceAccountRaw) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT env var is missing");
}
const serviceAccount = JSON.parse(serviceAccountRaw);

if (!getApps().length) {
  initializeApp({
    credential: cert(serviceAccount),
    databaseURL: "https://hedgelet-292a4-default-rtdb.firebaseio.com",
  });
}

export const firestore = getFirestore();
export const auth = getAuth();
export { FieldValue };
