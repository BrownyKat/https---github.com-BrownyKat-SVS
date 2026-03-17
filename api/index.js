const app = require('../server');

// Normalize the path when Vercel rewrites everything to /api/index.js
// so that the Express app sees the original route (/, /admin, /dashboard, etc).
module.exports = (req, res) => {
  const headerPath = req.headers['x-original-path'] || req.headers['x-vercel-original-path'] || '';
  const headerUrl = req.headers['x-original-url'] || req.headers['x-rewrite-path'] || '';
  const originalUrl = req.url || '/';

  // If the rewrite forwarded the original path as ?path=..., restore it.
  const urlObj = new URL(`http://localhost${originalUrl}`);
  const pathParam = urlObj.searchParams.get('path');
  const restoredRaw = pathParam || headerPath || headerUrl || originalUrl;
  let restored = restoredRaw ? decodeURIComponent(restoredRaw) : '/';
  restored = restored.replace(/^https?:\/\/[^/]+/, ''); // strip host if present
  if (!restored.startsWith('/')) restored = `/${restored}`;
  // Drop any query string fragments from restored path
  restored = restored.split('?')[0].split('#')[0] || '/';
  if (restored.startsWith('/api/')) restored = restored.slice(4) || '/';
  if (restored === '/api/index.js' || restored === '/api/index') restored = '/';
  req.url = restored.replace(/\/{2,}/g, '/');

  return app(req, res);
};
