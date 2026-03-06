const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    role: { type: String, required: true },
    userId: { type: String, required: true },
    username: { type: String, default: '' },
    fullName: { type: String, default: '' },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { versionKey: false, timestamps: true }
);

module.exports = mongoose.model('Session', sessionSchema);
