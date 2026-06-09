import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.js';
import { CliError, EXIT } from '../src/errors.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsv-pay-test-'));
  process.env.BSV_PAY_HOME = tmpDir;
});

afterEach(() => {
  delete process.env.BSV_PAY_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(toml: string): void {
  fs.writeFileSync(path.join(tmpDir, 'config.toml'), toml);
}

describe('loadConfig', () => {
  it('returns defaults when no config file exists', () => {
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('applies values from the file over defaults', () => {
    writeConfig(
      'network = "test"\nfee_rate_sats_per_kb = 10\nspend_limit_sats = 50000\nfiat_display = true\n',
    );
    const cfg = loadConfig();
    expect(cfg.network).toBe('test');
    expect(cfg.feeRateSatsPerKb).toBe(10);
    expect(cfg.spendLimitSats).toBe(50_000);
    expect(cfg.fiatDisplay).toBe(true);
    expect(cfg.pollIntervalSecs).toBe(DEFAULT_CONFIG.pollIntervalSecs);
  });

  it('enforces the 5-second poll interval floor', () => {
    writeConfig('poll_interval_secs = 1\n');
    expect(loadConfig().pollIntervalSecs).toBe(5);
  });

  it('rejects an invalid network value with exit 2', () => {
    writeConfig('network = "regtest"\n');
    try {
      loadConfig();
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(EXIT.USAGE);
    }
  });

  it('rejects unparseable TOML with exit 2', () => {
    writeConfig('network = !!!\n');
    try {
      loadConfig();
      expect.unreachable();
    } catch (e) {
      expect((e as CliError).exitCode).toBe(EXIT.USAGE);
    }
  });

  it('rejects non-numeric numeric keys with exit 2', () => {
    writeConfig('spend_limit_sats = "lots"\n');
    try {
      loadConfig();
      expect.unreachable();
    } catch (e) {
      expect((e as CliError).exitCode).toBe(EXIT.USAGE);
    }
  });
});
