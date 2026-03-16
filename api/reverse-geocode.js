// Dedicated serverless entry for /api/reverse-geocode on Vercel.
const app = require('../server');

module.exports = (req, res) => {
  return app(req, res);
};
