const mongoose = require('mongoose');

const LoginAttemptSchema = new mongoose.Schema({
  key: { type: String, required: true, index: true },
  createdAt: { type: Date, default: Date.now, expires: 600 }, // 10 minutes TTL
});

module.exports = mongoose.models.LoginAttempt || mongoose.model('LoginAttempt', LoginAttemptSchema);
