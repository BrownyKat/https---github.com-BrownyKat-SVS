const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    actorRole: { type: String, default: '' },
    actorId: { type: String, default: '' },
    actorName: { type: String, default: '' },
    action: { type: String, default: '' },
    targetType: { type: String, default: '' },
    targetId: { type: String, default: '' },
    details: { type: String, default: '' },
    timestamp: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

module.exports = mongoose.model('AuditLog', auditLogSchema);
