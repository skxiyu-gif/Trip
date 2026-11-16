import { initializeApp } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyADFoPBxF-M_BTw2gHSLtvGCfz0-iWr1lU",
  authDomain: "trip-china-36c89.firebaseapp.com",
  projectId: "trip-china-36c89",
  storageBucket: "trip-china-36c89.firebasestorage.app",
  messagingSenderId: "1289075332808",
  appId: "1:1289075332808:web:8ad07e67807b0dcb707fd"
};
const KEY = "family-trip-planner-v1";
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

const style = document.createElement("style");
style.textContent = ".cloud-sync{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:16px 0;padding:10px 14px;border:1px solid #d5e0d8;border-radius:6px;background:#fffefa;font:13px sans-serif}.cloud-sync-status{color:#52675c}.cloud-sync-actions{display:flex;gap:8px}.cloud-sync button{border:1px solid #d5e0d8;border-radius:4px;background:#fff;padding:7px 11px;font:inherit;font-weight:700;cursor:pointer}.cloud-sync button.primary{background:#285b4c;border-color:#285b4c;color:#fff}.cloud-sync[hidden]{display:none}@media(max-width:600px){.cloud-sync{align-items:flex-start;flex-direction:column}.cloud-sync-actions{width:100%}}";
document.head.append(style);

const bar = document.createElement("section");
bar.className = "cloud-sync";
bar.setAttribute("aria-label", "Firebase 동기화");
bar.innerHTML = '<span id="cloudSyncStatus" class="cloud-sync-status">이 브라우저에 저장 중</span><span class="cloud-sync-actions"><button id="cloudSignIn" class="primary" type="button">Google 로그인하고 동기화</button><button id="cloudSignOut" type="button" hidden>로그아웃</button></span>';
const header = document.querySelector("header");
if (header) header.insertAdjacentElement("afterend", bar);
const statusEl = document.getElementById("cloudSyncStatus");
const signInButton = document.getElementById("cloudSignIn");
const signOutButton = document.getElementById("cloudSignOut");

const originalSetItem = Storage.prototype.setItem;
const originalGetItem = Storage.prototype.getItem;
let applyingCloud = false;
let activeUser = null;
let stopSnapshot = null;
let saveTimer = null;
let queuedWrite = Promise.resolve();

function setStatus(message) {
  if (statusEl) statusEl.textContent = message;
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
}
function fingerprint(value) {
  return JSON.stringify(stableValue(value));
}
function readLocalPlan() {
  const raw = originalGetItem.call(window.localStorage, KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function scheduleCloudSave(raw) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    if (!activeUser || applyingCloud) return;
    let plan;
    try { plan = JSON.parse(raw); } catch { return; }
    const reference = doc(db, "trips", activeUser.uid);
    const owner = activeUser;
    queuedWrite = queuedWrite.then(function () {
      if (!activeUser || activeUser.uid !== owner.uid) return;
      return setDoc(reference, {
        plan: plan,
        ownerUid: owner.uid,
        ownerEmail: owner.email || "",
        updatedAt: serverTimestamp()
      }, { merge: true });
    }).then(function () {
      if (activeUser && activeUser.uid === owner.uid) setStatus("Firebase에 자동 저장됨 · " + (owner.email || owner.displayName || "로그인됨"));
    }).catch(function (error) {
      setStatus("클라우드 저장 오류: " + (error.code || error.message));
      console.error("Firebase save failed", error);
    });
  }, 450);
}
Storage.prototype.setItem = function (key, value) {
  originalSetItem.call(this, key, value);
  if (this === window.localStorage && key === KEY && activeUser && !applyingCloud) {
    scheduleCloudSave(String(value));
  }
};

function applyCloudPlan(plan) {
  applyingCloud = true;
  originalSetItem.call(window.localStorage, KEY, JSON.stringify(plan));
  applyingCloud = false;
  setStatus("클라우드 계획을 불러오는 중…");
  window.location.reload();
}
function startWatching(user, reference) {
  if (stopSnapshot) stopSnapshot();
  stopSnapshot = onSnapshot(reference, function (snapshot) {
    if (!snapshot.exists()) return;
    const cloudPlan = snapshot.data().plan;
    if (!cloudPlan) return;
    const localPlan = readLocalPlan();
    if (fingerprint(localPlan) !== fingerprint(cloudPlan)) applyCloudPlan(cloudPlan);
    else setStatus("Firebase 동기화 중 · " + (user.email || user.displayName || "로그인됨"));
  }, function (error) {
    setStatus("동기화 오류: " + (error.code || error.message));
    console.error("Firebase listener failed", error);
  });
}
async function connectUser(user) {
  activeUser = user;
  signInButton.hidden = true;
  signOutButton.hidden = false;
  setStatus("Firebase 계획 확인 중…");
  const reference = doc(db, "trips", user.uid);
  const snapshot = await getDoc(reference);
  if (snapshot.exists() && snapshot.data().plan) {
    const cloudPlan = snapshot.data().plan;
    const localPlan = readLocalPlan();
    if (fingerprint(localPlan) !== fingerprint(cloudPlan)) {
      applyCloudPlan(cloudPlan);
      return;
    }
    setStatus("Firebase 동기화 중 · " + (user.email || user.displayName || "로그인됨"));
    startWatching(user, reference);
    return;
  }
  const localPlan = readLocalPlan();
  if (!localPlan) {
    setStatus("이 기기에 여행 계획이 없어 첫 동기화를 시작할 수 없습니다.");
    await signOut(auth);
    return;
  }
  const scheduleCount = Array.isArray(localPlan.schedule) ? localPlan.schedule.length : 0;
  const taskCount = Array.isArray(localPlan.checklist) ? localPlan.checklist.length : 0;
  const packingCount = Array.isArray(localPlan.packing) ? localPlan.packing.length : 0;
  const confirmed = window.confirm(
    "Firebase에 공유 계획이 아직 없습니다.\n\n현재 이 기기의 계획을 첫 공유 계획으로 저장할까요?\n일정 " + scheduleCount + "개 · 해야 할 일 " + taskCount + "개 · 준비물 " + packingCount + "개\n\n회사 컴퓨터에 최신 계획이 있다면 그 컴퓨터에서 먼저 로그인해 주세요."
  );
  if (!confirmed) {
    setStatus("첫 동기화 대기 중 · 최신 계획이 있는 기기에서 로그인하세요.");
    await signOut(auth);
    return;
  }
  await setDoc(reference, {
    plan: localPlan,
    ownerUid: user.uid,
    ownerEmail: user.email || "",
    updatedAt: serverTimestamp()
  });
  setStatus("첫 계획을 Firebase에 저장했습니다.");
  startWatching(user, reference);
}

signInButton.addEventListener("click", async function () {
  signInButton.disabled = true;
  setStatus("Google 로그인 중…");
  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    setStatus("Google 로그인 오류: " + (error.code || error.message));
    console.error("Firebase sign-in failed", error);
  } finally {
    signInButton.disabled = false;
  }
});
signOutButton.addEventListener("click", async function () {
  try {
    if (stopSnapshot) stopSnapshot();
    stopSnapshot = null;
    activeUser = null;
    await signOut(auth);
  } catch (error) {
    setStatus("로그아웃 오류: " + (error.code || error.message));
  }
});
onAuthStateChanged(auth, function (user) {
  if (!user) {
    if (stopSnapshot) stopSnapshot();
    stopSnapshot = null;
    activeUser = null;
    signInButton.hidden = false;
    signOutButton.hidden = true;
    setStatus("기기 저장 중 · Google 로그인하면 여러 기기에서 동기화됩니다.");
    return;
  }
  connectUser(user).catch(function (error) {
    setStatus("Firebase 연결 오류: " + (error.code || error.message));
    console.error("Firebase initialization failed", error);
  });
});