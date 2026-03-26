const mongoose = require('mongoose');

const faqFeedbackSchema = new mongoose.Schema(
  {
    message: { type: String, required: true, trim: true, maxlength: 1000 },
    page: { type: String, default: 'faq' },
    sourceIp: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

module.exports = mongoose.model('FaqFeedback', faqFeedbackSchema);
