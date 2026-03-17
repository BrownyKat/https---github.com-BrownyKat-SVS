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
    photo:         { type: String, default: null },  // base64 data-URL
    photos:        { type: [String], default: [] },  // up to 10 base64 data-URLs
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

// Virtual so every lean() doc exposes `.id = reportId`
reportSchema.virtual('id').get(function () {
  return this.reportId;
});

reportSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret._id;   // hide Mongo internal _id from the frontend
    return ret;
  },
});

module.exports = mongoose.model('Report', reportSchema);
