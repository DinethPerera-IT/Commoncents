import bcrypt from 'bcryptjs';
import { q, one } from './db.js';

const SESSION_DAYS = 30;

export async function login(req, res) {
  const { name, password } = req.body || {};
  if (!name || !password) return res.status(400).json({ error: { code: 'MISSING_FIELD', message: 'Name and password are required.' } });
  const user = await one('SELECT * FROM users WHERE lower(name)=lower($1) AND active', [String(name)]);
  if (!user || !user.password_hash || !(await bcrypt.compare(String(password), user.password_hash))) {
    return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Wrong name or password.' } });
  }
  const s = await one(
    "INSERT INTO sessions (user_id, expires_at) VALUES ($1, now() + interval '" + SESSION_DAYS + " days') RETURNING id",
    [user.id]);
  res.cookie('ccsid', s.id, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false',
    maxAge: SESSION_DAYS * 864e5, path: '/',
  });
  res.json({ ok: true, user: publicUser(user) });
}

export async function logout(req, res) {
  const sid = req.cookies.ccsid;
  if (sid) await q('DELETE FROM sessions WHERE id=$1', [sid]).catch(() => {});
  res.clearCookie('ccsid');
  res.json({ ok: true });
}

export async function requireAuth(req, res, next) {
  try {
    const sid = req.cookies.ccsid;
    if (!sid) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Please log in.' } });
    const row = await one(
      'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id=$1 AND s.expires_at > now()', [sid]);
    if (!row) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Session expired.' } });
    req.user = row;
    next();
  } catch (e) {
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Please log in.' } });
  }
}

export async function changePassword(req, res) {
  const { current, next: nextPw } = req.body || {};
  if (!nextPw || String(nextPw).length < 8) {
    return res.status(400).json({ error: { code: 'MISSING_FIELD', message: 'New password must be at least 8 characters.' } });
  }
  const ok = await bcrypt.compare(String(current || ''), req.user.password_hash);
  if (!ok) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Current password is wrong.' } });
  const hash = await bcrypt.hash(String(nextPw), 10);
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
  res.json({ ok: true });
}

export const publicUser = (u) => ({
  id: u.id, name: u.name, initials: u.initials, weekly_rent: u.weekly_rent,
  is_admin: u.is_admin, active: u.active,
});
