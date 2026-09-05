const handlers = require('./handlers');

function report(donation) {
  return handlers.summarise(donation);
}

module.exports = report;
