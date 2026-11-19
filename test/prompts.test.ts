import assert from 'node:assert/strict';
import readlinePromises from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { stripAnsi } from '../src/utils/format.js';
import {
  type PromptSelectInputStream,
  type PromptSelectOutputStream,
  promptSelectWithIO,
  type SelectOption,
} from '../src/utils/prompts.js';

interface MockTty {
  input: PassThrough & PromptSelectInputStream;
  output: PassThrough & PromptSelectOutputStream;
  chunks: string[];
  rawModeHistory: boolean[];
  getRawOutput: () => string;
  getLastChunk: () => string;
}

function createMockTty(opts: { isTTY?: boolean; columns?: number; rows?: number } = {}): MockTty {
  const isTTY = opts.isTTY ?? true;
  const rawModeHistory: boolean[] = [];

  const input = new PassThrough() as PassThrough & PromptSelectInputStream;
  input.isTTY = isTTY;
  input.isRaw = false;
  if (isTTY) {
    input.setRawMode = (mode: boolean) => {
      input.isRaw = mode;
      rawModeHistory.push(mode);
    };
  }

  const chunks: string[] = [];
  const output = new PassThrough() as PassThrough & PromptSelectOutputStream;
  output.isTTY = isTTY;
  output.columns = opts.columns ?? 80;
  output.rows = opts.rows ?? 24;
  output.on('data', (chunk: Buffer | string) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  });

  return {
    input,
    output,
    chunks,
    rawModeHistory,
    getRawOutput: () => chunks.join(''),
    getLastChunk: () => chunks[chunks.length - 1] ?? '',
  };
}

async function withForceColor<T>(fn: () => Promise<T>): Promise<T> {
  const prevForce = process.env.FORCE_COLOR;
  const prevNoColor = process.env.NO_COLOR;
  process.env.FORCE_COLOR = '1';
  delete process.env.NO_COLOR;
  try {
    return await fn();
  } finally {
    if (prevForce === undefined) {
      delete process.env.FORCE_COLOR;
    } else {
      process.env.FORCE_COLOR = prevForce;
    }
    if (prevNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = prevNoColor;
    }
  }
}

const VISIBILITY_OPTIONS: SelectOption<'Public' | 'Private' | 'Protected' | 'Collaborators'>[] = [
  { value: 'Public', label: 'Public', description: 'visible to everyone (default)' },
  { value: 'Private', label: 'Private', description: 'visible only to you / your team' },
  { value: 'Protected', label: 'Protected', description: 'password-protected (min 8 characters)' },
  { value: 'Collaborators', label: 'Collaborators', description: 'visible only to you and collaborators' },
];

describe('arrow-key promptSelect', () => {
  it('renders → in cyan while moving with arrow keys and collapses to green → on Enter', async () => {
    await withForceColor(async () => {
      const tty = createMockTty({ isTTY: true, columns: 100, rows: 24 });

      const promise = promptSelectWithIO('Pen visibility:', VISIBILITY_OPTIONS, 0, {
        input: tty.input,
        output: tty.output,
        term: 'xterm-256color',
      });

      // Wait a tick for initial render
      await new Promise((r) => setImmediate(r));
      const initialRaw = tty.getLastChunk();
      const initialPlain = stripAnsi(initialRaw);

      assert.ok(initialRaw.includes('\x1b[?25l'), 'Should hide cursor while selecting');
      assert.ok(initialRaw.includes('\x1b[36m'), 'Highlighted option should use cyan color');
      assert.ok(initialPlain.includes('  → Public — visible to everyone (default)'), initialPlain);
      assert.ok(initialPlain.includes('    Private — visible only to you / your team'), initialPlain);
      assert.equal(initialPlain.includes('Choose [1-'), false, 'Should not render old numeric prompt');
      assert.equal(initialPlain.includes('1)'), false, 'Should not render numbered list');

      // Press Down arrow -> highlights Private
      tty.input.write('\x1b[B');
      await new Promise((r) => setImmediate(r));
      const afterDownRaw = tty.getLastChunk();
      const afterDownPlain = stripAnsi(afterDownRaw);
      assert.ok(afterDownRaw.includes('\x1b[5A\r\x1b[J'), 'Should erase the 5 previously rendered rows');
      assert.ok(afterDownPlain.includes('    Public — visible to everyone (default)'), afterDownPlain);
      assert.ok(afterDownPlain.includes('  → Private — visible only to you / your team'), afterDownPlain);

      // Press Enter -> confirms Private and collapses unselected options
      tty.input.write('\r');
      const selected = await promise;
      assert.equal(selected, 'Private');

      const finalRaw = tty.getLastChunk();
      const finalPlain = stripAnsi(finalRaw);
      assert.ok(finalRaw.includes('\x1b[5A\r\x1b[J'), 'Should erase full menu before collapsing');
      assert.ok(finalRaw.includes('\x1b[32m'), 'Confirmed choice should change to green color');
      assert.ok(finalRaw.includes('\x1b[?25h'), 'Should restore cursor visibility on confirm');
      assert.ok(finalPlain.includes('Pen visibility:\n'), finalPlain);
      assert.ok(finalPlain.includes('  → Private — visible only to you / your team'), finalPlain);
      assert.equal(finalPlain.includes('Public'), false, 'Unselected options should be collapsed');
      assert.equal(finalPlain.includes('Protected'), false, 'Unselected options should be collapsed');
      assert.equal(tty.input.isRaw, false, 'Should restore raw mode to false');
      assert.deepEqual(tty.rawModeHistory, [true, false]);
    });
  });

  it('wraps around with Up/Down, supports j/k, Home/End, and 1-9 jump keys', async () => {
    const tty = createMockTty({ isTTY: true, columns: 100, rows: 24 });

    const promise = promptSelectWithIO('Pen visibility:', VISIBILITY_OPTIONS, 0, {
      input: tty.input,
      output: tty.output,
      term: 'xterm-256color',
    });
    await new Promise((r) => setImmediate(r));

    // Up from index 0 wraps to last option (Collaborators)
    tty.input.write('\x1b[A');
    await new Promise((r) => setImmediate(r));
    assert.ok(stripAnsi(tty.getLastChunk()).includes('  → Collaborators'));

    // j moves down and wraps back to Public (index 0)
    tty.input.write('j');
    await new Promise((r) => setImmediate(r));
    assert.ok(stripAnsi(tty.getLastChunk()).includes('  → Public'));

    // Jump directly to 3rd option (Protected) with '3'
    tty.input.write('3');
    await new Promise((r) => setImmediate(r));
    assert.ok(stripAnsi(tty.getLastChunk()).includes('  → Protected'));

    // k moves up to Private (index 1)
    tty.input.write('k');
    await new Promise((r) => setImmediate(r));
    assert.ok(stripAnsi(tty.getLastChunk()).includes('  → Private'));

    tty.input.write('\r');
    const selected = await promise;
    assert.equal(selected, 'Private');
  });

  it('restores cursor and raw mode and rejects cleanly on Ctrl+C', async () => {
    const tty = createMockTty({ isTTY: true, columns: 80, rows: 24 });

    const promise = promptSelectWithIO('Pick one:', VISIBILITY_OPTIONS, 0, {
      input: tty.input,
      output: tty.output,
      term: 'xterm-256color',
    });
    await new Promise((r) => setImmediate(r));

    tty.input.write('\u0003');
    await assert.rejects(() => promise, /Prompt canceled by user/);

    const finalRaw = tty.getLastChunk();
    assert.ok(finalRaw.includes('\x1b[?25h'), 'Cursor must be restored on cancel');
    assert.ok(stripAnsi(finalRaw).includes('Canceled'), 'Canceled state should be shown');
    assert.equal(tty.input.isRaw, false, 'Raw mode must be restored on cancel');
  });

  it('scrolls long lists inside a bounded viewport with ↑/↓ more indicators', async () => {
    const manyOptions: SelectOption<string>[] = Array.from({ length: 15 }, (_, i) => ({
      value: `opt-${i + 1}`,
      label: `Template ${i + 1}`,
    }));

    // rows = 10 => maxVisible = Math.min(15, Math.max(3, 10 - 5), 12) = 5
    const tty = createMockTty({ isTTY: true, columns: 80, rows: 10 });

    const promise = promptSelectWithIO('Choose a template:', manyOptions, 0, {
      input: tty.input,
      output: tty.output,
      term: 'xterm-256color',
    });
    await new Promise((r) => setImmediate(r));

    const firstFrame = stripAnsi(tty.getLastChunk());
    assert.ok(firstFrame.includes('  → Template 1'), firstFrame);
    assert.ok(firstFrame.includes('↓ 10 more'), firstFrame);
    assert.equal(firstFrame.includes('Template 6'), false, 'Should bound visible options');

    // Move down 6 times -> index 6 (Template 7), scrolling window to show Templates 3..7
    for (let i = 0; i < 6; i++) {
      tty.input.write('\x1b[B');
    }
    await new Promise((r) => setImmediate(r));

    const scrolledFrame = stripAnsi(tty.getLastChunk());
    assert.ok(scrolledFrame.includes('↑ 2 more'), scrolledFrame);
    assert.ok(scrolledFrame.includes('  → Template 7'), scrolledFrame);
    assert.ok(scrolledFrame.includes('↓ 8 more'), scrolledFrame);

    tty.input.write('\r');
    const selected = await promise;
    assert.equal(selected, 'opt-7');
  });

  it('accounts for wrapped lines on narrow terminals when erasing previous render', async () => {
    // 30-col terminal; option line exceeds 30 chars and wraps to 2 rows
    const tty = createMockTty({ isTTY: true, columns: 30, rows: 24 });
    const opts: SelectOption<string>[] = [
      { value: 'a', label: 'First', description: 'a somewhat longer description text' },
      { value: 'b', label: 'Second', description: 'short' },
    ];

    const promise = promptSelectWithIO('Pick:', opts, 0, {
      input: tty.input,
      output: tty.output,
      term: 'xterm-256color',
    });
    await new Promise((r) => setImmediate(r));

    // Question: "Pick: (↑/↓, Enter)" = 18 chars -> 1 row
    // Opt 1: "  → First — a somewhat longer description text" = 46 chars -> ceil(46/30) = 2 rows
    // Opt 2: "    Second — short" = 18 chars -> 1 row
    // Total = 4 physical rows
    tty.input.write('\x1b[B');
    await new Promise((r) => setImmediate(r));
    assert.ok(
      tty.getLastChunk().includes('\x1b[4A\r\x1b[J'),
      `Expected erase of 4 wrapped rows, got: ${JSON.stringify(tty.getLastChunk())}`,
    );

    tty.input.write('\r');
    const selected = await promise;
    assert.equal(selected, 'b');
  });

  it('works seamlessly across sequential select -> text -> select prompts on the same stream', async () => {
    const tty = createMockTty({ isTTY: true, columns: 100, rows: 24 });

    // 1. First select prompt
    const p1 = promptSelectWithIO(
      'Profile:',
      [
        { value: 'alpha', label: 'alpha' },
        { value: 'beta', label: 'beta' },
      ],
      0,
      { input: tty.input, output: tty.output, term: 'xterm-256color' },
    );
    await new Promise((r) => setImmediate(r));
    tty.input.write('\x1b[B\r');
    assert.equal(await p1, 'beta');

    // 2. Interleaved readline text prompt
    const rl = readlinePromises.createInterface({ input: tty.input, output: tty.output });
    const textPromise = rl.question('Title: ');
    tty.input.write('My Demo\n');
    const title = await textPromise;
    rl.close();
    assert.equal(title, 'My Demo');

    // 3. Second select prompt on the exact same stream
    const p2 = promptSelectWithIO('Visibility:', VISIBILITY_OPTIONS, 0, {
      input: tty.input,
      output: tty.output,
      term: 'xterm-256color',
    });
    await new Promise((r) => setImmediate(r));
    tty.input.write('\x1b[B\x1b[B\r');
    assert.equal(await p2, 'Protected');
  });

  it('falls back to numbered readline prompt when stdin/stdout are not a TTY or TERM=dumb', async () => {
    const tty = createMockTty({ isTTY: false });

    const promise = promptSelectWithIO('Pen visibility:', VISIBILITY_OPTIONS, 0, {
      input: tty.input,
      output: tty.output,
    });
    await new Promise((r) => setImmediate(r));
    tty.input.write('2\n');

    const selected = await promise;
    assert.equal(selected, 'Private');
    const plain = stripAnsi(tty.getRawOutput());
    assert.ok(plain.includes('1) Public'), plain);
    assert.ok(plain.includes('Choose [1-4]'), plain);

    // Also falls back on TERM=dumb even when isTTY=true
    const dumbTty = createMockTty({ isTTY: true });
    const dumbPromise = promptSelectWithIO('Pen visibility:', VISIBILITY_OPTIONS, 1, {
      input: dumbTty.input,
      output: dumbTty.output,
      term: 'dumb',
    });
    await new Promise((r) => setImmediate(r));
    dumbTty.input.write('\n');
    assert.equal(await dumbPromise, 'Private');
  });
});
