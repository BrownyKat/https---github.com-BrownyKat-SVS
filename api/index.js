const app = require('../server');

// Normalize the path when Vercel rewrites everything to /api/index.js
// so that the Express app sees the original route (/, /admin, /dashboard, etc).
module.exports = (req, res) => {
  const headerPath = req.headers['x-original-path'] || req.headers['x-vercel-original-path'] || '';
  const originalUrl = req.url || '/';

  // If the rewrite forwarded the original path as ?path=..., restore it.
  const urlObj = new URL(`http://localhost${originalUrl}`);
  const pathParam = urlObj.searchParams.get('path');
  const restored = pathParam || headerPath.replace(/^\/+/, '');
  if (restored) {
    req.url = `/${restored}`.replace(/\/+/g, '/');
  } else if (originalUrl === '/api/index.js' || originalUrl === '/api/index') {
    req.url = '/';
  } else if (originalUrl.startsWith('/api/')) {
    req.url = originalUrl.slice(4) || '/';
  }

  return app(req, res);
};
