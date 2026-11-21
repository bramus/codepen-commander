export interface CommandOutput {
  log: (message?: string) => void;
  error: (message?: string) => void;
  write: (chunk: string) => void;
}

export const defaultOutput: CommandOutput = {
  log(message = '') {
    console.log(message);
  },
  error(message = '') {
    console.error(message);
  },
  write(chunk: string) {
    process.stdout.write(chunk);
  },
};

export function createSilentOutput(): CommandOutput {
  return {
    log: () => {},
    error: () => {},
    write: () => {},
  };
}

export interface BufferedOutput extends CommandOutput {
  stdoutLines: string[];
  stderrLines: string[];
  stdout: () => string;
  stderr: () => string;
}

export function createBufferedOutput(): BufferedOutput {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    log(message = '') {
      stdoutLines.push(message);
    },
    error(message = '') {
      stderrLines.push(message);
    },
    write(chunk: string) {
      stdoutLines.push(chunk);
    },
    stdoutLines,
    stderrLines,
    stdout: () => stdoutLines.join('\n'),
    stderr: () => stderrLines.join('\n'),
  };
}
