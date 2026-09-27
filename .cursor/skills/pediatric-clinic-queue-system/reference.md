# Reference — Schema, API, Config

Read when modifying Firebase data, server routes, or environment setup.

## RTDB Nodes

### `users/{uid}`
```js
{
  uid, name, email, phone,
  isPhoneVerified: true,      // parents; set after SMS OTP during registration
  role: "parent" | "secretary" | "doctor" | "admin", // admin = legacy/transition only; do not assign in UI
  status: "active" | "inactive",
  deactivationSource: "self" | "admin" | null, // "admin" = administrative (doctor-performed)
  isDeleted: false,               // parent soft-delete tombstone; Auth is revoked
  deletedAt,                      // epoch ms when soft-deleted
  onboardingComplete: true,       // parents; false until first child profile during onboarding
  createdAt, updatedAt,           // epoch ms
  assignedBranch: "Angeles",       // secretaries only
  children/{childId}: {            // parent-saved child profiles
    childName, age, sex, createdAt
  },
  pushSubscriptions/{hash}: { endpoint, keys: { p256dh, auth } },
  notificationPermission: "default" | "granted" | "denied",
  inAppNotificationsEnabled: true,  // parents; toasts while app is open (default true)
  devicePushEnabled: true,          // parents; OS/web push; set after OS grant
  pushTokens/{key}: { token }      // legacy FCM cleanup path
}
```

### `passwordResetLimits/{emailKey}`
Server-only daily cap for Forgot Password + Admin Reset Password. Email key is lowercase with `. # $ [ ]` replaced by `_`. Counter resets on a new **Asia/Manila** calendar date.
```js
{
  email,                 // normalized lowercase
  date: "YYYY-MM-DD",    // Asia/Manila
  count: 1,              // 1–5; 5th claim is last allowed that day
  updatedAt              // epoch ms
}
```
Daily limit: **5** requests per email. Client R/W denied in rules.

### `branchConfigurations/{branchId}`
```js
{
  name: "Angeles",
  clinicAddress: "...",
  schedule: {
    monday: { isOpen, openingTime, closingTime },
    // ... all 7 days
  }
}
```
Default branches: **Angeles**, **Magalang**.

### `schedules/{scheduleId}`
```js
{
  branch, clinicDate,              // "YYYY-MM-DD"
  openingTime, closingTime,
  slotCapacity,                    // lateLimit on old schedules is ignored

  status: "draft" | "published" | "completed",
  dayClosed, closureId, closureReason, closureNote,
  booking: { activeSlotCount, nextQueueNumber },
  queueStatus: "not_started" | "active" | "paused" | "closed" | "completed",
  queueStartedAt, publishedAt, completedAt,
  isReady, doctorId
}
```

### `clinicClosures/{closureId}`
```js
{
  branch, branchId,
  startDate, endDate,              // inclusive YYYY-MM-DD, Asia/Manila
  reason: "emergency" | "vacation" | "holiday" | "other",
  note, createdBy, createdAt
}
```

### `bookingLocks/{parentId}/{clinicDate}`
Server-only lock so one parent cannot hold two active reservations on the same clinic date. Client writes are denied.

### `reservations/{reservationId}`
```js
{
  scheduleId, parentId,
  reservationCode,                 // 6-char alphanumeric
  queueNumber, originalQueueNumber, queuePosition,
  queueOrder, aheadOfYou, queueState, sortTimestamp,
  nearTurnSmsSent,                 // true after Near Turn SMS claimed for this ticket; unset on new reservations
  slotReservedSmsSent,             // true after Confirmed Reservation SMS claimed
  penaltySmsSent: { [count]: true }, // late/moved SMS claimed per penaltyCount
  status: "reserved" | "waiting" | "checked_in" | "with_doctor" |
          "in_consultation" | "consultation_completed" | "cancelled" |
          "cancelled_by_clinic" | "forfeited" | "expired" | ...,
  childName, age, sex, concern,    // legacy mirrors (first selected child + shared concern)
  children: [                      // 1+ patients on this reservation (1 slot)
    { childId, childName, age, sex }
  ],
  source,                          // "walk_in" for secretary-created tickets
  createdBy,                       // secretary uid for walk-ins
  parentName, parentPhone,         // optional walk-in contact (E.164 phone); omitted if blank
  doctorNotes,
  checkedIn, createdAt, reservationCreatedAt,
  penaltyCount, lastPenalizedAt,
  becameCurrentTurnAt,             // ms; first penalize-eligible waiting ticket while queue is live
  penaltyTimerStartedAt, penaltyTimerExpiresAt, penaltyTimerClearedAt,
}
```

### `notifications/{parentId}/{notificationId}`
```js
{ title, body, type, severity, createdAt, read, reservationId?, branchId?, dedupeKey? }
```

### `auditLogs/{logId}`
```js
{ action, category, description, actorId, actorRole, timestamp, targetType, targetId, branchId }
```

### `systemConfiguration/{branchId}`
```js
{
  penaltyMoveBack: 2,              // 0–10; 0 = immediate forfeit on penalty
  defaultSlotCapacity: 30,         // fallback when a day is posted from the calendar
  penaltyGraceMinutes: 2,          // 0–5; wait after becoming current-turn before Penalize
  penaltyTimerMinutes: 15,         // 5–30; check-in deadline after first penalty
  sms: {
    nearingTurnAheadCount: 3,      // 1–10; at queue start, 0 < aheadOfYou <= this count fires NEARING_TURN SMS (once per reservation)
    templateSlotReserved: "...",   // placeholders: {date} {timeRange} {queueNumber} {doctor} {branch}
    templateSlotReservedActiveQueue: "...", // live queue booking: {queueNumber} {queuePosition}
    templateQueueStarted: "...",   // placeholders: {branch} {date}
    templateNearingTurn: "...",    // placeholders: {count} {queueNumber} {branch}
    templatePenalized: "...",      // placeholders: {queueNumber} {queuePosition} {branch} {minutes}
    templateForfeited: "...",      // placeholders: {queueNumber} {branch} {date}
    updatedAt: 0
  },
  updatedAt: 0
}
```
Each branch (Angeles, Magalang, …) has an independent node keyed by `branchConfigurations` push id. Secretary writes only `assignedBranchId`. TextBee API key stays in env (global). Legacy `systemConfiguration/queue` and `systemConfiguration/sms` are read-only seed sources.

## RTDB Security Rules Summary

| Node | Read | Write |
|------|------|-------|
| `users` | Admin all; user own | Own profile (active status) |
| `notifications` | Parent own | Parent own |
| `branchConfigurations` | All auth | Admin |
| `schedules` | All auth | Secretary or doctor (create/publish/start and queue control; active) |
| `reservations` | All auth | Parent, doctor, secretary (active) |
| `auditLogs` | Admin | Admin, doctor, secretary |
| `systemConfiguration/{branchId}` | Admin, doctor, parent; secretary own branch | Admin; secretary own branch |
| `systemConfiguration/{branchId}/sms` | + parents | (same write as parent node) |
| `smsOtps`, `phoneVerifications`, `passwordResetLimits` | denied | denied (Admin SDK only) |

Rules file: `database.rules.json` (repo root). The same file is copied to `client/database.rules.json` because `client/firebase.json` deploys that copy.

## Demo database

Demo accounts carry the Auth custom claim `isDemo: true`. The client (`getDb()` in `client/src/firebase/database.js`) and Cloud Functions (`client/functions/rtdbRouter.js`) send those accounts to a second Realtime Database, `{projectId}-demo`, with the same node names. Production rules reject `auth.token.isDemo == true`. Demo rules (`database.demo.rules.json`) reject everyone else. The demo doctor also has `demoOperator: true` and can call `resetDemoClinicDay` to clear one clinic date inside the demo database only.

Seed (does not write the default database):

```bash
cd client/functions
DEMO_ACCOUNT_PASSWORD=... DEMO_RTDB_URL=... node scripts/seedDemo.js
```

Create the `{projectId}-demo` database in the Firebase console before deploying rules or the demo triggers.


## Express API (`server/`, port 5000)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/` | None | Health check |
| GET | `/api/health` | None | Health check |
| GET | `/api/vapid-public-key` | None | VAPID public key |
| POST | `/api/save-subscription` | Bearer Firebase ID token | Save Web Push subscription |
| POST | `/api/delete-subscription` | Bearer token | Remove subscription |
| POST | `/api/send-notification` | Bearer token or `x-push-secret` | Dispatch notification + push |
| POST | `/api/admin/delete-user` | Bearer admin ID token | Delete Auth user + RTDB profile |
| POST | `/api/auth/resolve-identifier` | None | Resolve email or phone → account email for password login |
| POST | `/api/auth/password-reset/claim` | None | Consume 1 of 5 daily reset slots per email (Asia/Manila) before `sendPasswordResetEmail` |
| POST | `/api/auth/sms/send-otp` | None | Generate + SMS-deliver 6-digit OTP (textbee) |
| POST | `/api/auth/sms/verify-otp` | None | Validate OTP → custom token (login) or verificationId (register) |

Listeners: `server/services/pushListeners.js` watches `reservations` and `schedules`.

### SMS (textbee.dev)
- Utility: `server/services/smsService.js` (mirrored in `client/functions/smsService.js`)
- Queue SMS events: `SLOT_RESERVED` (on Save Information / `patientInfoCompleted`; once via `slotReservedSmsSent`), `QUEUE_STARTED`, `NEARING_TURN` (at **queue start only**; patients-ahead from `systemConfiguration/{branchId}/sms`, default 3; fires when `0 < aheadOfYou <=` count; SMS once per reservation via `reservations/{id}/nearTurnSmsSent` transaction + `dedupeKey` / `smsDispatchedAt`; Secretary-editable per branch), `PENALIZED` (once per increment via `penaltySmsSent/{count}`), `FORFEITED`. TextBee credentials remain env-global.
- OTP store: `smsOtps/{phoneKey}` — bcrypt-hashed code, 5-minute `expiresAt`; client R/W denied in rules
- Password reset cap: `passwordResetLimits/{emailKey}` — 5 claims per email per Asia/Manila day; client R/W denied; Forgot Password and Admin Reset share the same counter

## Cloud Functions (`client/functions/index.js`)

| Function | Trigger | Purpose |
|----------|---------|---------|
| `onReservationWrite` | RTDB `/reservations/{id}` onWrite | Push on reservation changes |
| `onScheduleWrite` | RTDB `/schedules/{id}` onWrite | Push on schedule/queue changes |
| `deleteUserAccount` | HTTPS callable | Admin deletes Auth user + profile |
| `testRTDBAccess` | HTTPS callable | Infrastructure test |
| `testFCMDelivery` | HTTPS callable | Push infrastructure test |

## Environment Variables

### `client/.env`
```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_DATABASE_URL=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
VITE_FIREBASE_VAPID_KEY=
VITE_VAPID_PUBLIC_KEY=
VITE_API_URL=          # Production Express URL; empty = same-origin /api
```

### `server/.env`
```
PORT=5000
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:noreply@...
FIREBASE_PROJECT_ID=pediatric-clinic-queue-testing
FIREBASE_DATABASE_URL=https://...firebasedatabase.app
TEXTBEE_API_KEY=
# TEXTBEE_DEVICE_ID=
# GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json
# FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}
# PUSH_DISPATCH_SECRET=
```

## Naming Conventions

| Area | Convention |
|------|------------|
| Components/pages | PascalCase (`Dashboard.jsx`) |
| Services/utils/hooks | camelCase (`queueEngine.js`) |
| Status strings | snake_case (`checked_in`, `not_started`) |
| Roles | lowercase (`parent`, `secretary`, `doctor`, `admin`) |
| Event constants | SCREAMING_SNAKE (`NOTIFICATION_EVENTS`, `QUEUE_STATES`) |
| Firebase nodes | camelCase (`branchConfigurations`, `auditLogs`) |
| CSS | Tailwind utilities inline |

## Key Service Files

| Service | Purpose |
|---------|---------|
| `queueEngine.js` | Queue order, recalculation, state |
| `reservationService.js` | Reservation lifecycle |
| `scheduleService.js` | Schedule CRUD, publish, queue start/pause |
| `branchConfigurationService.js` | Branch config, defaults |
| `notificationService.js` | Toast events, client notifications |
| `notificationCenterService.js` | Persistent notification center |
| `adminService.js` | Staff accounts, branch management |
| `auditLogService.js` | Audit trail |
| `pushService.js` | Web Push subscription API calls |
| `positionEventEngine.js` | ALMOST_NEXT / YOU_ARE_NEXT events |

## Queue Management Critical Path

1. Secretary creates schedule (draft) → publishes (assigned branch only)
2. Parent reserves → `createReservation()` → `queueNumber` assigned → `recalculateEntireQueue`
3. Secretary starts queue → `queueStatus: active`
4. Secretary scans QR / enters code → `checkInReservation()` → `checked_in`
5. Secretary sends to doctor → `sendToDoctor()` → `with_doctor` (blocked if consultation active)
6. Doctor completes → `completeConsultation()` → releases slot, unlocks queue
7. Penalties → `penalizeReservation()` shifts `sortTimestamp`, starts/keeps first penalty timer; expiry or move-back 0 forfeits
