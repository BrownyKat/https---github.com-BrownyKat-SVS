const mongoose = require('mongoose');

const counterSchema = new mongoose.Schema({
  _id: String,          // e.g. "report" or "panic"
  seq: { type: Number, default: 0 },
});

counterSchema.statics.nextSeq = async function (name) {
  const doc = await this.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return doc.seq;
};

module.exports = mongoose.model('Counter', counterSchema);