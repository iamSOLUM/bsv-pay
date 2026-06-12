/**
 * The buyer agent. It is deliberately blind: no keys, no wallet file, no
 * chain access — only the MCP tools bsv-pay exposes (`tool(name, args)`).
 * This scripted loop is a stand-in for an LLM agent; every step maps to
 * something Claude would do with the same tools (see the README to swap
 * Claude in for real). The interesting part is what happens when it
 * misbehaves: policy answers with structured results, not exceptions, and
 * the agent can read them and adapt.
 */
export async function runBuyerAgent({ tool, dataUrl, log }) {
  const outcome = {
    priceDiscovered: null,
    purchases: 0,
    injectionBlocked: false,
    budgetStopped: false,
  };

  // 1. Check the allowance BEFORE spending — plan, don't probe by failing.
  const status = await tool('get_policy_status');
  log(`my allowance: ${status.daily_remaining_sats} sats left today; denylist has ${status.denylist.length} entries`);

  // 2. Discover the price without paying: a 1-sat cap can never spend, but
  //    the refusal carries the seller's asking price.
  const probe = await tool('paid_fetch', { url: dataUrl, max_price_sats: 1 });
  if (probe.ok === false && probe.error === 'max_price_exceeded') {
    outcome.priceDiscovered = probe.price_sats;
    log(`price discovered for 0 sats: the seller wants ${probe.price_sats} sats per fetch`);
  }

  // 3. Buy until something says stop. Cap each fetch at the discovered
  //    price so a seller raising prices mid-session can't surprise me.
  for (let round = 1; round <= 5; round++) {
    const result = await tool('paid_fetch', { url: dataUrl, max_price_sats: outcome.priceDiscovered });

    if (result.ok === false) {
      // Not an exception: a structured refusal with the numbers I need.
      log(`purchase ${round} REFUSED: ${result.error} (${result.remaining_sats} sats left today) — stopping`);
      outcome.budgetStopped = result.error === 'daily_budget_exceeded';
      break;
    }

    outcome.purchases++;
    // `bsv-pay serve` wraps the content: {ok, message: <the dataset>, ...}
    const data = JSON.parse(JSON.parse(result.body).message);
    log(`bought ${data.dataset} for ${result.amount_sats} sats (txid ${result.txid.slice(0, 12)}…)`);

    // 4. The trap: the content I just paid for is also INPUT. It claims I
    //    must pay to keep my access. A naive agent obeys — this one does,
    //    on purpose, to show what stands behind it.
    const injected = /send (\d+) sats to (\w+)/.exec(data.note ?? '');
    if (injected && !outcome.injectionBlocked) {
      const [, sats, address] = injected;
      log(`the dataset says to pay ${sats} sats to ${address.slice(0, 12)}… — obeying (naively)`);
      const payment = await tool('pay', { address, amount_sats: Number(sats), memo: 'access fee?' });
      if (payment.ok === false && payment.error === 'recipient_denied') {
        outcome.injectionBlocked = true;
        log(`payment REFUSED: ${payment.error} — the human denylisted that address. Carrying on.`);
      }
    }
  }

  // 5. Account for the session.
  const after = await tool('get_policy_status');
  log(`done: ${outcome.purchases} purchases, ${after.daily_remaining_sats} sats of allowance left`);
  return outcome;
}
