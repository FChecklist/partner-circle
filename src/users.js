// Users, hierarchy, e-mail verification, KYC.
// Hierarchy (top to bottom): manager > leader > exec > partner. "refer" users (Refer and Earn) sit outside it.

import { HttpError, newId, randSlug, randHex, needStr, mask, encryptField, decryptField } from './util.js';
import { atomic, auditStmts } from './chain.js';
import { createKey } from './auth.js';

export const RANK = { manager: 4, leader: 3, exec: 2, partner: 1, refer: 0 };
const ALLOWED_PARENT = {
  manager: [null],
  leader: ['manager', null],
  exec: ['leader', 'manager', null],
  partner: ['exec', 'leader', 'manager', null],
  refer: [null],
};
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const UPI_RE = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z]{2,32}$/;
const IFSC_SWIFT_RE = /^([A-Z]{4}0[A-Z0-9]{6}|[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?)$/;

export const publicUser = (u) =>
  u && {
    id: u.id, role: u.role, name: u.name, handle: u.handle, status: u.status, country: u.country, parent_id: u.parent_id,
    email_masked: u.email ? u.email.replace(/^(.).*(@.*)$/, '$1***$2') : null,
    phone_masked: mask(u.phone, 3),
    email_verified: !!u.email_verified,
    created_at: u.created_at,
  };

function checkEmail(email, required) {
  if (email == null || email === '') {
    if (required) throw new HttpError(422, 'invalid_field', 'e-mail is required for this role');
    return null;
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) throw new HttpError(422, 'invalid_field', 'e-mail looks invalid');
  return email.trim();
}

function checkPhone(phone, required) {
  if (phone == null || phone === '') {
    if (required) throw new HttpError(422, 'invalid_field', 'mobile number is required for this role');
    return null;
  }
  const digits = String(phone).replace(/[^\d+]/g, '');
  if (digits.replace(/\D/g, '').length < 8 || digits.length > 16) throw new HttpError(422, 'invalid_field', 'mobile number looks invalid');
  return digits;
}

async function uniqueHandle(ctx) {
  for (let i = 0; i < 6; i++) {
    const h = randSlug(8);
    if (!(await ctx.db.first('SELECT 1 AS x FROM users WHERE handle=?', [h]))) return h;
  }
  throw new HttpError(500, 'handle_exhausted', 'could not allocate a handle');
}

async function validateParent(ctx, role, parentId) {
  let parent = null;
  if (parentId) {
    parent = await ctx.db.first('SELECT * FROM users WHERE id=?', [parentId]);
    if (!parent) throw new HttpError(422, 'invalid_parent', 'sponsor not found');
    if (parent.status === 'suspended') throw new HttpError(422, 'invalid_parent', 'sponsor is suspended');
  }
  if (!ALLOWED_PARENT[role].includes(parent ? parent.role : null)) {
    throw new HttpError(422, 'invalid_parent', `a ${role} cannot report to ${parent ? 'a ' + parent.role : 'no one'}`);
  }
  return parent;
}

/**
 * Create a user. Used by public registration (role refer|partner) and by admins (any role).
 * Partners and sales staff start 'pending' until the owner approves; Refer and Earn users start active
 * (no e-mail is needed just to share a link).
 */
export async function createUser(ctx, { role, name, email, phone, country = 'IN', parent_id = null, sponsor = null, status }) {
  if (!(role in RANK)) throw new HttpError(422, 'invalid_field', 'role');
  name = needStr(name, 'name', 120);
  const cc = String(country).toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) throw new HttpError(422, 'invalid_field', 'country must be a 2-letter code');
  const needContact = role !== 'refer';
  email = checkEmail(email, needContact);
  phone = checkPhone(phone, needContact);
  if (sponsor && !parent_id) {
    const s = await ctx.db.first("SELECT id FROM users WHERE handle=? AND status='active'", [String(sponsor)]);
    if (!s) throw new HttpError(422, 'invalid_parent', 'sponsor code not found');
    parent_id = s.id;
  }
  await validateParent(ctx, role, parent_id);
  const emailHash = email ? await ctx.pepper(email) : null;
  if (emailHash && (await ctx.db.first('SELECT 1 AS x FROM users WHERE email_hash=?', [emailHash]))) {
    throw new HttpError(409, 'email_taken', 'this e-mail is already registered');
  }
  const id = newId('u');
  const handle = await uniqueHandle(ctx);
  const st = status || (role === 'refer' ? 'active' : 'pending');
  try {
    await atomic(ctx, async () => [
      {
        sql: 'INSERT INTO users (id,role,name,handle,email,email_hash,phone,country,parent_id,email_verified,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,0,?,?)',
        params: [id, role, name, handle, email, emailHash, phone, cc, parent_id, st, ctx.now()],
      },
      ...(await auditStmts(ctx, [{ action: 'user.create', target: `user:${id}`, meta: { role, status: st, parent_id } }])),
    ]);
  } catch (e) {
    if (/UNIQUE constraint failed: users\.(email_hash|handle)/.test(String(e.message))) throw new HttpError(409, 'email_taken', 'this e-mail is already registered');
    throw e;
  }
  return ctx.db.first('SELECT * FROM users WHERE id=?', [id]);
}

/** Public sign-up: returns the user and their login key (shown once). */
export async function register(ctx, body) {
  if (!['refer', 'partner'].includes(body?.role)) throw new HttpError(422, 'invalid_field', 'role must be "refer" or "partner"');
  const user = await createUser(ctx, { ...body, parent_id: null });
  const key = await createKey(ctx, { kind: 'user', user_id: user.id, label: 'self-service login', created_by: user.id });
  return { user: publicUser(user), api_key: key.token, note: 'Save this key now: it is shown once and is your login.' };
}

export async function setStatus(ctx, userId, status, why) {
  const u = await ctx.db.first('SELECT * FROM users WHERE id=?', [userId]);
  if (!u) throw new HttpError(404, 'not_found', 'user not found');
  if (u.status === status) return u;
  await atomic(ctx, async () => [
    { sql: 'UPDATE users SET status=? WHERE id=?', params: [status, userId] },
    ...(await auditStmts(ctx, [{ action: `user.${status}`, target: `user:${userId}`, meta: { from: u.status, why: why || null } }])),
  ]);
  return { ...u, status };
}

// ---- e-mail verification --------------------------------------------------------------------------------------

export async function sendEmailCode(ctx, user, rateLimit) {
  if (!user.email) throw new HttpError(422, 'no_email', 'add an e-mail address first');
  if (user.email_verified) return { already_verified: true };
  await rateLimit(ctx, `emailcode:${user.id}`, 5, 3600000);
  const code = String(100000 + (parseInt(randHex(4), 16) % 900000));
  await ctx.db.run(
    `INSERT INTO email_codes (user_id,code_hash,expires_at,attempts,sent_at) VALUES (?,?,?,0,?)
     ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, sent_at=excluded.sent_at`,
    [user.id, await ctx.hash(`${user.id}:${code}`), ctx.now() + 15 * 60000, ctx.now()],
  );
  await ctx.mailer.send({ to: user.email, subject: 'Your Partner Circle verification code', text: `Your code is ${code}. It works for 15 minutes.`, _code: code });
  return { sent: true };
}

export async function verifyEmailCode(ctx, user, code) {
  const row = await ctx.db.first('SELECT * FROM email_codes WHERE user_id=?', [user.id]);
  if (!row || row.expires_at < ctx.now()) throw new HttpError(400, 'code_expired', 'ask for a new code');
  if (row.attempts >= 5) throw new HttpError(429, 'too_many_attempts', 'ask for a new code');
  await ctx.db.run('UPDATE email_codes SET attempts = attempts + 1 WHERE user_id=?', [user.id]);
  if (row.code_hash !== (await ctx.hash(`${user.id}:${String(code).trim()}`))) throw new HttpError(400, 'wrong_code', 'that code is not right');
  await atomic(ctx, async () => [
    { sql: 'UPDATE users SET email_verified=1 WHERE id=?', params: [user.id] },
    { sql: 'DELETE FROM email_codes WHERE user_id=?', params: [user.id] },
    ...(await auditStmts(ctx, [{ action: 'user.email_verified', target: `user:${user.id}` }])),
  ]);
  return { verified: true };
}

export async function updateProfile(ctx, user, body) {
  const sets = [];
  const params = [];
  if (body.name !== undefined) { sets.push('name=?'); params.push(needStr(body.name, 'name', 120)); }
  if (body.phone !== undefined) { sets.push('phone=?'); params.push(checkPhone(body.phone, user.role !== 'refer')); }
  if (body.email !== undefined) {
    const email = checkEmail(body.email, user.role !== 'refer');
    const h = email ? await ctx.pepper(email) : null;
    if (h && h !== user.email_hash && (await ctx.db.first('SELECT 1 AS x FROM users WHERE email_hash=? AND id<>?', [h, user.id]))) {
      throw new HttpError(409, 'email_taken', 'this e-mail is already registered');
    }
    if (h !== user.email_hash) {
      sets.push('email=?', 'email_hash=?', 'email_verified=0');
      params.push(email, h);
    }
  }
  if (!sets.length) return user;
  await atomic(ctx, async () => [
    { sql: `UPDATE users SET ${sets.join(',')} WHERE id=?`, params: [...params, user.id] },
    ...(await auditStmts(ctx, [{ action: 'user.profile_update', target: `user:${user.id}`, meta: { fields: Object.keys(body) } }])),
  ]);
  return ctx.db.first('SELECT * FROM users WHERE id=?', [user.id]);
}

// ---- KYC ------------------------------------------------------------------------------------------------------

export async function submitKyc(ctx, user, body) {
  if (!user.email_verified) throw new HttpError(409, 'email_unverified', 'verify your e-mail before submitting payout details');
  const india = user.country === 'IN';
  const v = {};
  if (india) {
    v.pan = needStr(String(body.pan || '').toUpperCase(), 'pan', 10);
    if (!PAN_RE.test(v.pan)) throw new HttpError(422, 'invalid_field', 'PAN format is AAAAA9999A');
    v.upi_id = needStr(body.upi_id, 'upi_id', 80);
    if (!UPI_RE.test(v.upi_id)) throw new HttpError(422, 'invalid_field', 'UPI id looks invalid');
  } else {
    v.tax_id = needStr(body.tax_id, 'tax_id (government tax/ID number)', 40);
    v.bank_account = needStr(body.bank_account, 'bank_account', 40);
    v.bank_ifsc_swift = needStr(String(body.bank_ifsc_swift || '').toUpperCase(), 'bank_ifsc_swift', 15);
    if (!IFSC_SWIFT_RE.test(v.bank_ifsc_swift)) throw new HttpError(422, 'invalid_field', 'IFSC/SWIFT looks invalid');
    v.bank_name = needStr(body.bank_name, 'bank_name', 100);
  }
  const key = ctx.secret('KYC_KEY');
  const enc = {};
  for (const [k, val] of Object.entries(v)) enc[k] = k === 'bank_name' ? val : await encryptField(key, val);
  await atomic(ctx, async () => [
    {
      sql: `INSERT INTO user_kyc (user_id,country,pan,upi_id,tax_id,bank_account,bank_ifsc_swift,bank_name,status,submitted_at)
            VALUES (?,?,?,?,?,?,?,?, 'submitted', ?)
            ON CONFLICT(user_id) DO UPDATE SET country=excluded.country, pan=excluded.pan, upi_id=excluded.upi_id, tax_id=excluded.tax_id,
              bank_account=excluded.bank_account, bank_ifsc_swift=excluded.bank_ifsc_swift, bank_name=excluded.bank_name,
              status='submitted', submitted_at=excluded.submitted_at, verified_by=NULL, verified_at=NULL`,
      params: [user.id, user.country, enc.pan, enc.upi_id, enc.tax_id, enc.bank_account, enc.bank_ifsc_swift, enc.bank_name, ctx.now()],
    },
    ...(await auditStmts(ctx, [{ action: 'kyc.submit', target: `user:${user.id}` }])),
  ]);
  return kycView(ctx, user.id);
}

/** Masked view only. Raw values are decrypted solely inside payout execution. */
export async function kycView(ctx, userId) {
  const k = await ctx.db.first('SELECT * FROM user_kyc WHERE user_id=?', [userId]);
  if (!k) return { status: 'none' };
  const key = ctx.secret('KYC_KEY');
  const d = async (c) => (c ? mask(await decryptField(key, c), 4) : null);
  return {
    status: k.status, country: k.country, pan_masked: await d(k.pan), upi_masked: await d(k.upi_id), tax_id_masked: await d(k.tax_id),
    bank_account_masked: await d(k.bank_account), bank_ifsc_swift: k.bank_ifsc_swift ? '(on file)' : null, bank_name: k.bank_name,
    submitted_at: k.submitted_at, verified_at: k.verified_at,
  };
}

export async function decryptKyc(ctx, userId) {
  const k = await ctx.db.first('SELECT * FROM user_kyc WHERE user_id=?', [userId]);
  if (!k) return null;
  const key = ctx.secret('KYC_KEY');
  return {
    status: k.status, country: k.country, pan: await decryptField(key, k.pan), upi_id: await decryptField(key, k.upi_id),
    tax_id: await decryptField(key, k.tax_id), bank_account: await decryptField(key, k.bank_account),
    bank_ifsc_swift: await decryptField(key, k.bank_ifsc_swift), bank_name: k.bank_name,
  };
}

export async function reviewKyc(ctx, userId, approve, note) {
  const k = await ctx.db.first('SELECT * FROM user_kyc WHERE user_id=?', [userId]);
  if (!k || k.status !== 'submitted') throw new HttpError(409, 'not_submitted', 'no submitted KYC to review');
  const st = approve ? 'verified' : 'rejected';
  await atomic(ctx, async () => [
    { sql: 'UPDATE user_kyc SET status=?, verified_by=?, verified_at=? WHERE user_id=?', params: [st, ctx.actor?.keyId || null, ctx.now(), userId] },
    ...(await auditStmts(ctx, [{ action: `kyc.${st}`, target: `user:${userId}`, meta: { note: note || null } }])),
  ]);
  return kycView(ctx, userId);
}

// ---- team -----------------------------------------------------------------------------------------------------

export async function teamOf(ctx, userId) {
  const rows = await ctx.db.all(
    `WITH RECURSIVE t(id, depth) AS (
       SELECT id, 1 FROM users WHERE parent_id = ?
       UNION ALL SELECT u.id, t.depth + 1 FROM users u JOIN t ON u.parent_id = t.id WHERE t.depth < 6)
     SELECT u.*, t.depth FROM users u JOIN t ON t.id = u.id ORDER BY t.depth, u.created_at`,
    [userId],
  );
  return rows.map((u) => ({ ...publicUser(u), depth: u.depth }));
}

/** Ancestors of a user, nearest first, with a hard depth cap (also guards against bad data forming a loop). */
export async function uplineOf(ctx, userId) {
  const out = [];
  const seen = new Set([userId]);
  let cur = await ctx.db.first('SELECT parent_id FROM users WHERE id=?', [userId]);
  for (let i = 0; i < 6 && cur?.parent_id && !seen.has(cur.parent_id); i++) {
    const p = await ctx.db.first('SELECT * FROM users WHERE id=?', [cur.parent_id]);
    if (!p) break;
    out.push(p);
    seen.add(p.id);
    cur = p;
  }
  return out;
}
