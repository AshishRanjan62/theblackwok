// Netlify Function: naya order / staff call aane par staff phones ko push notification bhejta hai
const admin = require("firebase-admin");

function init() {
  if (admin.apps.length) return;
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || "").trim();
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT khali hai (is deploy me nahi mili)");
  const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(json)) });
}
const db = () => admin.firestore();

const reply = (code, obj) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    // Browser se kholne par env ka status dikhta hai (key ka text nahi, sirf length)
    const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || "").trim();
    return reply(405, { error: "POST only", env: { set: !!raw, length: raw.length, startsWithBrace: raw.startsWith("{") } });
  }
  try {
    init();
  } catch (e) {
    return reply(500, { error: "init failed", reason: e.message });
  }

  let type, id;
  try {
    ({ type, id } = JSON.parse(event.body || "{}"));
  } catch (e) {
    return reply(400, { error: "bad json" });
  }
  const col = type === "order" ? "orders" : type === "call" ? "staffCalls" : null;
  if (!col || typeof id !== "string" || !id || id.includes("/")) {
    return reply(400, { error: "bad request" });
  }

  const ref = db().collection(col).doc(id);

  // Verify: document sach me exist kare, abhi (10 min ke andar) bana ho, aur pehle notify na hua ho
  let d = null;
  try {
    d = await db().runTransaction(async (t) => {
      const s = await t.get(ref);
      if (!s.exists) return null;
      const x = s.data();
      if (x.pushSent) return null;
      const c = x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : 0;
      if (!c || Date.now() - c > 10 * 60 * 1000) return null;
      t.update(ref, { pushSent: true });
      return x;
    });
  } catch (e) {
    return reply(500, { error: "verify failed" });
  }
  if (!d) return reply(200, { skipped: true });

  const tbl = String(d.table || "");
  const where = tbl.toLowerCase().includes("collect") ? tbl : "Table " + tbl;
  let title, body;
  if (type === "order") {
    title = "New order 🛎️";
    body = (d.orderNo || id) + " · " + where + " · ₹" + (d.total || 0);
  } else {
    const reason = Array.isArray(d.reason) ? d.reason.join(", ") : String(d.reason || "");
    title = "Staff call 🔔";
    body = where + (reason ? ": " + reason : "");
  }

  // Tap par: order -> seedha wo order, staff call -> app ka Staff tab (path khali)
  const path = type === "order" ? "orders/" + id : "";

  try {
    // Data-only message: app ka PushService full-volume alarm bajata hai
    await admin.messaging().send({
      topic: "staff",
      data: { type, id, title, body, path },
      android: { priority: "high", ttl: 120000 },
    });
    return reply(200, { sent: true });
  } catch (e) {
    await ref.update({ pushSent: false }).catch(() => {});   // retry ho sake
    return reply(500, { error: "send failed" });
  }
};
