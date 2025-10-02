const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function requireAuth(req, res, next) {
  try {
    const header = req.headers['authorization'] || req.headers['Authorization'];
    if (!header || typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'auth_required' });
    }
    const token = header.slice(7).trim();
    if (!token) {
      return res.status(401).json({ error: 'auth_required' });
    }
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      token,
    };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid_token', detail: err?.message });
  }
}

function optionalAuth(req, _res, next) {
  try {
    const header = req.headers['authorization'] || req.headers['Authorization'];
    if (header && typeof header === 'string' && header.startsWith('Bearer ')) {
      const token = header.slice(7).trim();
      if (token) {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = {
          id: decoded.sub,
          email: decoded.email,
          token,
        };
      }
    }
  } catch (_err) {
    // Ignore optional auth errors
  }
  next();
}

module.exports = {
  signToken,
  requireAuth,
  optionalAuth,
};
