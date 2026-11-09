/**
 * Firestore for the pages that need it (today: /verify). Kept apart from
 * firebaseWeb.ts so /auth/action, which only needs Auth, never carries
 * the Firestore SDK. Import DYNAMICALLY from a client component only.
 */

import { getFirestore, type Firestore } from "firebase/firestore";

import { activateAppCheck, firebaseApp } from "./firebaseWeb";

/** App Check is activated first so its token rides on every request. */
export function firebaseDb(): Firestore {
  activateAppCheck();
  return getFirestore(firebaseApp());
}
