const mongoose = require('mongoose');

const webCallSchema = new mongoose.Schema(
  {
    reportId: { type: String, required: true, unique: true, index: true },
    offer: { type: mongoose.Schema.Types.Mixed, default: null },
    answer: { type: mongoose.Schema.Types.Mixed, default: null },
    offerCandidates: { type: [mongoose.Schema.Types.Mixed], default: [] },
    answerCandidates: { type: [mongoose.Schema.Types.Mixed], default: [] },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

module.exports = mongoose.models.WebCall || mongoose.model('WebCall', webCallSchema);
