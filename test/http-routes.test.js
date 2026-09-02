import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePath } from '../src/bindings/http.js';

describe('http routes', () => {
  test('reads a full URL as the path it names', () => {
    assert.equal(normalizePath('https://api.example.com/orders/42'), '/orders/{}');
    assert.equal(normalizePath('/orders?page=2'), '/orders');
  });

  test('three spellings of a parameter are one route', () => {
    // A Spring `{id}`, a Rails `:id` and a Django `<int:id>` are the same
    // route, and a caller writing a literal id means that route too.
    assert.equal(normalizePath('/orders/{id}'), '/orders/{}');
    assert.equal(normalizePath('/orders/:id'), '/orders/{}');
    assert.equal(normalizePath('/orders/<int:id>'), '/orders/{}');
  });

  test('a config placeholder names a key, not a route', () => {
    assert.equal(normalizePath('${orders.url}'), null);
    assert.equal(normalizePath('#{base}/x'), null);
  });

  test('normalises the shapes that would otherwise split one route in two', () => {
    assert.equal(normalizePath('orders'), '/orders');
    assert.equal(normalizePath('/orders/'), '/orders');
    assert.equal(normalizePath('//orders//new'), '/orders/new');
    assert.equal(normalizePath('/'), '/');
  });

  test('refuses anything that is not a path', () => {
    assert.equal(normalizePath(null), null);
    assert.equal(normalizePath('select * from t'), null);
    assert.equal(normalizePath(''), null);
  });
});
