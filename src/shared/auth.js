const { createHmac, timingSafeEqual } = require('node:crypto');

function signature(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function issueToken(claims, secret, now = Date.now()) {
  if (typeof secret !== 'string' || secret.length < 6) throw new Error('Auth secret is too short');
  const issuedAt = Math.floor(now / 1000);
  const payload = { iat: issuedAt, exp: issuedAt + 3600, ...claims };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return encoded + '.' + signature(encoded, secret);
}

function verifyToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string') throw new Error('Token is required');
  const [encoded, supplied, extra] = token.split('.');
  if (!encoded || !supplied || extra) throw new Error('Invalid token signature');
  const expected = signature(encoded, secret);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Invalid token signature');
  let claims;
  try { claims = JSON.parse(Buffer.from(encoded, 'base64url').toString()); } catch { throw new Error('Invalid token payload'); }
  if (!Number.isFinite(claims.exp) || Math.floor(now / 1000) >= claims.exp) throw new Error('Token expired');
  return claims;
}

function authorize(claims, roles, store) {
  const accepted = Array.isArray(roles) ? roles : [roles];
  if (!accepted.includes(claims?.role)) throw new Error('Forbidden role');
  if (store && claims.stores !== '*' && !claims.stores?.includes(store)) throw new Error('Forbidden store');
  return true;
}

// Command line token tool
function createRoleToken({ role, stores, secret }) {
  if (!['manager', 'supplier', 'driver'].includes(role)) throw new Error('Role must be manager, supplier or driver');
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('API_AUTH_SECRET must be at least 32 characters');
  const scope = stores === '*' ? '*' : String(stores || '').split(',').map(value => value.trim()).filter(Boolean);
  if (scope !== '*' && (!scope.length || scope.some(value => !/^store-\d+$/.test(value)))) {
    throw new Error('Store scope must be * or comma separated store IDs');
  }
  return issueToken({ role, stores: scope }, secret);
}

if (require.main === module) {
  try {
    console.log(createRoleToken({ role: process.argv[2], stores: process.argv[3],
      secret: process.env.API_AUTH_SECRET }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { authorize, createRoleToken, issueToken, verifyToken };
