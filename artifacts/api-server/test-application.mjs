import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

if (!getApps().length) {
  initializeApp({ credential: cert(serviceAccount) });
}

const db = getFirestore();

const testUid = 'TEST_APPLICATION_' + Date.now();
await db.collection('applications').doc(testUid).set({
  uid: testUid,
  username: 'testuser123',
  age: 17,
  discord: 'TestUser#0001',
  email: 'test@example.com',
  reason: 'This is a test application submitted to verify the Discord DM flow is working correctly.',
  status: 'pending',
  submittedAt: Date.now(),
});

console.log('✅ Test application submitted with ID:', testUid);
