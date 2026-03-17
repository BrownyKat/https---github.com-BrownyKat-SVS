const app = require('../server');

// Normalize the path when Vercel rewrites everything to /api/index.js
// so that the Express app sees the original route (/, /admin, /dashboard, etc).
module.exports = (req, res) => {
  // Attempt to recover the original path Vercel rewrote.
  const headerPath =
    req.headers['x-original-path'] ||
    req.headers['x-vercel-original-path'] ||
    req.headers['x-vercel-original-url'] ||
    req.headers['x-rewrite-path'] ||
    req.headers['x-original-url'] ||
    '';
  let restored = headerPath || req.url || '/';
  restored = decodeURIComponent(String(restored));
  restored = restored.replace(/^https?:\/\/[^/]+/i, ''); // strip scheme/host if present
  restored = restored.split('?')[0].split('#')[0] || '/';
  if (!restored.startsWith('/')) restored = `/${restored}`;
  if (restored.startsWith('/api/')) restored = restored.slice(4) || '/';
  if (restored === '/api/index.js' || restored === '/api/index') restored = '/';
  req.url = restored.replace(/\/{2,}/g, '/');

  return app(req, res);
};
