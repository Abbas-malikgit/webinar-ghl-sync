import { config } from '../config.js';

// HTTP Basic Auth for dashboard + /api/*.
// If DASHBOARD_USER and DASHBOARD_PASS are unset, auth is bypassed (dev mode).
export function basicAuth(req, res, next) {
  const user = config.auth.user;
  const pass = config.auth.pass;

  if (!user || !pass) return next(); // no creds configured — open mode

  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Smmartly Sync"');
    return res.status(401).send('Authentication required');
  }

  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  const u = decoded.slice(0, idx);
  const p = decoded.slice(idx + 1);

  if (u === user && p === pass) return next();

  res.set('WWW-Authenticate', 'Basic realm="Smmartly Sync"');
  return res.status(401).send('Invalid credentials');
}
