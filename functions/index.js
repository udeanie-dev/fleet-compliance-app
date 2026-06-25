const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();

// ─── Constants ────────────────────────────────────────────────────────────────

const REMINDER_EMAIL = "docs@transmodalgroup.co.za";
const ALLOWED_ROLES = ["Manager", "Controller", "Driver"];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getUserProfile(uid) {
  const snap = await db.collection("users").doc(uid).get();
  return snap.exists ? snap.data() : null;
}

async function requireManager(uid) {
  const profile = await getUserProfile(uid);

  if (!profile || profile.role !== "Manager") {
    throw new HttpsError("permission-denied", "Only managers can do this.");
  }

  return profile;
}

async function sendMail(to, subject, text, meta = {}) {
  const recipients = Array.isArray(to) ? to : [to];

  return db.collection("mail").add({
    to: recipients,
    message: { subject, text },
    created: admin.firestore.FieldValue.serverTimestamp(),
    ...meta,
  });
}

async function sendPushNotification(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) return null;

  const message = {
    notification: { title, body },
    data: data,
    tokens: tokens,
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`${response.successCount} messages were sent successfully`);
    return response;
  } catch (error) {
    console.error("Error sending push notifications:", error);
    return null;
  }
}

function getTodayDateOnly() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function getDiffDays(expiryDateText) {
  const today = getTodayDateOnly();
  const expiry = new Date(expiryDateText);
  expiry.setHours(0, 0, 0, 0);
  return Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
}

function getReminderInfo(diffDays, documentType, ownerName, expiryDate) {
  if (diffDays === 30) {
    return {
      key: "30-days",
      subject: `PermitSphere Reminder: ${documentType} expires in 30 days`,
      text: `${ownerName}'s ${documentType} expires in 30 days on ${expiryDate}.`,
    };
  }

  if (diffDays === 7) {
    return {
      key: "7-days",
      subject: `PermitSphere Reminder: ${documentType} expires in 7 days`,
      text: `${ownerName}'s ${documentType} expires in 7 days on ${expiryDate}.`,
    };
  }

  if (diffDays === 1) {
    return {
      key: "1-day",
      subject: `PermitSphere Reminder: ${documentType} expires tomorrow`,
      text: `${ownerName}'s ${documentType} expires tomorrow on ${expiryDate}.`,
    };
  }

  if (diffDays === 0) {
    return {
      key: "today",
      subject: `PermitSphere Alert: ${documentType} expires today`,
      text: `${ownerName}'s ${documentType} expires today (${expiryDate}).`,
    };
  }

  if (diffDays < 0) {
    const absDiff = Math.abs(diffDays);
    const today = new Date();
    const isMonday = today.getDay() === 1;

    // Daily for first 3 days, then every Monday
    if (absDiff <= 3 || isMonday) {
      const freq = absDiff <= 3 ? "CRITICAL" : "OVERDUE WEEKLY";
      return {
        key: `expired-${absDiff}-days`,
        subject: `${freq}: ${documentType} EXPIRED`,
        text: `${ownerName}'s ${documentType} expired on ${expiryDate}. It is now ${absDiff} day(s) overdue. Action required.`,
      };
    }
  }

  return null;
}

// ─── Callable Functions ───────────────────────────────────────────────────────

exports.createAppUser = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in.");
  }

  await requireManager(request.auth.uid);

  const { name, surname, email, password, role, capacity } = request.data;

  if (!name || !surname || !email || !password || !role) {
    throw new HttpsError("invalid-argument", "Missing required fields.");
  }

  if (!EMAIL_REGEX.test(email)) {
    throw new HttpsError("invalid-argument", "Invalid email format.");
  }

  if (password.length < 6) {
    throw new HttpsError("invalid-argument", "Password must be at least 6 characters.");
  }

  if (!ALLOWED_ROLES.includes(role)) {
    throw new HttpsError("invalid-argument", "Invalid user role.");
  }

  const fullName = `${name} ${surname}`.trim();
  const resolvedCapacity = capacity || role;

  // Create Auth user first, then do all Firestore writes in parallel
  const userRecord = await admin.auth().createUser({
    email,
    password,
    displayName: fullName,
  });

  const userDocRef = db.collection("users").doc(userRecord.uid);

  const writes = [
    userDocRef.set({
      name,
      surname,
      fullName,
      email,
      role,
      capacity: resolvedCapacity,
      active: true,
      createdBy: request.auth.uid,
      created: admin.firestore.FieldValue.serverTimestamp(),
    }),
    sendMail(
      email,
      "PermitSphere login created",
      `Hi ${fullName}, your PermitSphere login has been created.\n\nEmail: ${email}\nPassword: ${password}\nRole: ${role}\nCapacity: ${resolvedCapacity}`
    ),
  ];

  // Only add a drivers record if role is Driver and no duplicate exists
  if (role === "Driver") {
    const existingDriver = await db
      .collection("drivers")
      .where("name", "==", fullName)
      .get();

    if (existingDriver.empty) {
      writes.push(
        db.collection("drivers").add({
          name: fullName,
          email,
          userId: userRecord.uid,
          created: admin.firestore.FieldValue.serverTimestamp(),
        })
      );
    }
  }

  await Promise.all(writes);

  return {
    uid: userRecord.uid,
    fullName,
    email,
    role,
    capacity: resolvedCapacity,
  };
});

exports.setUserActive = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in.");
  }

  await requireManager(request.auth.uid);

  const { uid, active } = request.data;

  if (!uid || typeof active !== "boolean") {
    throw new HttpsError("invalid-argument", "Missing uid or active status.");
  }

  if (uid === request.auth.uid) {
    throw new HttpsError("failed-precondition", "You cannot disable your own account.");
  }

  await Promise.all([
    admin.auth().updateUser(uid, { disabled: !active }),
    db.collection("users").doc(uid).update({
      active,
      updated: admin.firestore.FieldValue.serverTimestamp(),
    }),
  ]);

  return { uid, active };
});

exports.deleteAppUser = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in.");
  }

  await requireManager(request.auth.uid);

  const { uid } = request.data;

  if (!uid) {
    throw new HttpsError("invalid-argument", "Missing uid.");
  }

  if (uid === request.auth.uid) {
    throw new HttpsError("failed-precondition", "You cannot delete your own account.");
  }

  await Promise.all([
    admin.auth().deleteUser(uid),
    db.collection("users").doc(uid).update({
      active: false,
      deleted: true,
      deletedAt: admin.firestore.FieldValue.serverTimestamp(),
    }),
  ]);

  return { uid, deleted: true };
});

// ─── Scheduled Functions ──────────────────────────────────────────────────────

exports.checkExpiryReminders = onSchedule(
  {
    schedule: "0 6 * * *",
    timeZone: "Africa/Johannesburg",
  },
  async () => {
    const snapshot = await db.collection("documents").get();
    const usersSnapshot = await db.collection("users").where("fcmToken", "!=", null).get();

    const staffUsers = [];
    const driverUsersMap = new Map(); // Name -> fcmToken

    usersSnapshot.forEach(doc => {
      const u = doc.data();
      if (u.fcmToken) {
        if (u.role === "Manager" || u.role === "Controller") {
          staffUsers.push(u.fcmToken);
        } else if (u.role === "Driver") {
          driverUsersMap.set(u.fullName, u.fcmToken);
        }
      }
    });

    // Filter to only docs that need a reminder
    const candidates = snapshot.docs
      .map((docSnap) => {
        const data = docSnap.data();

        if (!data.date || !data.email) return null;

        const documentType = data.documentType || "Document";
        const ownerName = data.ownerName || "Record";
        const ownerType = data.ownerType || "Other";
        const expiryDate = data.date;
        const diffDays = getDiffDays(expiryDate);
        const reminder = getReminderInfo(diffDays, documentType, ownerName, expiryDate);

        if (!reminder) return null;

        return { docSnap, data, documentType, ownerName, ownerType, expiryDate, diffDays, reminder };
      })
      .filter(Boolean);

    if (candidates.length === 0) return;

    // Fetch all sentReminders in parallel to avoid N+1 reads
    const sentSnaps = await Promise.all(
      candidates.map(({ docSnap, reminder }) =>
        db.collection("sentReminders").doc(`${docSnap.id}_${reminder.key}`).get()
      )
    );

    // Send mail and record sentReminders only for unsent ones
    const tasks = candidates
      .filter((_, i) => !sentSnaps[i].exists)
      .map(({ docSnap, data, documentType, ownerName, ownerType, expiryDate, diffDays, reminder }) => {
        const reminderId = `${docSnap.id}_${reminder.key}`;
        const recipients = [REMINDER_EMAIL, data.email];

        const targetTokens = [...staffUsers];
        if (ownerType === "Driver" && driverUsersMap.has(ownerName)) {
          const driverToken = driverUsersMap.get(ownerName);
          if (!targetTokens.includes(driverToken)) {
            targetTokens.push(driverToken);
          }
        }

        return Promise.all([
          sendMail(recipients, reminder.subject, reminder.text, {
            documentId: docSnap.id,
            reminderType: reminder.key,
          }),
          sendPushNotification(targetTokens, reminder.subject, reminder.text, {
            documentId: docSnap.id,
          }),
          db.collection("sentReminders").doc(reminderId).set({
            documentId: docSnap.id,
            ownerName,
            documentType,
            email: data.email,
            expiryDate,
            diffDays,
            reminderType: reminder.key,
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
          }),
        ]);
      });

    await Promise.all(tasks);
  }
);

// ─── Real-time Firestore Triggers ─────────────────────────────────────────────

async function notifyUsersOfDocChange(docId, data, isNew) {
  const { documentType, ownerName, ownerType, date } = data;
  const title = isNew ? `New Document: ${documentType}` : `Updated: ${documentType}`;
  const body = `Doc for ${ownerName} set to expire on ${date || "N/A"}.`;

  const usersSnapshot = await db.collection("users").where("fcmToken", "!=", null).get();
  const staffTokens = [];
  let driverToken = null;

  usersSnapshot.forEach(doc => {
    const u = doc.data();
    if (u.role === "Manager" || u.role === "Controller") staffTokens.push(u.fcmToken);
    if (u.role === "Driver" && u.fullName === ownerName) driverToken = u.fcmToken;
  });

  const targetTokens = [...staffTokens];
  if (driverToken && !targetTokens.includes(driverToken)) targetTokens.push(driverToken);

  if (targetTokens.length > 0) {
    await sendPushNotification(targetTokens, title, body, { documentId: docId });
  }
}

exports.onDocumentCreated = onDocumentCreated("documents/{docId}", async (event) => {
  await notifyUsersOfDocChange(event.params.docId, event.data.data(), true);
});

exports.onDocumentUpdated = onDocumentUpdated("documents/{docId}", async (event) => {
  await notifyUsersOfDocChange(event.params.docId, event.data.after.data(), false);
});

exports.onInspectionCreated = onDocumentCreated("inspections/{inspectId}", async (event) => {
  const data = event.data.data();
  if (data.status === "Failed") {
    const title = `🚨 INSPECTION FAILED: ${data.truck}`;
    const body = `Driver ${data.driver} reported safety failures in their daily check.`;

    const usersSnapshot = await db.collection("users").where("role", "in", ["Manager", "Controller"]).get();
    const tokens = [];
    usersSnapshot.forEach(doc => {
      const u = doc.data();
      if (u.fcmToken) tokens.push(u.fcmToken);
    });

    if (tokens.length > 0) {
      await sendPushNotification(tokens, title, body, { type: "inspection_fail", id: event.params.inspectId });
    }
  }
});

exports.onExpenseUpdated = onDocumentUpdated("expenses/{expenseId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();

  // Only notify if status changed
  if (before.status === after.status) return;

  const title = `Expense ${after.status}`;
  const body = `Your ${after.category} expense for ${after.truckNumber} has been ${after.status.toLowerCase()}.`;

  const driverProfile = await getUserProfile(after.driverId);
  if (driverProfile && driverProfile.fcmToken) {
    await sendPushNotification([driverProfile.fcmToken], title, body, {
      type: "expense_update",
      id: event.params.expenseId,
      status: after.status
    });
  }
});

exports.onExpenseCreated = onDocumentCreated("expenses/{expenseId}", async (event) => {
  const data = event.data.data();
  const title = `New Expense: ${data.truckNumber}`;
  const body = `${data.driverName} submitted a ${data.category} expense of ${data.currency} ${data.amount}.`;

  const usersSnapshot = await db.collection("users").where("role", "in", ["Manager", "Controller"]).get();
  const tokens = [];
  usersSnapshot.forEach(doc => {
    const u = doc.data();
    if (u.fcmToken) tokens.push(u.fcmToken);
  });

  if (tokens.length > 0) {
    await sendPushNotification(tokens, title, body, { type: "expense_new", id: event.params.expenseId });
  }
});
