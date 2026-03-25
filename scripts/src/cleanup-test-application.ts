import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const serviceAccountRaw = process.env["FIREBASE_SERVICE_ACCOUNT"];
if (!serviceAccountRaw) { console.error("FIREBASE_SERVICE_ACCOUNT missing"); process.exit(1); }
if (!getApps().length) initializeApp({ credential: cert(JSON.parse(serviceAccountRaw)) });

const firestore = getFirestore();
const snap = await firestore.collection("applications")
  .where("username", "==", "testplayer").get();

for (const doc of snap.docs) {
  await doc.ref.delete();
  console.log(`Deleted test application: ${doc.id}`);
}
console.log(`Done — removed ${snap.size} test document(s).`);
