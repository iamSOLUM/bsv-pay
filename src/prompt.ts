import readline from 'node:readline';

/**
 * All prompts write to stderr so --json stdout stays machine-clean
 * (invariant 2).
 */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

export function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Prompt without echoing the typed characters (passphrases). */
export function askHidden(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  let muted = false;
  // readline has no public mute API; overriding _writeToOutput is the
  // long-standing supported workaround.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (rl as any)._writeToOutput = (s: string) => {
    if (!muted) process.stderr.write(s);
  };
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      muted = false;
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

export async function confirm(question: string, def = false): Promise<boolean> {
  const suffix = def ? ' (Y/n) ' : ' (y/N) ';
  const answer = (await ask(question + suffix)).toLowerCase();
  if (answer === '') return def;
  return answer === 'y' || answer === 'yes';
}

/** Read all of stdin (for piped seed phrases / passphrases in scripts). */
export async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return (text.split('\n')[0] ?? '').trim();
}
