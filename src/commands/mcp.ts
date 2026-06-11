import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Ctx } from '../context.js';
import { openWallet } from '../core/wallet.js';
import { buildMcpServer } from '../mcp/server.js';
import { obtainPassphrase } from '../wallet/wallet.js';

/**
 * `bsv-pay mcp` — serve the MCP tools over stdio. stdout belongs to the
 * MCP protocol from here on (the strictest case of invariant 5); every
 * human-facing line goes to stderr.
 *
 * The wallet unlocks ONCE, at startup, before the transport opens: the
 * passphrase comes from BSV_PAY_PASSPHRASE or an interactive TTY prompt,
 * and there is deliberately no tool to unlock, lock, or re-key — the agent
 * connected to this server never holds a secret. With neither env nor TTY
 * the server refuses to start (exit 7) rather than serve a locked wallet.
 */
export async function cmdMcp(ctx: Ctx): Promise<void> {
  const wallet = await openWallet({
    network: ctx.network,
    config: ctx.config,
    passphrase: () => obtainPassphrase(),
    onWarning: (text) => process.stderr.write(text + '\n'),
  });

  const server = buildMcpServer({ network: ctx.network, wallet, config: ctx.config });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `bsv-pay MCP server ready on ${ctx.network === 'test' ? 'testnet' : 'mainnet'} (stdio). ` +
      'Policy is enforced in core; edit policy.toml and restart to change limits.\n',
  );

  // Serve until the client closes the transport (stdin EOF).
  await new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
}
