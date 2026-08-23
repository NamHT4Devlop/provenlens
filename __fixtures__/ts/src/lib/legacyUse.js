'use strict';

var Ledger = require('./legacy');
var format = require('./format');

function build(owner) {
  format.formatDonor(owner);
  return new Ledger(owner);
}

module.exports = build;
