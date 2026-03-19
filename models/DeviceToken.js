const mongoose = require('mongoose');

const deviceTokenSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    platform: { type: String, default: 'unknown' },
    deviceLabel: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { versionKey: false, timestamps: true }
);

module.exports = mongoose.model('DeviceToken', deviceTokenSchema);
