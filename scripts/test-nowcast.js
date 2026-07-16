const assert = require('node:assert/strict');
const { pm25Aqi, pmNowcast, pmNowcastConcentration } = require('../lib/api-core');

assert.equal(pm25Aqi(0), 0);
assert.equal(pm25Aqi(9), 50);
assert.equal(pm25Aqi(9.1), 51);
assert.equal(pm25Aqi(35.4), 100);
assert.equal(pm25Aqi(35.5), 101);
assert.equal(pm25Aqi(55.4), 150);
assert.equal(pm25Aqi(55.5), 151);
assert.equal(pm25Aqi(125.4), 200);
assert.equal(pm25Aqi(125.5), 201);
assert.equal(pm25Aqi(225.4), 300);
assert.equal(pm25Aqi(225.5), 301);
assert.equal(pm25Aqi(325.4), 500);

const hour = 3600_000;
const stable = Array.from({ length: 12 }, (_, i) => ({ t: -i * hour, v: 35.4 }));
assert.equal(pmNowcastConcentration(stable), 35.4);
assert.equal(pmNowcast(stable), 100);
assert.equal(pmNowcast([...stable, { t: -12 * hour, v: 500 }]), 100);
assert.equal(pmNowcast([{ t: 0, v: 35.4 }, { t: -3 * hour, v: 35.4 }]), null);
assert.equal(pmNowcast([{ t: 0, v: 35.4 }, { t: -2 * hour, v: 35.4 }]), 100);
assert.equal(pmNowcast([{ t: -4 * hour, v: 35.4 }, { t: -5 * hour, v: 35.4 }], 0), null);

console.log('nowcast tests: pass');
