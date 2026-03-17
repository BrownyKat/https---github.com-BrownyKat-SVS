const app = require('../server');

// Normalize the path when Vercel rewrites everything to /api/index.js
// so that the Express app sees the original route (/, /admin, /dashboard, etc).
module.exports = (req, res) => {
  const originalUrl = req.url || '/';

  if (originalUrl === '/api/index.js' || originalUrl === '/api/index') {
    req.url = '/';
  } else if (originalUrl.startsWith('/api/')) {
    req.url = originalUrl.slice(4) || '/';
  }

  return app(req, res);
};
