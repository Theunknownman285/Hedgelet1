/**
 * Updates Firestore security rules to allow public reads on users/applications
 * (needed for username lookups during login/apply) while keeping writes auth-gated.
 */
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { GoogleAuth } from "google-auth-library";

const serviceAccountRaw = process.env["FIREBASE_SERVICE_ACCOUNT"];
if (!serviceAccountRaw) { console.error("FIREBASE_SERVICE_ACCOUNT missing"); process.exit(1); }

const serviceAccount = JSON.parse(serviceAccountRaw);
const projectId: string = serviceAccount.project_id;

if (!getApps().length) initializeApp({ credential: cert(serviceAccount) });

// Get an access token scoped to the Firebase Rules API
const auth = new GoogleAuth({
  credentials: serviceAccount,
  scopes: ["https://www.googleapis.com/auth/firebase"],
});
const client = await auth.getClient();
const tokenResponse = await client.getAccessToken();
const token = tokenResponse.token;

const rules = `
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Public reads on users and applications — needed for username lookups
    // during login and application status checks (no auth required).
    match /users/{uid} {
      allow read: if true;
      allow write: if request.auth != null;
    }

    match /applications/{uid} {
      allow read: if true;
      allow write: if request.auth != null;
    }

    // Everything else requires auth for both read and write
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
`.trim();

// 1. Create a new ruleset
const createRes = await fetch(
  `https://firebaserules.googleapis.com/v1/projects/${projectId}/rulesets`,
  {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      source: {
        files: [{ name: "firestore.rules", content: rules }],
      },
    }),
  }
);

if (!createRes.ok) {
  const err = await createRes.text();
  console.error("Failed to create ruleset:", err);
  process.exit(1);
}

const ruleset = await createRes.json() as { name: string };
console.log("Created ruleset:", ruleset.name);

// 2. Update the cloud.firestore release to point to the new ruleset
const releaseRes = await fetch(
  `https://firebaserules.googleapis.com/v1/projects/${projectId}/releases/cloud.firestore`,
  {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      release: { name: `projects/${projectId}/releases/cloud.firestore`, rulesetName: ruleset.name },
    }),
  }
);

if (!releaseRes.ok) {
  const err = await releaseRes.text();
  console.error("Failed to update release:", err);
  process.exit(1);
}

console.log("✅ Firestore rules updated — users and applications are now publicly readable.");
console.log("   All writes still require authentication.");
