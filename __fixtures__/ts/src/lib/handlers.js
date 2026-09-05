const { formatAmount } = require('./format');

// The shape of every Lambda handler, Express router module and Discord command
// file: a named CommonJS export, which no `export` keyword announces.
exports.summarise = function summarise(donation) {
  return formatAmount(donation.amount);
};

module.exports.total = (a, b) => a + b;
