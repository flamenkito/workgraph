import * as blessed from 'blessed';

export interface RunningTask {
  id: string;
  name: string;
  pid: number;
  status: 'running' | 'stopped' | 'error';
  startTime: number;
  endTime: number;
  port: number;
}

export interface UI {
  screen: blessed.Widgets.Screen;
  tasksPane: blessed.Widgets.BoxElement;
  leftPane: blessed.Widgets.Log;
  rightPane: blessed.Widgets.Log;
  log: (message: string) => void;
  taskLog: (message: string) => void;
  setStatus: (status: string | null) => void;
  addTask: (task: Omit<RunningTask, 'startTime' | 'endTime' | 'port'>) => void;
  updateTask: (id: string, status: RunningTask['status']) => void;
  updateTaskPort: (id: string, port: number) => void;
  removeTask: (id: string) => void;
  destroy: () => void;
}

export function createUI(): UI {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'Workgraph',
  });

  // Tasks pane - running tasks list (leftmost)
  const tasksPane = blessed.box({
    parent: screen,
    label: ' Tasks ',
    left: 0,
    top: 0,
    width: '15%',
    height: '100%',
    border: { type: 'line' },
    style: {
      border: { fg: 'green' },
      label: { fg: 'green', bold: true },
    },
    padding: { left: 1 },
    tags: true,
  });

  // Track running tasks
  const tasks: Map<string, RunningTask> = new Map();

  const renderTasks = (): void => {
    const taskList = [...tasks.values()];

    // Sort: running tasks on top (by startTime desc - longer running higher),
    // then stopped/error tasks (by endTime desc - more recent higher)
    taskList.sort((a, b) => {
      if (a.status === 'running' && b.status !== 'running') return -1;
      if (a.status !== 'running' && b.status === 'running') return 1;
      if (a.status === 'running' && b.status === 'running') {
        // Both running: longer running (earlier start) goes higher
        return a.startTime - b.startTime;
      }
      // Both stopped/error: more recently quit goes higher
      return b.endTime - a.endTime;
    });

    const lines: string[] = [];
    for (const task of taskList) {
      let statusIcon: string;
      let statusColor: string;
      switch (task.status) {
        case 'running':
          statusIcon = '●';
          statusColor = 'green';
          break;
        case 'stopped':
          statusIcon = '○';
          statusColor = 'gray';
          break;
        case 'error':
          statusIcon = '✖';
          statusColor = 'red';
          break;
      }
      const portStr = task.port > 0 ? ` {cyan-fg}:${task.port}{/}` : '';
      lines.push(`{${statusColor}-fg}${statusIcon}{/} ${task.name}${portStr}`);
    }
    tasksPane.setContent(lines.join('\n'));
    screen.render();
  };

  // Middle pane - workgraph status
  const leftPane = blessed.log({
    parent: screen,
    label: ' Workgraph ',
    left: '15%',
    top: 0,
    width: '40%',
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
    left: '55%',
    top: 0,
    width: '45%',
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

  // Handle quit - emit SIGINT to trigger CLI's cleanup handler
  screen.key(['C-c'], () => {
    process.emit('SIGINT', 'SIGINT');
  });

  // Tab to switch focus between panes
  let focusedPane: 'tasks' | 'left' | 'right' = 'left';
  screen.key(['tab'], () => {
    switch (focusedPane) {
      case 'tasks':
        leftPane.focus();
        focusedPane = 'left';
        break;
      case 'left':
        rightPane.focus();
        focusedPane = 'right';
        break;
      case 'right':
        tasksPane.focus();
        focusedPane = 'tasks';
        break;
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

  const addTask = (task: Omit<RunningTask, 'startTime' | 'endTime' | 'port'>): void => {
    tasks.set(task.id, { ...task, startTime: Date.now(), endTime: 0, port: 0 });
    renderTasks();
  };

  const updateTaskPort = (id: string, port: number): void => {
    const task = tasks.get(id);
    if (task && task.port === 0) {
      task.port = port;
      renderTasks();
    }
  };

  const updateTask = (id: string, status: RunningTask['status']): void => {
    const task = tasks.get(id);
    if (task) {
      task.status = status;
      if (status !== 'running') {
        task.endTime = Date.now();
      }
      renderTasks();
    }
  };

  const removeTask = (id: string): void => {
    tasks.delete(id);
    renderTasks();
  };

  return {
    screen,
    tasksPane,
    leftPane,
    rightPane,
    log,
    taskLog,
    setStatus,
    addTask,
    updateTask,
    updateTaskPort,
    removeTask,
    destroy,
  };
}

// Detect port number from output line
// Matches common patterns like:
// - "listening on port 3000"
// - "http://localhost:3000"
// - "Server running at http://127.0.0.1:5173"
// - "Local: http://localhost:4200/"
export function detectPort(line: string): number {
  // Pattern 1: "port 3000" or "port: 3000" or "port=3000"
  const portPattern = /\bport[ :=]*(\d{2,5})\b/i;
  const portMatch = portPattern.exec(line);
  if (portMatch) {
    return parseInt(portMatch[1]!, 10);
  }

  // Pattern 2: URLs like "http://localhost:3000" or "http://127.0.0.1:5173"
  const urlPattern = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{2,5})/i;
  const urlMatch = urlPattern.exec(line);
  if (urlMatch) {
    return parseInt(urlMatch[1]!, 10);
  }

  return 0;
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
