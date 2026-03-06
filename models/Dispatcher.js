const mongoose = require('mongoose');

const dispatcherSchema = new mongoose.Schema(
  {
    username:     { type: String, required: true, unique: true, trim: true },
    passwordHash: { type: String, required: true },
    fullName:     { type: String, default: '' },
    phone:        { type: String, default: '' },
    isActive:     { type: Boolean, default: true },
  },
  { versionKey: false, timestamps: true }
);

module.exports = mongoose.model('Dispatcher', dispatcherSchema);
