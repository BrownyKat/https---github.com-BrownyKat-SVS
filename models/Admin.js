const mongoose = require('mongoose');

const adminSchema = new mongoose.Schema(
  {
    username:     { type: String, required: true, unique: true, trim: true },
    passwordHash: { type: String, required: true },
    fullName:     { type: String, default: 'System Administrator' },
  },
  { versionKey: false, timestamps: true }
);

module.exports = mongoose.model('Admin', adminSchema);
