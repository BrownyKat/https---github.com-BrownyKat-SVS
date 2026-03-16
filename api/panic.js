// Dedicated serverless entry for /api/panic on Vercel.
const app = require('../server');

module.exports = (req, res) => {
  return app(req, res);
};
