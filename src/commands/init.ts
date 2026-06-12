import { Mnemonic, PrivateKey } from '@bsv/sdk';
import chalk from 'chalk';
import type { Ctx } from '../context.js';
import { CliError, EXIT, usageError } from '../errors.js';
import { walletPath } from '../paths.js';
import { ask, askHidden, confirm, isInteractive, readStdinLine } from '../prompt.js';
import { connectBrc100, type ConnectBrc100Options } from '../wallet/brc100.js';
import {
  buildBrc100WalletFile,
  buildWalletFile,
  walletExists,
  writeWalletFile,
  type SecretPayload,
} from '../wallet/wallet.js';
import { Wallet } from '../wallet/wallet.js';

export interface InitOptions {
  importSeed?: boolean;
  importWif?: boolean;
  force?: boolean;
  encrypt?: boolean; // commander --no-encrypt => false
  brc100?: boolean;
  experimentalBrc100?: boolean;
}

function stderr(text: string): void {
  process.stderr.write(text + '\n');
}

async function obtainNewSeed(): Promise<SecretPayload> {
  const mnemonic = Mnemonic.fromRandom();
  const words = mnemonic.toString().split(' ');

  stderr('');
  stderr(chalk.bold('Your new wallet seed phrase — write it down on paper, in order:'));
  stderr('');
  words.forEach((w, i) => stderr(`  ${String(i + 1).padStart(2)}. ${w}`));
  stderr('');
  stderr(
    chalk.yellow(
      'Anyone with these words can spend your funds. This is the ONLY time they are shown.',
    ),
  );
  stderr('');

  if (isInteractive()) {
    const checkIndex = Math.floor(Math.random() * words.length);
    for (let attempt = 1; ; attempt++) {
      const answer = await ask(`Confirm you wrote it down — type word #${checkIndex + 1}: `);
      if (answer.toLowerCase() === words[checkIndex]) break;
      if (attempt >= 3) {
        throw usageError(
          'seed_confirmation_failed',
          'Seed confirmation failed 3 times. No wallet was created; run init again.',
        );
      }
      stderr(chalk.red('That does not match. Check your written copy and try again.'));
    }
  } else {
    stderr(
      chalk.yellow(
        'Non-interactive run: seed confirmation skipped. The phrase above was printed to stderr — store it now.',
      ),
    );
  }
  return { type: 'mnemonic', value: mnemonic.toString() };
}

async function obtainImportedSeed(): Promise<SecretPayload> {
  const phrase = isInteractive()
    ? await ask('Enter your BIP-39 seed phrase: ')
    : await readStdinLine();
  const normalized = phrase.trim().toLowerCase().split(/\s+/).join(' ');
  if (!Mnemonic.isValid(normalized)) {
    throw usageError(
      'invalid_seed_phrase',
      'That is not a valid BIP-39 seed phrase (checksum failed). Check the words and their order.',
    );
  }
  return { type: 'mnemonic', value: normalized };
}

async function obtainImportedWif(): Promise<SecretPayload> {
  stderr(
    chalk.yellow('WARNING: a raw WIF key gives a single-address wallet with no HD derivation.'),
  );
  stderr(
    chalk.yellow(
      'Every payment reuses one address, which is bad for privacy. Prefer a seed phrase.',
    ),
  );
  if (isInteractive() && !(await confirm('Continue with WIF import?'))) {
    throw usageError('aborted', 'WIF import cancelled.');
  }
  const wif = isInteractive() ? await ask('Enter WIF private key: ') : await readStdinLine();
  try {
    PrivateKey.fromWif(wif.trim());
  } catch {
    throw usageError('invalid_wif', 'That is not a valid WIF private key (checksum failed).');
  }
  return { type: 'wif', value: wif.trim() };
}

/** Resolve the encryption passphrase for a new wallet, or null for opt-in unencrypted mode. */
async function obtainNewPassphrase(encrypt: boolean): Promise<string | null> {
  if (!encrypt) {
    stderr(chalk.yellow('WARNING: --no-encrypt stores the seed in PLAINTEXT on disk.'));
    if (isInteractive() && !(await confirm('Store the wallet unencrypted?'))) {
      throw usageError(
        'aborted',
        'Init cancelled. Re-run without --no-encrypt to use a passphrase.',
      );
    }
    return null;
  }
  const env = process.env.BSV_PAY_PASSPHRASE;
  if (env !== undefined) {
    if (env === '')
      throw usageError(
        'empty_passphrase',
        'BSV_PAY_PASSPHRASE is set but empty. Use a real passphrase or pass --no-encrypt explicitly.',
      );
    return env;
  }
  if (!isInteractive()) {
    throw new CliError(
      EXIT.WALLET_LOCKED,
      'passphrase_required',
      'No terminal to prompt for a passphrase. Set BSV_PAY_PASSPHRASE, or pass --no-encrypt to opt out of encryption.',
    );
  }
  for (;;) {
    const first = await askHidden('Choose a wallet passphrase: ');
    if (first === '') {
      stderr(chalk.red('Passphrase cannot be empty (use --no-encrypt to explicitly opt out).'));
      continue;
    }
    const second = await askHidden('Repeat passphrase: ');
    if (first === second) return first;
    stderr(chalk.red('Passphrases do not match. Try again.'));
  }
}

export async function cmdInit(
  ctx: Ctx,
  opts: InitOptions,
  brc100Connect?: ConnectBrc100Options,
): Promise<void> {
  if (opts.brc100) {
    throw usageError(
      'brc100_not_supported',
      'BRC-100 custody is EXPERIMENTAL. Re-run with --experimental-brc100 to connect an ' +
        'external wallet app (spending works; receiving still needs the wallet app itself — ' +
        'see the README), or use a local wallet: "bsv-pay init".',
    );
  }
  if (opts.experimentalBrc100 && (opts.importSeed || opts.importWif)) {
    throw usageError(
      'conflicting_flags',
      '--experimental-brc100 delegates custody to the external wallet; there is no seed or WIF to import.',
    );
  }
  if (opts.importSeed && opts.importWif) {
    throw usageError('conflicting_flags', 'Pass either --import-seed or --import-wif, not both.');
  }

  if (walletExists(ctx.network) && !opts.force) {
    throw usageError(
      'wallet_exists',
      `A ${ctx.network === 'test' ? 'testnet ' : ''}wallet already exists at ${walletPath(ctx.network)}. ` +
        'Re-run with --force to overwrite it (this DESTROYS the old wallet unless you have its seed).',
    );
  }

  if (opts.experimentalBrc100) {
    await initBrc100(ctx, brc100Connect);
    return;
  }

  const secret: SecretPayload = opts.importSeed
    ? await obtainImportedSeed()
    : opts.importWif
      ? await obtainImportedWif()
      : await obtainNewSeed();

  const passphrase = await obtainNewPassphrase(opts.encrypt !== false);
  const file = buildWalletFile(ctx.network, secret, passphrase);
  writeWalletFile(ctx.network, file);

  // Derive and record the first receive address. Unlock reads the file we
  // just wrote; passphrase comes from env or the in-memory value.
  let firstAddress: string;
  if (passphrase !== null && process.env.BSV_PAY_PASSPHRASE === undefined) {
    process.env.BSV_PAY_PASSPHRASE = passphrase; // current process only
    try {
      const wallet = await Wallet.unlock(ctx.network);
      firstAddress = wallet.issueAddress('receive').address;
    } finally {
      delete process.env.BSV_PAY_PASSPHRASE;
    }
  } else {
    const wallet = await Wallet.unlock(ctx.network);
    firstAddress = wallet.issueAddress('receive').address;
  }

  ctx.out.info('');
  ctx.out.info(chalk.green('Wallet created.'));
  ctx.out.info(`  Network:        ${ctx.network === 'test' ? 'testnet' : 'mainnet'}`);
  ctx.out.info(
    `  Encrypted:      ${passphrase !== null ? 'yes (argon2id + AES-256-GCM)' : chalk.red('NO — plaintext seed')}`,
  );
  ctx.out.info(`  First address:  ${firstAddress}`);
  ctx.out.info(`  State dir:      ${walletPath(ctx.network)}`);
  ctx.out.info('');
  ctx.out.info('Next: fund it, then try "bsv-pay balance" or "bsv-pay request 5000sats".');
  ctx.out.result({
    ok: true,
    network: ctx.network,
    encrypted: passphrase !== null,
    type: secret.type,
    address: firstAddress,
  });
}

/**
 * EXPERIMENTAL BRC-100 custody: connect the external wallet app, verify the
 * network, and write a wallet file that records the delegation — no seed, no
 * passphrase, nothing secret stored locally. Spending goes through the same
 * policy gate as every wallet; receiving stays in the wallet app (documented
 * limitation, see README).
 */
async function initBrc100(ctx: Ctx, connectOpts?: ConnectBrc100Options): Promise<void> {
  stderr(chalk.yellow('BRC-100 custody is EXPERIMENTAL. Keys stay in your wallet app;'));
  stderr(
    chalk.yellow('bsv-pay will ask it to pay, and your policy.toml still governs every spend.'),
  );
  stderr('Connecting to the wallet app... (approve the connection if it prompts)');

  const wallet = await connectBrc100(ctx.network, connectOpts);
  await wallet.waitForAuthentication();
  const identityKey = await wallet.identityKey();
  const version = await wallet.version();

  writeWalletFile(ctx.network, buildBrc100WalletFile(ctx.network, wallet.url));

  ctx.out.info('');
  ctx.out.info(chalk.green('Wallet connected (BRC-100, experimental).'));
  ctx.out.info(`  Network:        ${ctx.network === 'test' ? 'testnet' : 'mainnet'}`);
  ctx.out.info(`  Custody:        external wallet app (${version}) at ${wallet.url}`);
  ctx.out.info(`  Identity key:   ${identityKey}`);
  ctx.out.info(`  State dir:      ${walletPath(ctx.network)}`);
  ctx.out.info('');
  ctx.out.info('Spending (send/fetch/MCP pay) works now, governed by policy.toml.');
  ctx.out.info('Receiving still happens in the wallet app itself — see the README.');
  ctx.out.result({
    ok: true,
    network: ctx.network,
    backend: 'brc100',
    type: 'brc100',
    identity_key: identityKey,
    wallet_url: wallet.url,
  });
}
