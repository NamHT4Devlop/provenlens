const Engine = require('../packages/node_modules/@acme/engine');

function start() {
  const engine = new Engine();
  return engine.ignite();
}

module.exports = start;
