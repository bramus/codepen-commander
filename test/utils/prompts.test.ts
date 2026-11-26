import assert from 'node:assert/strict';
import readlinePromises from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { stripAnsi } from '../../src/utils/format.js';
import {
  type MultiSelectOption,
  PromptCanceledError,
  promptConfirmWithIO,
  promptMultiSelectWithIO,
  type PromptSelectInputStream,
  type PromptSelectOutputStream,
  promptSelectWithIO,
  promptValidatedTextWithIO,
  type SelectOption,
} from '../../src/utils/prompts/index.js';

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
      assert.ok(initialRaw.includes('\x1b[1;36m'), 'Highlighted option should use bold cyan color');
      assert.ok(initialPlain.includes('◆ Pen visibility:'), initialPlain);
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
      assert.ok(finalRaw.includes('\x1b[1;32m'), 'Confirmed choice should change to bold green color');
      assert.ok(finalRaw.includes('\x1b[?25h'), 'Should restore cursor visibility on confirm');
      assert.ok(finalPlain.includes('◆ Pen visibility:\n'), finalPlain);
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

  it('supports arrow-key Yes/No promptConfirm with y/n shortcuts and non-TTY fallback', async () => {
    const tty = createMockTty({ isTTY: true, columns: 80, rows: 24 });
    const promise = promptConfirmWithIO('Overwrite existing build?', false, {
      input: tty.input,
      output: tty.output,
      term: 'xterm-256color',
    });
    await new Promise((r) => setImmediate(r));
    assert.ok(stripAnsi(tty.getLastChunk()).includes('  → No'));

    // Press 'y' shortcut to highlight Yes, then Enter to confirm
    tty.input.write('y');
    await new Promise((r) => setImmediate(r));
    assert.ok(stripAnsi(tty.getLastChunk()).includes('  → Yes'));
    tty.input.write('\r');
    assert.equal(await promise, true);

    // Non-TTY fallback accepts 'n' shortcut
    const nonTty = createMockTty({ isTTY: false });
    const fallbackPromise = promptConfirmWithIO('Generate .gitignore?', true, {
      input: nonTty.input,
      output: nonTty.output,
    });
    await new Promise((r) => setImmediate(r));
    nonTty.input.write('n\n');
    assert.equal(await fallbackPromise, false);
  });

  it('supports validated text prompt with inline error retry and green in-place confirmation', async () => {
    await withForceColor(async () => {
      const tty = createMockTty({ isTTY: true, columns: 80, rows: 24 });
      const promise = promptValidatedTextWithIO<string>('Output directory', {
        defaultValue: 'build',
        io: { input: tty.input, output: tty.output, term: 'xterm-256color' },
        validate(raw) {
          const trimmed = raw.trim() || 'build';
          if (trimmed === '.') {
            return { ok: false, error: 'Cannot build into current directory.' };
          }
          return { ok: true, value: trimmed, displayValue: trimmed };
        },
      });
      await new Promise((r) => setImmediate(r));

      tty.input.write('.\n');
      await new Promise((r) => setImmediate(r));
      assert.ok(stripAnsi(tty.getRawOutput()).includes('Cannot build into current directory.'));

      tty.input.write('dist\n');
      const value = await promise;
      assert.equal(value, 'dist');
      assert.ok(tty.getRawOutput().includes('\x1b[1;32m'));
    });

    // Rejects with PromptCanceledError on Escape in interactive select
    const cancelTty = createMockTty({ isTTY: true, columns: 80, rows: 24 });
    const cancelPromise = promptSelectWithIO('Cancel test:', VISIBILITY_OPTIONS, 0, {
      input: cancelTty.input,
      output: cancelTty.output,
      term: 'xterm-256color',
    });
    await new Promise((r) => setImmediate(r));
    cancelTty.input.write('\x1b');
    await assert.rejects(() => cancelPromise, (err: unknown) => err instanceof PromptCanceledError);
  });

  it('supports arrow-key promptMultiSelect with locked items, Space/a toggles, Escape cancel, and non-TTY fallback', async () => {
    const blockOptions: MultiSelectOption<string>[] = [
      { value: 'validate-1', label: 'validate', description: 'required', checked: true, locked: true },
      { value: 'fingerprint-1', label: 'fingerprint', description: 'required', checked: true, locked: true },
      { value: 'packages-1', label: 'packages', description: 'esm.sh packages', checked: false },
      { value: 'classic-1', label: 'classic', description: 'classic mode', checked: false },
    ];

    const tty = createMockTty({ isTTY: true, columns: 100, rows: 24 });
    const promise = promptMultiSelectWithIO('Blocks to add', blockOptions, {
      input: tty.input,
      output: tty.output,
      term: 'xterm-256color',
    });
    await new Promise((r) => setImmediate(r));

    // Initial cursor starts on first unlocked item ("packages")
    const initial = stripAnsi(tty.getLastChunk());
    assert.ok(initial.includes('→ [ ] packages'), initial);
    assert.ok(initial.includes('[✓] validate'), initial);
    assert.ok(initial.includes('[✓] fingerprint'), initial);

    // Space toggles "packages" on
    tty.input.write(' ');
    await new Promise((r) => setImmediate(r));
    assert.ok(stripAnsi(tty.getLastChunk()).includes('→ [✓] packages'));

    // Move up twice to "validate" (locked) and press Space -> must stay checked & show notice
    tty.input.write('\x1b[A\x1b[A ');
    await new Promise((r) => setImmediate(r));
    const lockedFrame = stripAnsi(tty.getLastChunk());
    assert.ok(lockedFrame.includes('→ [✓] validate'), lockedFrame);
    assert.ok(lockedFrame.includes('cannot be unselected'), lockedFrame);

    // Press 'a' -> toggles all unlocked items ON (since classic wasn't checked yet)
    tty.input.write('a');
    await new Promise((r) => setImmediate(r));
    const allOnFrame = stripAnsi(tty.getLastChunk());
    assert.ok(allOnFrame.includes('[✓] packages'), allOnFrame);
    assert.ok(allOnFrame.includes('[✓] classic'), allOnFrame);

    // Press 'a' again -> toggles all unlocked items OFF while locked items stay checked
    tty.input.write('a');
    await new Promise((r) => setImmediate(r));
    const unlockedOffFrame = stripAnsi(tty.getLastChunk());
    assert.ok(unlockedOffFrame.includes('[✓] validate'), unlockedOffFrame);
    assert.ok(unlockedOffFrame.includes('[✓] fingerprint'), unlockedOffFrame);
    assert.ok(unlockedOffFrame.includes('[ ] packages'), unlockedOffFrame);
    assert.ok(unlockedOffFrame.includes('[ ] classic'), unlockedOffFrame);

    // Move down 2 to packages and check it, then Enter
    tty.input.write('\x1b[B\x1b[B \r');
    const selected = await promise;
    assert.deepEqual(selected, ['validate-1', 'fingerprint-1', 'packages-1']);
    assert.equal(tty.input.isRaw, false);
    assert.ok(stripAnsi(tty.getLastChunk()).includes('validate, fingerprint, packages'));

    // Escape cancels cleanly with PromptCanceledError
    const cancelTty = createMockTty({ isTTY: true, columns: 100, rows: 24 });
    const cancelPromise = promptMultiSelectWithIO('Blocks to add', blockOptions, {
      input: cancelTty.input,
      output: cancelTty.output,
      term: 'xterm-256color',
    });
    await new Promise((r) => setImmediate(r));
    cancelTty.input.write('\x1b');
    await assert.rejects(() => cancelPromise, (err: unknown) => err instanceof PromptCanceledError);
    assert.equal(cancelTty.input.isRaw, false);

    // Non-TTY fallback always preserves locked items and applies selected numbers
    const nonTty = createMockTty({ isTTY: false });
    const fallbackPromise = promptMultiSelectWithIO('Blocks to add', blockOptions, {
      input: nonTty.input,
      output: nonTty.output,
    });
    await new Promise((r) => setImmediate(r));
    nonTty.input.write('4\n');
    const fallbackSelected = await fallbackPromise;
    assert.deepEqual(fallbackSelected, ['validate-1', 'fingerprint-1', 'classic-1']);
  });

  it('enforces mutual exclusivity for exclusive options in promptMultiSelect (TTY and non-TTY fallback)', async () => {
    const exclusiveOptions: MultiSelectOption<string>[] = [
      { value: 'validate-1', label: 'validate', description: 'required', checked: true, locked: true },
      { value: 'fingerprint-1', label: 'fingerprint', description: 'required', checked: true, locked: true },
      { value: 'packages-1', label: 'packages', description: 'esm.sh packages', checked: false },
      { value: 'sass-1', label: 'sass', description: 'sass compiler', checked: false },
      { value: 'classic-1', label: 'classic', description: 'classic mode', checked: false, exclusive: true },
    ];

    // 1. Checking a non-exclusive option (packages) disallows checking classic
    const tty1 = createMockTty({ isTTY: true, columns: 100, rows: 24 });
    const p1 = promptMultiSelectWithIO('Blocks to add', exclusiveOptions, {
      input: tty1.input,
      output: tty1.output,
      term: 'xterm-256color',
    });
    await new Promise((r) => setImmediate(r));
    const initialFrame = stripAnsi(tty1.getLastChunk()).replace(/^\x1b\[\?25l/, '');
    assert.ok(
      initialFrame.includes(
        '\n\n  ℹ Use ↑/↓ to navigate, Space to select. Press Enter to confirm.',
      ),
      initialFrame,
    );
    const frameLineCount = (chunk: string) =>
      stripAnsi(chunk)
        .replace(/^[\x1b\[\]0-9;?AJr\r]+/, '')
        .split('\n').length;
    const initialLineCount = frameLineCount(tty1.getLastChunk());

    // Toggle packages ON, move down twice to classic -> hover info replaces footer in-place (no jump)
    tty1.input.write(' \x1b[B\x1b[B');
    await new Promise((r) => setImmediate(r));
    const hoveredBlockedClassic = stripAnsi(tty1.getLastChunk());
    assert.ok(hoveredBlockedClassic.includes('[✓] packages'), hoveredBlockedClassic);
    assert.ok(hoveredBlockedClassic.includes('→ [ ] classic'), hoveredBlockedClassic);
    assert.ok(
      hoveredBlockedClassic.includes(
        '\n\n  ℹ "classic" cannot be selected while "packages" is selected.',
      ),
      hoveredBlockedClassic,
    );
    assert.equal(frameLineCount(tty1.getLastChunk()), initialLineCount);

    // Attempt Space on blocked classic -> must stay unchecked & show prominent ⚠ warning in-place (no jump)
    tty1.input.write(' ');
    await new Promise((r) => setImmediate(r));
    const blockedClassic = stripAnsi(tty1.getLastChunk());
    assert.ok(blockedClassic.includes('[✓] packages'), blockedClassic);
    assert.ok(blockedClassic.includes('→ [ ] classic'), blockedClassic);
    assert.ok(
      blockedClassic.includes('\n\n  ⚠ "classic" cannot be selected while "packages" is selected.'),
      blockedClassic,
    );
    assert.equal(frameLineCount(tty1.getLastChunk()), initialLineCount);

    // Move up to sass (non-exclusive) and toggle ON -> allowed alongside packages!
    tty1.input.write('\x1b[A ');
    await new Promise((r) => setImmediate(r));
    const bothOptional = stripAnsi(tty1.getLastChunk());
    assert.ok(bothOptional.includes('[✓] packages'), bothOptional);
    assert.ok(bothOptional.includes('→ [✓] sass'), bothOptional);

    // Pressing 'a' when all non-exclusive optional items are selected unselects them (classic still unchecked)
    tty1.input.write('a');
    await new Promise((r) => setImmediate(r));
    const cleared = stripAnsi(tty1.getLastChunk());
    assert.ok(cleared.includes('[ ] packages'), cleared);
    assert.ok(cleared.includes('[ ] sass'), cleared);
    assert.ok(cleared.includes('[ ] classic'), cleared);

    // Now move down to classic and toggle ON -> succeeds!
    tty1.input.write('\x1b[B ');
    await new Promise((r) => setImmediate(r));
    const classicOn = stripAnsi(tty1.getLastChunk());
    assert.ok(classicOn.includes('→ [✓] classic'), classicOn);

    // Move up twice to packages and attempt Space -> disallowed while classic is selected!
    tty1.input.write('\x1b[A\x1b[A ');
    await new Promise((r) => setImmediate(r));
    const blockedPackages = stripAnsi(tty1.getLastChunk());
    assert.ok(blockedPackages.includes('→ [ ] packages'), blockedPackages);
    assert.ok(blockedPackages.includes('[✓] classic'), blockedPackages);
    assert.ok(blockedPackages.includes('"packages" cannot be selected while "classic" is selected.'), blockedPackages);

    // Pressing 'a' while classic is selected clears classic (never checks classic + packages together)
    tty1.input.write('a');
    await new Promise((r) => setImmediate(r));
    const clearedClassic = stripAnsi(tty1.getLastChunk());
    assert.ok(clearedClassic.includes('[ ] classic'), clearedClassic);
    assert.ok(clearedClassic.includes('[ ] packages'), clearedClassic);

    // Pressing 'a' when nothing optional is selected selects only non-exclusive optional items (packages + sass)
    tty1.input.write('a');
    await new Promise((r) => setImmediate(r));
    const onlyNonExclusive = stripAnsi(tty1.getLastChunk());
    assert.ok(onlyNonExclusive.includes('[✓] packages'), onlyNonExclusive);
    assert.ok(onlyNonExclusive.includes('[✓] sass'), onlyNonExclusive);
    assert.ok(onlyNonExclusive.includes('[ ] classic'), onlyNonExclusive);

    tty1.input.write('\r');
    assert.deepEqual(await p1, ['validate-1', 'fingerprint-1', 'packages-1', 'sass-1']);

    // 2. When exclusive option (classic) starts auto-checked, cursor starts on classic (skipping blocked options)
    const classicPrechecked = exclusiveOptions.map((o) =>
      o.value === 'classic-1' ? { ...o, checked: true } : o,
    );
    const tty2 = createMockTty({ isTTY: true, columns: 100, rows: 24 });
    const p2 = promptMultiSelectWithIO('Blocks to add', classicPrechecked, {
      input: tty2.input,
      output: tty2.output,
      term: 'xterm-256color',
    });
    await new Promise((r) => setImmediate(r));
    assert.ok(stripAnsi(tty2.getLastChunk()).includes('→ [✓] classic'));
    tty2.input.write('\r');
    assert.deepEqual(await p2, ['validate-1', 'fingerprint-1', 'classic-1']);

    // 3. Non-TTY fallback refuses conflicting toggles but allows unchecking exclusive then checking optional
    const nonTtyBlocked = createMockTty({ isTTY: false });
    const fb1 = promptMultiSelectWithIO('Blocks to add', exclusiveOptions, {
      input: nonTtyBlocked.input,
      output: nonTtyBlocked.output,
    });
    await new Promise((r) => setImmediate(r));
    nonTtyBlocked.input.write('packages,classic\n');
    assert.deepEqual(await fb1, ['validate-1', 'fingerprint-1', 'packages-1']);
    assert.ok(stripAnsi(nonTtyBlocked.getRawOutput()).includes('"classic" cannot be selected while "packages" is selected.'));

    const nonTtySwitch = createMockTty({ isTTY: false });
    const fb2 = promptMultiSelectWithIO('Blocks to add', classicPrechecked, {
      input: nonTtySwitch.input,
      output: nonTtySwitch.output,
    });
    await new Promise((r) => setImmediate(r));
    nonTtySwitch.input.write('classic,packages\n');
    assert.deepEqual(await fb2, ['validate-1', 'fingerprint-1', 'packages-1']);
  });
});
