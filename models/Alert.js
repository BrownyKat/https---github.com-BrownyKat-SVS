const mongoose = require('mongoose');

const alertSchema = new mongoose.Schema(
  {
    title: { type: String, default: '' },
    message: { type: String, default: '' },
    disasterType: { type: String, default: 'General' },
    severity: { type: String, default: 'High' },
    active: { type: Boolean, default: true },
    sentBy: { type: String, default: '' },
    timestamp: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

module.exports = mongoose.model('Alert', alertSchema);
