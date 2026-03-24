const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema(
  {
    reportId:      { type: String, unique: true },   // "RPT-0001" | "SOS-0001"
    name:          { type: String, default: '' },
    contact:       { type: String, default: '' },
    emergencyType: { type: String, default: '' },
    severity:      { type: String, default: '' },
    barangay:      { type: String, default: '' },
    landmark:      { type: String, default: '' },
    street:        { type: String, default: '' },
    description:   { type: String, default: '' },
    gps:           { type: String, default: '' },
    photo:         { type: String, default: null },  // primary Supabase storage URL
    photos:        { type: [String], default: [] },  // Supabase storage URLs
    tags:          { type: [String], default: [] },
    status:        { type: String, default: 'new', enum: ['new','verifying','dispatched','resolved','false-report'] },
    dispatcherId:  { type: String, default: '' },
    dispatcherName:{ type: String, default: '' },
    credibility:   { type: String, default: 'low',  enum: ['low','medium','high'] },
    isPanic:       { type: Boolean, default: false },
    claimedById:   { type: String, default: '' },
    claimedByUsername: { type: String, default: '' },
    claimedByName: { type: String, default: '' },
    claimedAt:     { type: Date, default: null },
    assignedToId:  { type: String, default: '' },
    assignedToUsername: { type: String, default: '' },
    assignedToName:{ type: String, default: '' },
    assignedAt:    { type: Date, default: null },
    passCount:     { type: Number, default: 0, min: 0 },
    lastPassedById:{ type: String, default: '' },
    lastPassedByUsername: { type: String, default: '' },
    lastPassedByName: { type: String, default: '' },
    lastPassedAt:  { type: Date, default: null },
    timestamp:     { type: Date,   default: Date.now },
  },
  { versionKey: false }
);

// Virtual so every lean() doc exposes `.id = reportId` (with fallback to _id)
reportSchema.virtual('id').get(function () {
  return this.reportId || String(this._id || '');
});

reportSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret.id || ret.reportId || String(ret._id || '');
    // Keep _id for fallback, but also expose it as id
    return ret;
  },
});

module.exports = mongoose.model('Report', reportSchema);
