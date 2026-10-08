const express = require('express');
const cors = require('cors');
require('dotenv').config();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/campus-ballot';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const configuredJwtSecret = String(process.env.JWT_SECRET || '').trim();
if (IS_PRODUCTION && !configuredJwtSecret) {
  throw new Error('JWT_SECRET must be configured in production.');
}
const JWT_SECRET = configuredJwtSecret || crypto.randomBytes(32).toString('hex');
const HOST_INVITE_CODE = String(process.env.HOST_INVITE_CODE || '').trim();
const ENABLE_DEMO_DATA = !IS_PRODUCTION && process.env.ENABLE_DEMO_DATA !== 'false';
const STUDENT_EMAIL_DOMAIN = String(process.env.STUDENT_EMAIL_DOMAIN || '').trim().toLowerCase().replace(/^@/, '');
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || '').trim();
const EMAIL_FROM = String(process.env.EMAIL_FROM || '').trim();
const REQUIRE_STUDENT_EMAIL_VERIFICATION = IS_PRODUCTION || process.env.REQUIRE_STUDENT_EMAIL_VERIFICATION === 'true';
if (IS_PRODUCTION && (!STUDENT_EMAIL_DOMAIN || !RESEND_API_KEY || !EMAIL_FROM)) {
  throw new Error('STUDENT_EMAIL_DOMAIN, RESEND_API_KEY, and EMAIL_FROM must be configured in production.');
}
if (IS_PRODUCTION && (!String(process.env.MONGODB_URI || '').trim() || !HOST_INVITE_CODE)) {
  throw new Error('MONGODB_URI and HOST_INVITE_CODE must be configured in production.');
}
const LEGACY_STORE_PATH = path.join(__dirname, 'data', 'store.json');

let db;
let mongoClient;

const seedData = {
  users: [
    { id: 1, email: 'host@campus.edu', password: 'Host@2026', role: 'host', name: 'Election host' },
    { id: 2, email: 'student@campus.edu', password: 'Student@2026', role: 'student', name: 'Student portal' }
  ],
  elections: [
    {
      id: 'election-2026',
      title: 'Student Council 2026',
      status: 'ongoing',
      description: 'President of the Student Council',
      closes: 'October 2 at 5:00 PM',
      candidates: [
        { id: 'c1', name: 'Aarav Mehta', group: 'Forward Together', initials: 'AM', votes: 168 },
        { id: 'c2', name: 'Maya Patel', group: 'Students First', initials: 'MP', votes: 129 },
        { id: 'c3', name: 'Noah Williams', group: 'Independent', initials: 'NW', votes: 89 }
      ],
      ballots: []
    },
    {
      id: 'election-2025',
      title: 'Student Council 2025',
      status: 'completed',
      description: 'President of the Student Council',
      closes: 'September 18 at 5:00 PM',
      winner: 'Aarav Mehta',
      candidates: [
        { id: 'c4', name: 'Aarav Mehta', group: 'Forward Together', initials: 'AM', votes: 410 },
        { id: 'c5', name: 'Maya Patel', group: 'Students First', initials: 'MP', votes: 334 },
        { id: 'c6', name: 'Noah Williams', group: 'Independent', initials: 'NW', votes: 201 }
      ],
      ballots: []
    }
  ],
  submissions: [],
  activity: [
    { icon: '✓', text: 'Voting is open for Student Council 2026.', time: 'Today · 9:00 AM' },
    { icon: '+', text: 'Candidate registration is available to party heads.', time: 'Today · 8:45 AM' },
    { icon: '↗', text: 'Election workspace prepared by the host.', time: 'Yesterday · 4:30 PM' }
  ]
};

async function connectMongo() {
  if (db) return db;

  mongoClient = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000
  });

  await mongoClient.connect();
  db = mongoClient.db();

  const usersCollection = db.collection('users');
  const electionsCollection = db.collection('elections');
  const submissionsCollection = db.collection('submissions');
  const activityCollection = db.collection('activity');
  const verificationCollection = db.collection('student_email_verifications');

  const userCount = await usersCollection.countDocuments();
  if (userCount === 0 && ENABLE_DEMO_DATA) {
    const users = await Promise.all(seedData.users.map(async (user) => ({
      ...user,
      password: await bcrypt.hash(user.password, 12)
    })));
    await usersCollection.insertMany(users);
  } else if (userCount > 0) {
    const users = await usersCollection.find({}).toArray();
    for (const user of users) {
      if (!String(user.password || '').startsWith('$2')) {
        await usersCollection.updateOne(
          { _id: user._id },
          { $set: { password: await bcrypt.hash(String(user.password || ''), 12) } }
        );
      }
    }
  }

  if (ENABLE_DEMO_DATA) {
    if ((await electionsCollection.countDocuments()) === 0) {
      await electionsCollection.insertMany(seedData.elections);
    }

    if (seedData.submissions.length > 0 && (await submissionsCollection.countDocuments()) === 0) {
      await submissionsCollection.insertMany(seedData.submissions);
    }

    if ((await activityCollection.countDocuments()) === 0) {
      await activityCollection.insertMany(seedData.activity);
    }

    await importLegacyStore(db);
    await electionsCollection.updateMany(
      { id: { $in: ['election-2026', 'election-2025'] }, hostId: { $exists: false } },
      { $set: { hostId: '1', hostEmail: 'host@campus.edu' } }
    );
  }
  await usersCollection.createIndex({ email: 1 }, { unique: true });
  await usersCollection.createIndex({ studentIdKey: 1 }, { unique: true, sparse: true });
  await verificationCollection.createIndex({ email: 1 }, { unique: true });
  await verificationCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  return db;
}

function formatTime() {
  return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function readLegacyStore() {
  try {
    return JSON.parse(fs.readFileSync(LEGACY_STORE_PATH, 'utf8'));
  } catch (error) {
    return null;
  }
}

async function isPristineSeedState(database) {
  const users = await database.collection('users').find({}).toArray();
  const submissionsCount = await database.collection('submissions').countDocuments();
  const activityCount = await database.collection('activity').countDocuments();
  const elections = await database.collection('elections').find({}).toArray();

  if (users.length !== seedData.users.length || submissionsCount !== 0 ||
      activityCount !== seedData.activity.length || elections.length !== seedData.elections.length) {
    return false;
  }

  if (!seedData.users.every((seedUser) => users.some((user) =>
    user.id === seedUser.id && user.email === seedUser.email && user.role === seedUser.role
  ))) {
    return false;
  }

  return seedData.elections.every((seedElection) => {
    const election = elections.find((item) => item.id === seedElection.id);
    if (!election || (election.ballots || []).length > 0 ||
        election.candidates.length !== seedElection.candidates.length) {
      return false;
    }

    return seedElection.candidates.every((candidate) => {
      const stored = election.candidates.find((item) => item.id === candidate.id);
      return stored && Number(stored.votes || 0) === Number(candidate.votes || 0);
    });
  });
}

async function importLegacyStore(database) {
  const metadata = database.collection('app_metadata');
  if (await metadata.findOne({ _id: 'legacy-json-store-v1' })) return;

  const legacyData = readLegacyStore();
  if (legacyData && Array.isArray(legacyData.elections) &&
      await isPristineSeedState(database)) {
    const electionsCollection = database.collection('elections');
    const legacyElections = legacyData.elections.map((election) => ({
      ...election,
      ballots: (election.ballots || []).map((ballot) => ({
        ...ballot,
        ...(String(ballot.studentId).toLowerCase() === 'student@campus.edu' ? { userId: '2' } : {})
      }))
    }));

    for (const election of legacyElections) {
      const existing = await electionsCollection.findOne({ id: election.id });
      if (existing) {
        await electionsCollection.updateOne({ _id: existing._id }, { $set: election });
      }
    }

    const submissionsCollection = database.collection('submissions');
    if (legacyData.submissions.length > 0) {
      await submissionsCollection.insertMany(legacyData.submissions);
    }

    const activityCollection = database.collection('activity');
    await activityCollection.deleteMany({});
    if (legacyData.activity.length > 0) {
      await activityCollection.insertMany(legacyData.activity);
    }
  }

  await metadata.insertOne({
    _id: 'legacy-json-store-v1',
    importedAt: new Date().toISOString()
  });
}

function sanitizeUser(user) {
  if (!user) return null;
  const { password, ...safeUser } = user;
  return safeUser;
}

function createAccessToken(user) {
  return jwt.sign({
    sub: String(user.id ?? user._id),
    role: user.role,
    email: user.email
  }, JWT_SECRET, { expiresIn: '8h' });
}

function requireAuth(req, res, next) {
  const authorization = req.get('authorization') || '';
  const [scheme, token] = authorization.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Session is invalid or expired.' });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.auth?.role !== role) {
      return res.status(403).json({ message: 'You do not have permission to perform this action.' });
    }
    return next();
  };
}

if (!IS_PRODUCTION) app.use(cors());
app.use(express.json());
app.get(['/', '/development.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'development.html'));
});

app.get('/api/health', async (req, res) => {
  try {
    const database = await connectMongo();
    const stats = await database.command({ ping: 1 });
    res.json({ ok: true, message: 'Campus Ballot API is running.', mongo: stats.ok === 1 });
  } catch (error) {
    res.status(500).json({ ok: false, message: 'MongoDB connection failed.', error: error.message });
  }
});

app.post('/api/auth/student-verification', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const emailDomain = email.split('@').pop();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ message: 'Enter a valid student email address.' });
  }
  if (!STUDENT_EMAIL_DOMAIN) {
    return res.status(503).json({ message: 'Student email verification is not configured.' });
  }
  if (emailDomain !== STUDENT_EMAIL_DOMAIN) {
    return res.status(400).json({ message: `Use an email address ending in @${STUDENT_EMAIL_DOMAIN}.` });
  }
  if (!RESEND_API_KEY || !EMAIL_FROM) {
    return res.status(503).json({ message: 'Email verification is not configured.' });
  }

  try {
    const database = await connectMongo();
    const verificationCollection = database.collection('student_email_verifications');
    const previous = await verificationCollection.findOne({ email });
    const now = new Date();
    if (previous?.sentAt && now.getTime() - new Date(previous.sentAt).getTime() < 60_000) {
      return res.status(429).json({ message: 'Wait one minute before requesting another code.' });
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const codeHash = crypto.createHmac('sha256', JWT_SECRET).update(`${email}:${code}`).digest('hex');
    await verificationCollection.replaceOne({ email }, {
      email,
      codeHash,
      attempts: 0,
      sentAt: now,
      expiresAt: new Date(now.getTime() + 10 * 60_000)
    }, { upsert: true });

    let mailResponse;
    try {
      mailResponse = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: EMAIL_FROM,
          to: [email],
          subject: 'Your Campus Ballot verification code',
          text: `Your Campus Ballot verification code is ${code}. It expires in 10 minutes.`
        })
      });
    } catch (error) {
      await verificationCollection.deleteOne({ email, codeHash });
      return res.status(502).json({ message: 'Unable to send the verification email.' });
    }

    if (!mailResponse.ok) {
      await verificationCollection.deleteOne({ email, codeHash });
      return res.status(502).json({ message: 'Unable to send the verification email.' });
    }
    return res.json({ message: 'Verification code sent. Check your school email.' });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to start email verification.' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const { name, email, studentId, password, verificationCode } = req.body || {};
  const normalizedName = String(name || '').trim();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedStudentId = String(studentId || '').trim();
  const normalizedCode = String(verificationCode || '').trim();
  const emailDomain = normalizedEmail.split('@').pop();

  if (!normalizedName || normalizedName.length > 60 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254 ||
      normalizedStudentId.length < 4 || normalizedStudentId.length > 24 ||
      typeof password !== 'string' || password.length < 8 || password.length > 72) {
    return res.status(400).json({
      message: 'Enter a name, valid email, student ID (4-24 characters), and password (8-72 characters).'
    });
  }
  if (STUDENT_EMAIL_DOMAIN && emailDomain !== STUDENT_EMAIL_DOMAIN) {
    return res.status(400).json({ message: `Use an email address ending in @${STUDENT_EMAIL_DOMAIN}.` });
  }
  if (REQUIRE_STUDENT_EMAIL_VERIFICATION && !/^\d{6}$/.test(normalizedCode)) {
    return res.status(400).json({ message: 'Enter the six-digit code sent to your school email.' });
  }

  try {
    const database = await connectMongo();
    const usersCollection = database.collection('users');
    const verificationCollection = database.collection('student_email_verifications');
    const studentIdKey = normalizedStudentId.toLowerCase();
    const existing = await usersCollection.findOne({
      $or: [{ email: normalizedEmail }, { studentIdKey }]
    });

    if (existing) {
      return res.status(409).json({ message: 'That email or student ID is already registered.' });
    }

    if (REQUIRE_STUDENT_EMAIL_VERIFICATION) {
      const verification = await verificationCollection.findOne({ email: normalizedEmail });
      if (!verification || verification.expiresAt <= new Date()) {
        return res.status(400).json({ message: 'Request a new verification code before creating your account.' });
      }
      if (verification.attempts >= 5) {
        return res.status(429).json({ message: 'Too many incorrect codes. Request a new one.' });
      }

      const expectedHash = crypto.createHmac('sha256', JWT_SECRET)
        .update(`${normalizedEmail}:${normalizedCode}`).digest('hex');
      const matches = crypto.timingSafeEqual(Buffer.from(expectedHash), Buffer.from(verification.codeHash));
      if (!matches) {
        await verificationCollection.updateOne({ _id: verification._id }, { $inc: { attempts: 1 } });
        return res.status(400).json({ message: 'That verification code is incorrect.' });
      }
    }

    const user = {
      id: `student-${require('crypto').randomUUID()}`,
      name: normalizedName,
      email: normalizedEmail,
      studentId: normalizedStudentId,
      studentIdKey,
      password: await bcrypt.hash(password, 12),
      role: 'student',
      createdAt: new Date().toISOString()
    };

    await usersCollection.insertOne(user);
    if (REQUIRE_STUDENT_EMAIL_VERIFICATION) {
      await verificationCollection.deleteOne({ email: normalizedEmail });
    }
    return res.status(201).json({
      message: 'Student account created.',
      user: sanitizeUser(user),
      accessToken: createAccessToken(user)
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: 'That email or student ID is already registered.' });
    }
    return res.status(500).json({ message: 'Unable to create student account.', error: error.message });
  }
});

app.post('/api/auth/register-host', async (req, res) => {
  const { name, email, password, inviteCode } = req.body || {};
  const normalizedName = String(name || '').trim();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const expectedCode = String(HOST_INVITE_CODE || '').trim();
  const providedCode = String(inviteCode || '').trim();

  if (!expectedCode || providedCode !== expectedCode) {
    return res.status(403).json({ message: 'A valid host access code is required.' });
  }

  if (!normalizedName || normalizedName.length > 60 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254 ||
      typeof password !== 'string' || password.length < 8 || password.length > 72) {
    return res.status(400).json({
      message: 'Enter a name, valid email, and password (8-72 characters).'
    });
  }

  try {
    const database = await connectMongo();
    const usersCollection = database.collection('users');
    if (await usersCollection.findOne({ email: normalizedEmail })) {
      return res.status(409).json({ message: 'That email is already registered.' });
    }

    const user = {
      id: `host-${crypto.randomUUID()}`,
      name: normalizedName,
      email: normalizedEmail,
      password: await bcrypt.hash(password, 12),
      role: 'host',
      createdAt: new Date().toISOString()
    };

    await usersCollection.insertOne(user);
    return res.status(201).json({
      message: 'Host account created.',
      user: sanitizeUser(user),
      accessToken: createAccessToken(user)
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: 'That email is already registered.' });
    }
    return res.status(500).json({ message: 'Unable to create host account.', error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();

  if (!normalizedEmail || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  try {
    const database = await connectMongo();
    const user = await database.collection('users').findOne({ email: normalizedEmail });

    if (!user || !await bcrypt.compare(String(password), user.password)) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    return res.json({
      message: 'Login successful',
      user: sanitizeUser(user),
      accessToken: createAccessToken(user)
    });
  } catch (error) {
    return res.status(500).json({ message: 'Database error while logging in.', error: error.message });
  }
});

app.get('/api/elections', async (req, res) => {
  try {
    const database = await connectMongo();
    const elections = await database.collection('elections').find({}).toArray();
    res.json(elections);
  } catch (error) {
    res.status(500).json({ message: 'Unable to fetch elections.', error: error.message });
  }
});

app.get('/api/elections/:id', async (req, res) => {
  try {
    const database = await connectMongo();
    const election = await database.collection('elections').findOne({ id: req.params.id });

    if (!election) {
      return res.status(404).json({ message: 'Election not found.' });
    }

    return res.json(election);
  } catch (error) {
    return res.status(500).json({ message: 'Unable to fetch election.', error: error.message });
  }
});

app.get('/api/admin/elections', requireAuth, requireRole('host'), async (req, res) => {
  try {
    const database = await connectMongo();
    const elections = await database.collection('elections')
      .find({ hostId: req.auth.sub })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(elections);
  } catch (error) {
    res.status(500).json({ message: 'Unable to fetch your elections.', error: error.message });
  }
});

app.post('/api/elections', requireAuth, requireRole('host'), async (req, res) => {
  const title = String(req.body?.title || '').trim();
  const description = String(req.body?.description || '').trim();
  const closes = String(req.body?.closes || '').trim();

  if (!title || title.length > 100 || !description || description.length > 300 ||
      !closes || closes.length > 100) {
    return res.status(400).json({ message: 'Enter an election title, description, and closing date.' });
  }

  try {
    const database = await connectMongo();
    const election = {
      id: `election-${crypto.randomUUID()}`,
      title,
      description,
      closes,
      status: 'ongoing',
      hostId: req.auth.sub,
      hostEmail: req.auth.email,
      candidates: [],
      ballots: [],
      createdAt: new Date().toISOString()
    };
    await database.collection('elections').insertOne(election);
    return res.status(201).json({ message: 'Election created.', election });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to create election.', error: error.message });
  }
});

app.patch('/api/elections/:id', requireAuth, requireRole('host'), async (req, res) => {
  const { title, description, closes, status } = req.body || {};
  const updates = {};

  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 100) {
      return res.status(400).json({ message: 'Election title must be 1-100 characters.' });
    }
    updates.title = title.trim();
  }

  if (description !== undefined) {
    if (typeof description !== 'string' || !description.trim() || description.trim().length > 300) {
      return res.status(400).json({ message: 'Election description must be 1-300 characters.' });
    }
    updates.description = description.trim();
  }

  if (closes !== undefined) {
    if (typeof closes !== 'string' || !closes.trim() || closes.trim().length > 100) {
      return res.status(400).json({ message: 'Enter a valid closing date.' });
    }
    updates.closes = closes.trim();
  }

  if (status !== undefined) {
    if (!['ongoing', 'completed'].includes(status)) {
      return res.status(400).json({ message: 'Election status must be ongoing or completed.' });
    }
    updates.status = status;
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ message: 'No election changes were provided.' });
  }

  try {
    const database = await connectMongo();
    const elections = database.collection('elections');
    const election = await elections.findOne({ id: req.params.id, hostId: req.auth.sub });
    if (!election) {
      return res.status(404).json({ message: 'Election not found in your host account.' });
    }

    if (updates.status === 'completed') {
      const winner = [...(election.candidates || [])].sort((first, second) =>
        Number(second.votes || 0) - Number(first.votes || 0)
      )[0];
      if (winner) updates.winner = winner.name;
    } else if (updates.status === 'ongoing') {
      updates.winner = null;
    }

    await elections.updateOne({ _id: election._id }, { $set: updates });
    return res.json({
      message: 'Election updated.',
      election: { ...election, ...updates }
    });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to update election.', error: error.message });
  }
});

app.post('/api/elections/:id/vote', requireAuth, requireRole('student'), async (req, res) => {
  const { studentId, candidateId } = req.body || {};

  if (!studentId || !candidateId) {
    return res.status(400).json({ message: 'Student ID and candidate are required.' });
  }

  try {
    const database = await connectMongo();
    const electionsCollection = database.collection('elections');
    const activityCollection = database.collection('activity');
    const user = await database.collection('users').findOne({ email: req.auth.email, role: 'student' });
    const election = await electionsCollection.findOne({ id: req.params.id });

    if (!user) {
      return res.status(401).json({ message: 'Student account is no longer available.' });
    }

    if (!election) {
      return res.status(404).json({ message: 'Election not found.' });
    }

    if (election.status !== 'ongoing') {
      return res.status(400).json({ message: 'This election is closed.' });
    }

    if (user.studentId && String(user.studentId).toLowerCase() !== String(studentId).trim().toLowerCase()) {
      return res.status(403).json({ message: 'Use the student ID registered to your account.' });
    }

    const voterStudentId = user.studentId || String(studentId).trim();

    const alreadyVoted = (election.ballots || []).some(
      (ballot) => ballot.userId === req.auth.sub ||
        String(ballot.studentId).toLowerCase() === String(voterStudentId).toLowerCase()
    );

    if (alreadyVoted) {
      return res.status(409).json({ message: 'This student has already voted in this election.' });
    }

    const candidate = (election.candidates || []).find((item) => item.id === candidateId);

    if (!candidate) {
      return res.status(404).json({ message: 'Candidate not found.' });
    }

    const updatedCandidates = election.candidates.map((item) => {
      if (item.id !== candidateId) return item;
      return { ...item, votes: Number(item.votes || 0) + 1 };
    });

    const updatedBallots = [
      ...(election.ballots || []),
      {
        studentId: voterStudentId,
        userId: req.auth.sub,
        candidateId,
        votedAt: new Date().toISOString()
      }
    ];

    const updatedElection = {
      ...election,
      candidates: updatedCandidates,
      ballots: updatedBallots
    };

    await electionsCollection.updateOne({ _id: election._id }, { $set: { candidates: updatedCandidates, ballots: updatedBallots } });
    await activityCollection.insertOne({
      icon: '✓',
      text: `A ballot was submitted for ${election.title}.`,
      time: `Today · ${formatTime()}`
    });

    return res.json({
      message: 'Vote recorded successfully.',
      election: updatedElection
    });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to record vote.', error: error.message });
  }
});

app.post('/api/candidates/apply', requireAuth, requireRole('student'), async (req, res) => {
  const { name, studentId, group, manifesto, electionId } = req.body || {};

  if (!name || !studentId || !group || !manifesto) {
    return res.status(400).json({ message: 'All candidate fields are required.' });
  }

  try {
    const database = await connectMongo();
    const submissionsCollection = database.collection('submissions');
    const activityCollection = database.collection('activity');
    const user = await database.collection('users').findOne({ email: req.auth.email, role: 'student' });
    const election = await database.collection('elections').findOne({
      id: electionId || 'election-2026',
      status: 'ongoing'
    });

    if (!user) {
      return res.status(401).json({ message: 'Student account is no longer available.' });
    }

    if (!election) {
      return res.status(404).json({ message: 'Choose an election that is open for candidacy.' });
    }

    if (user.studentId && String(user.studentId).toLowerCase() !== String(studentId).trim().toLowerCase()) {
      return res.status(403).json({ message: 'Use the student ID registered to your account.' });
    }

    const duplicate = await submissionsCollection.findOne({
      $or: [
        { userId: String(user.id ?? user._id) },
        { studentId: { $regex: new RegExp(`^${String(studentId).trim()}$`, 'i') } }
      ],
      electionId: election.id
    });

    if (duplicate) {
      return res.status(409).json({ message: 'A candidacy submission already exists for this student ID.' });
    }

    const submission = {
      id: `s-${Date.now()}`,
      name: String(name).trim(),
      studentId: String(studentId).trim(),
      userId: String(user.id ?? user._id),
      electionId: election.id,
      group: String(group).trim(),
      initials: String(name).trim().split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase(),
      manifesto: String(manifesto).trim(),
      status: 'Pending',
      createdAt: new Date().toISOString()
    };

    await submissionsCollection.insertOne(submission);
    await activityCollection.insertOne({
      icon: '+',
      text: `${submission.name} submitted a candidate registration.`,
      time: `Today · ${formatTime()}`
    });

    return res.status(201).json({
      message: 'Submission sent for review.',
      submission
    });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to submit candidacy application.', error: error.message });
  }
});

app.get('/api/admin/submissions', requireAuth, requireRole('host'), async (req, res) => {
  try {
    const database = await connectMongo();
    const ownedElections = await database.collection('elections').find({ hostId: req.auth.sub }).toArray();
    const electionIds = ownedElections.map((election) => election.id);
    const legacyElectionOwned = electionIds.includes('election-2026');
    const filters = [{ electionId: { $in: electionIds } }];
    if (legacyElectionOwned) filters.push({ electionId: { $exists: false } });
    const submissions = await database.collection('submissions')
      .find(electionIds.length ? { $or: filters } : { _id: { $exists: false } })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(submissions);
  } catch (error) {
    res.status(500).json({ message: 'Unable to fetch submissions.', error: error.message });
  }
});

app.post('/api/admin/submissions/:id/approve', requireAuth, requireRole('host'), async (req, res) => {
  try {
    const database = await connectMongo();
    const submissionsCollection = database.collection('submissions');
    const electionsCollection = database.collection('elections');
    const activityCollection = database.collection('activity');

    const submission = await submissionsCollection.findOne({ id: req.params.id });

    if (!submission) {
      return res.status(404).json({ message: 'Submission not found.' });
    }

    if (submission.status === 'Approved') {
      return res.status(400).json({ message: 'Submission already approved.' });
    }

    const electionId = submission.electionId || 'election-2026';
    const election = await electionsCollection.findOne({ id: electionId, hostId: req.auth.sub, status: 'ongoing' });

    if (!election) {
      return res.status(404).json({ message: 'This submission is not for an election you can manage.' });
    }

    const nextCandidates = [
      ...(election.candidates || []),
      {
        id: `c-${Date.now()}`,
        name: submission.name,
        group: submission.group,
        initials: submission.initials,
        votes: 0
      }
    ];

    await electionsCollection.updateOne({ _id: election._id }, { $set: { candidates: nextCandidates } });

    const updatedSubmission = { ...submission, status: 'Approved' };
    await submissionsCollection.updateOne({ _id: submission._id }, { $set: { status: 'Approved' } });
    await activityCollection.insertOne({
      icon: '✓',
      text: `${submission.name} was approved as a candidate.`,
      time: `Today · ${formatTime()}`
    });

    return res.json({ message: 'Candidate approved.', submission: updatedSubmission, election });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to approve submission.', error: error.message });
  }
});

app.use((req, res) => {
  res.status(404).json({ message: 'Route not found.' });
});

connectMongo()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Campus Ballot API listening on port ${PORT}`);
      if (!configuredJwtSecret) {
        console.warn('JWT_SECRET is not configured; sessions will be invalidated each time the server restarts.');
      }
    });
  })
  .catch((error) => {
    console.error('MongoDB connection failed:', error.message);
    process.exit(1);
  });
