# Campus Ballot

Express API and static frontend for the Campus Ballot election portal. MongoDB stores users, elections, ballots, candidate submissions, and activity.

## Features

- Student and host login API
- Election list and detail API
- Vote submission API
- Candidate submission API
- Admin review API for submissions
- MongoDB persistence with a guarded one-time import from `data/store.json`
- Bcrypt password hashes and expiring JWT sessions
- Student and host role checks for protected API actions

## Run locally

```bash
npm install
npm start
```

The default database URI is `mongodb://127.0.0.1:27017/campus-ballot`. Copy `.env.example` to `.env`, then set `MONGODB_URI`, a long random `JWT_SECRET`, and a private `HOST_INVITE_CODE`. Give that invite code only to authorized faculty or club leaders. Without it, host self-registration is disabled.

The first startup imports `data/store.json` only if the MongoDB collections still match the untouched starter data. Existing custom MongoDB data is left alone. Open the frontend at:

- http://localhost:5000/development.html
- http://localhost:5000/api/health

## Deploy online (Render + MongoDB Atlas)

1. Create an Atlas cluster and database user, then copy its connection string.
2. Push this project to a GitHub repository and create a Render web service from the repository using `render.yaml`.
3. Verify a sending domain with Resend. In Render, set `MONGODB_URI`, `HOST_INVITE_CODE`, `RESEND_API_KEY`, and `EMAIL_FROM`. Render generates `JWT_SECRET`; the blueprint restricts student addresses to `mvsrec.edu.in` and requires email verification.
4. Use a fresh Atlas database for production. Production mode does not seed demo users or elections and does not import `data/store.json`.
5. Wait for Render's `/api/health` check to pass, then open the service URL.

The frontend and API use the same origin after deployment. The production server serves only the app page, requires a configured JWT secret, and fails closed when host registration has no access code configured. The Resend sender address must belong to a domain verified by your Resend account. Never commit `.env` or paste service credentials into chat.

Student IDs and email addresses are unique in the database. Production signup also sends a one-time code to the accepted email domain, which verifies mailbox control but does not independently prove enrollment; a student roster or official identity provider is needed for that. The project does not attempt physical-device identification.

## Demo accounts

- Host: `host@campus.edu` / `Host@2026`
- Student: `student@campus.edu` / `Student@2026`

To use your own email, choose **Create a student account** on the sign-in screen and enter your name, email, student ID, and a password of at least 8 characters. The account is saved in MongoDB and can be used for future sign-ins. Each student ID can be registered once, and votes are tied to that account. Email ownership and student identity are not independently verified in this prototype.

College staff choose **College staff? Create a host account** and register with their email and the private college invitation code. A host can create elections and manage only elections assigned to that host account. Host registration is not open without the invitation code.

The registration API is `POST /api/auth/register` with JSON fields `name`, `email`, `studentId`, and `password`. It returns the same bearer token as login.

## API examples

### Login

```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"student@campus.edu","password":"Student@2026"}'
```

### Get elections

```bash
curl http://localhost:5000/api/elections
```

Login returns an `accessToken`. Include it as a bearer token for protected routes. Host-only routes require a host account; voting and candidacy submissions require a student account.

### Vote in an election

```bash
curl -X POST http://localhost:5000/api/elections/election-2026/vote \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"studentId":"2026001","candidateId":"c1"}'
```

## Demo limitations

Demo accounts are seeded for local testing. The application does not independently verify student identity and is not suitable for official elections without production identity verification, audited ballot handling, and an independent security review. Set a stable, private `JWT_SECRET` before using sessions beyond local development.
