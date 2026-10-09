import { describe, expect, it } from 'vitest';
import {
  createCredentials,
  isTimestampFresh,
  requestMessageV5,
  signRequestV5,
  verifyRequestV5,
  V5_MAX_SKEW_MS
} from '../index';

describe('v5 request auth contract', () => {
  const creds = createCredentials({ coin: 'xec' });
  const ts = 1758100000123;
  const nonce = 'f00d' + 'ab'.repeat(8);

  it('binds method, path, timestamp, nonce and raw body', () => {
    expect(requestMessageV5('POST', '/v5/envelopes/', ts, nonce, '{"a":1}')).toBe(
      `v5|post|/v5/envelopes/|${ts}|${nonce}|{"a":1}`
    );
    expect(requestMessageV5('get', '/v5/node-info', ts, nonce)).toBe(
      `v5|get|/v5/node-info|${ts}|${nonce}|`
    );
  });

  it('round-trips a v5 signature over the raw body', () => {
    const body = '{"amount":1.0,"z":null}';
    const sig = signRequestV5(creds.requestPrivKey, 'POST', '/v5/envelopes/', ts, nonce, body);
    expect(
      verifyRequestV5(creds.requestPubKey, sig, 'POST', '/v5/envelopes/', ts, nonce, body)
    ).toBe(true);
  });

  it('rejects any change to the signed fields', () => {
    const body = '{"a":1}';
    const sig = signRequestV5(creds.requestPrivKey, 'POST', '/v5/envelopes/', ts, nonce, body);
    expect(
      verifyRequestV5(creds.requestPubKey, sig, 'POST', '/v5/envelopes/', ts, nonce, '{"a": 1}')
    ).toBe(false);
    expect(
      verifyRequestV5(creds.requestPubKey, sig, 'POST', '/v5/envelopes/', ts + 1, nonce, body)
    ).toBe(false);
    expect(
      verifyRequestV5(creds.requestPubKey, sig, 'POST', '/v5/envelopes/', ts, 'other', body)
    ).toBe(false);
    expect(
      verifyRequestV5(creds.requestPubKey, sig, 'POST', '/v5/envelopes/2', ts, nonce, body)
    ).toBe(false);
    expect(
      verifyRequestV5(creds.requestPubKey, sig, 'post', '/v5/envelopes/', ts, nonce, ' ')
    ).toBe(false);
  });

  it('enforces the timestamp window', () => {
    const now = 1758100000123;
    expect(isTimestampFresh(now, now)).toBe(true);
    expect(isTimestampFresh(now - V5_MAX_SKEW_MS, now)).toBe(true);
    expect(isTimestampFresh(now - V5_MAX_SKEW_MS - 1, now)).toBe(false);
    expect(isTimestampFresh(now + V5_MAX_SKEW_MS + 1, now)).toBe(false);
    expect(isTimestampFresh(Number.NaN, now)).toBe(false);
  });
});
