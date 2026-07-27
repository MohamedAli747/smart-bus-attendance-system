import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getDatabase } from "firebase/database";
import { getAuth } from "firebase/auth";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyBUrATL8eB2UYfb_kH884yceYL4-48sv18",
  authDomain: "wicmic-71b1e.firebaseapp.com",
  databaseURL: "https://wicmic-71b1e-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "wicmic-71b1e",
  appId: "1:523290422820:web:3daa101e0988a92fbfb2b1",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Services safely to prevent blank screen crashes
let db = null;
let rtdb = null;
let auth = null;
let storage = null;

try {
  auth = getAuth(app);
} catch (e) {
  console.error("Auth init error:", e);
}

try {
  rtdb = getDatabase(app);
} catch (e) {
  console.error("RTDB init error:", e);
}

try {
  db = getFirestore(app);
} catch (e) {
  console.error("Firestore init error:", e);
}

try {
  storage = getStorage(app);
} catch (e) {
  console.error("Storage init error:", e);
}

export { db, rtdb, auth, storage };
