'use strict';
const crypto = require('crypto');
const SECRET = process.env.TOKEN_SECRET || 'dev-only-secret-change-me';
const TTL_MS = 12 * 3600 * 1000;

const hashPassword = (pw) => { const s = crypto.randomBytes(16).toString('hex');
  return s + ':' + crypto.scryptSync(pw, s, 32).toString('hex'); };
const verifyPassword = (pw, stored) => { const [s, h] = stored.split(':');
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, s, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b); };
const sign = (p) => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
function issueToken(userId) {
  const p = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + TTL_MS })).toString('base64url');
  return p + '.' + sign(p);
}
function readToken(t) {
  if (!t || !t.includes('.')) return null;
  const [p, sig] = t.split('.');
  const exp = sign(p);
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
  const d = JSON.parse(Buffer.from(p, 'base64url').toString());
  return d.exp > Date.now() ? d : null;
}
module.exports = { hashPassword, verifyPassword, issueToken, readToken };
