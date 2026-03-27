import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const serviceAccountRaw = process.env["FIREBASE_SERVICE_ACCOUNT"];
if (!serviceAccountRaw) { console.error("FIREBASE_SERVICE_ACCOUNT missing"); process.exit(1); }

if (!getApps().length) {
  initializeApp({ credential: cert(JSON.parse(serviceAccountRaw)) });
}

const firestore = getFirestore();

const testUid = `test_application_${Date.now()}`;

await firestore.collection("applications").doc(testUid).set({
  uid: testUid,
  age: 16,
  discord: "TestUser#1234",
  username: "testplayer",
  email: "test@example.com",
  reason: "This is a TEST application sent by the system to verify the DM and button flow works correctly. You can safely ignore or click Deny.",
  status: "pending",
  submittedAt: Date.now(),
});

console.log(`✅ Test application inserted (ID: ${testUid})`);
console.log("The bot should DM all reviewers momentarily with Approve/Deny buttons.");
