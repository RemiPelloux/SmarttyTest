/**
 * The smallest `vscode` module the host-side code needs to run under Vitest
 * (aliased in vitest.config.ts). Tests drive it through `stub`: the active
 * editor, the workspace folders, settings, trust and the messages shown.
 */
import { pathToFileURL } from "node:url";

type Listener<T> = (value: T) => unknown;

export class Disposable {
  readonly #onDispose: () => void;
  constructor(onDispose: () => void) {
    this.#onDispose = onDispose;
  }
  dispose(): void {
    this.#onDispose();
  }
}

export class EventEmitter<T> {
  readonly #listeners = new Set<Listener<T>>();
  readonly event = (listener: Listener<T>): Disposable => {
    this.#listeners.add(listener);
    return new Disposable(() => this.#listeners.delete(listener));
  };
  fire(value: T): void {
    for (const listener of [...this.#listeners]) listener(value);
  }
  dispose(): void {
    this.#listeners.clear();
  }
}

export class Uri {
  readonly scheme = "file";
  readonly fsPath: string;
  readonly path: string;
  private constructor(fsPath: string) {
    this.fsPath = fsPath;
    this.path = fsPath;
  }
  static file(path: string): Uri {
    return new Uri(path);
  }
  toString(): string {
    return pathToFileURL(this.fsPath).toString();
  }
}

export enum ExtensionMode {
  Production = 1,
  Development = 2,
  Test = 3,
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

export class MarkdownString {
  constructor(readonly value = "") {}
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;
export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;
export const ViewColumn = { Beside: -2 } as const;
export const SymbolKind = {
  Module: 1,
  Namespace: 2,
  Class: 4,
  Method: 5,
  Property: 6,
  Field: 7,
  Constructor: 8,
  Interface: 10,
  Function: 11,
  Variable: 12,
  Constant: 13,
} as const;

export class TreeItem {
  description?: string;
  tooltip?: unknown;
  iconPath?: unknown;
  resourceUri?: Uri;
  contextValue?: string;
  command?: unknown;
  constructor(
    readonly label: string,
    readonly collapsibleState: number,
  ) {}
}

export class StatusBarItem {
  name = "";
  text = "";
  tooltip: unknown;
  command: unknown;
  backgroundColor: unknown;
  visible = false;
  show(): void {
    this.visible = true;
  }
  hide(): void {
    this.visible = false;
  }
  dispose(): void {
    this.visible = false;
  }
}

export interface StubFolder {
  readonly uri: Uri;
  readonly name: string;
  readonly index: number;
}

export interface Message {
  readonly level: "info" | "warning" | "error";
  readonly text: string;
}

const workspaceFoldersChanged = new EventEmitter<void>();
const documentSaved = new EventEmitter<{ readonly uri: Uri }>();

/** Mutable state the tests set up and read back. */
export const stub = {
  trusted: true,
  folders: [] as StubFolder[],
  settings: {} as Record<string, unknown>,
  activeDocument: undefined as { readonly uri: Uri } | undefined,
  statusItems: [] as StatusBarItem[],
  messages: [] as Message[],
  output: [] as string[],
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  folder(path: string): StubFolder {
    const folder = { uri: Uri.file(path), name: path, index: stub.folders.length };
    stub.folders.push(folder);
    return folder;
  },
  setFolders(folders: StubFolder[]): void {
    stub.folders = folders;
    workspaceFoldersChanged.fire();
  },
  save(uri: Uri): void {
    documentSaved.fire({ uri });
  },
  reset(): void {
    stub.trusted = true;
    stub.folders = [];
    stub.settings = {};
    stub.activeDocument = undefined;
    stub.statusItems = [];
    stub.messages = [];
    stub.output = [];
    stub.commands.clear();
  },
};

const none = (): Disposable => new Disposable(() => {});

function message(level: Message["level"]) {
  return (text: string): Promise<undefined> => {
    stub.messages.push({ level, text });
    return Promise.resolve(undefined);
  };
}

export const window = {
  get activeTextEditor() {
    return stub.activeDocument ? { document: stub.activeDocument } : undefined;
  },
  createStatusBarItem(): StatusBarItem {
    const item = new StatusBarItem();
    stub.statusItems.push(item);
    return item;
  },
  createOutputChannel() {
    return {
      appendLine: (line: string) => stub.output.push(line),
      show: () => {},
      dispose: () => {},
    };
  },
  createTreeView: () => ({ dispose: () => {} }),
  onDidChangeActiveTextEditor: none,
  showInformationMessage: message("info"),
  showWarningMessage: message("warning"),
  showErrorMessage: message("error"),
  async withProgress<T>(
    _options: unknown,
    task: (
      progress: { report(value: unknown): void },
      token: { isCancellationRequested: boolean; onCancellationRequested: () => Disposable },
    ) => Promise<T>,
  ): Promise<T> {
    return await task(
      { report: () => {} },
      { isCancellationRequested: false, onCancellationRequested: none },
    );
  },
};

export const workspace = {
  get isTrusted() {
    return stub.trusted;
  },
  get workspaceFolders() {
    return stub.folders;
  },
  getWorkspaceFolder(uri: Uri): StubFolder | undefined {
    return stub.folders.find(
      (folder) =>
        uri.fsPath === folder.uri.fsPath ||
        uri.fsPath.startsWith(`${folder.uri.fsPath}/`) ||
        uri.fsPath.startsWith(`${folder.uri.fsPath}\\`),
    );
  },
  getConfiguration() {
    return { get: (key: string) => stub.settings[key] };
  },
  onDidChangeWorkspaceFolders: workspaceFoldersChanged.event,
  onDidSaveTextDocument: documentSaved.event,
  createFileSystemWatcher() {
    return { onDidCreate: none, onDidChange: none, onDidDelete: none, dispose: () => {} };
  },
  onDidGrantWorkspaceTrust: none,
  onDidChangeConfiguration: none,
  asRelativePath: (uri: Uri) => uri.fsPath,
  openTextDocument: async (uri: Uri) => ({ uri }),
};

export const languages = {
  registerCodeLensProvider: none,
  registerHoverProvider: none,
};

export const commands = {
  registerCommand(id: string, handler: (...args: unknown[]) => unknown): Disposable {
    stub.commands.set(id, handler);
    return new Disposable(() => stub.commands.delete(id));
  },
  async executeCommand(): Promise<undefined> {
    return undefined;
  },
};
