import * as blessed from 'blessed';

export interface UI {
  screen: blessed.Widgets.Screen;
  leftPane: blessed.Widgets.Log;
  rightPane: blessed.Widgets.Log;
  log: (message: string) => void;
  taskLog: (message: string) => void;
  setStatus: (status: string | null) => void;
  destroy: () => void;
}

export function createUI(): UI {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'Workgraph',
  });

  // Left pane - workgraph status
  const leftPane = blessed.log({
    parent: screen,
    label: ' Workgraph ',
    left: 0,
    top: 0,
    width: '50%',
    height: '100%',
    border: { type: 'line' },
    style: {
      border: { fg: 'cyan' },
      label: { fg: 'cyan', bold: true },
    },
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: ' ',
      style: { bg: 'cyan' },
    },
    mouse: true,
    keys: true,
    tags: true,
  });

  // Right pane - task output
  const rightPane = blessed.log({
    parent: screen,
    label: ' Task Output ',
    left: '50%',
    top: 0,
    width: '50%',
    height: '100%',
    border: { type: 'line' },
    style: {
      border: { fg: 'yellow' },
      label: { fg: 'yellow', bold: true },
    },
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: ' ',
      style: { bg: 'yellow' },
    },
    mouse: true,
    keys: true,
    tags: true,
  });

  // Handle quit
  screen.key(['C-c'], () => {
    screen.destroy();
    process.exit(0);
  });

  // Tab to switch focus between panes
  let focusedPane: 'left' | 'right' = 'left';
  screen.key(['tab'], () => {
    if (focusedPane === 'left') {
      rightPane.focus();
      focusedPane = 'right';
    } else {
      leftPane.focus();
      focusedPane = 'left';
    }
    screen.render();
  });

  screen.render();

  const formatTimestamp = (): string => {
    const now = new Date();
    return now.toLocaleTimeString('en-US', { hour12: false });
  };

  const log = (message: string): void => {
    const converted = convertAnsiToBlessed(message);
    leftPane.log(`[${formatTimestamp()}] ${converted}`);
    screen.render();
  };

  const taskLog = (message: string): void => {
    const converted = convertAnsiToBlessed(message);
    rightPane.log(converted);
    screen.render();
  };

  const setStatus = (status: string | null): void => {
    if (status) {
      leftPane.setLabel(` Workgraph ─ ${status} `);
    } else {
      leftPane.setLabel(' Workgraph ');
    }
    screen.render();
  };

  const destroy = (): void => {
    screen.destroy();
  };

  return {
    screen,
    leftPane,
    rightPane,
    log,
    taskLog,
    setStatus,
    destroy,
  };
}

// Convert ANSI escape codes to blessed tags
function convertAnsiToBlessed(text: string): string {
  const ESC = '\x1b';
  return text
    // Colors
    .replace(new RegExp(`${ESC}\\[31m`, 'g'), '{red-fg}')
    .replace(new RegExp(`${ESC}\\[32m`, 'g'), '{green-fg}')
    .replace(new RegExp(`${ESC}\\[33m`, 'g'), '{yellow-fg}')
    .replace(new RegExp(`${ESC}\\[34m`, 'g'), '{blue-fg}')
    .replace(new RegExp(`${ESC}\\[35m`, 'g'), '{magenta-fg}')
    .replace(new RegExp(`${ESC}\\[36m`, 'g'), '{cyan-fg}')
    .replace(new RegExp(`${ESC}\\[37m`, 'g'), '{white-fg}')
    // Reset
    .replace(new RegExp(`${ESC}\\[0m`, 'g'), '{/}')
    // Remove any other escape sequences
    .replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
}
