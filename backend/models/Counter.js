const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Atomic counters (e.g. complaint ticket numbers). Uses findOneAndUpdate $inc
// so concurrent complaint submits never get the same number.
const CounterSchema = new Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

CounterSchema.statics.next = async function (name) {
  const doc = await this.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  ).lean();
  return doc.seq;
};

// 1 -> FLD-A01, 100 -> FLD-A100? No: 2-digit groups: 1 -> A01 ... 99 -> A99,
// 100 -> B01 ... Letters extend past Z as AA, AB ... so numbers never repeat.
function ticketIdFromSeq(seq) {
  const group = Math.floor((seq - 1) / 99);
  const num = ((seq - 1) % 99) + 1;
  let letters = '';
  let g = group;
  do {
    letters = String.fromCharCode(65 + (g % 26)) + letters;
    g = Math.floor(g / 26) - 1;
  } while (g >= 0);
  return `FLD-${letters}${String(num).padStart(2, '0')}`;
}

module.exports = mongoose.model('Counter', CounterSchema);
module.exports.ticketIdFromSeq = ticketIdFromSeq;
