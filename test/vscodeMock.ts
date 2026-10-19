export const workspace = {
  workspaceFolders: undefined as any,
  textDocuments: [] as any[],
  getWorkspaceFolder: (uri: any) => ({ uri: { fsPath: uri?.fsPath ? uri.fsPath.split("/").slice(0, 3).join("/") : "C:\\mock\\workspace" } }),
  fs: {
    stat: async () => ({ type: 1, size: 100 }),
    readFile: async () => new Uint8Array(),
  },
  openTextDocument: async () => ({
    getText: () => "",
    positionAt: () => ({ line: 0, character: 0 }),
    save: async () => true,
    lineCount: 1,
  }),
  applyEdit: async () => true,
  asRelativePath: (uri: any) => uri?.fsPath || "",
  getConfiguration: (_section?: string) => ({
    get: (key: string, defaultValue?: any) => defaultValue,
    update: async () => {},
  }),
};

export const Uri = {
  file: (fsPath: string) => ({
    fsPath,
    scheme: "file",
    toString: () => `file:///${fsPath.replace(/\\/g, "/")}`,
  }),
  parse: (str: string) => ({
    fsPath: str,
    scheme: "nexamind-diff",
    toString: () => str,
  }),
};

export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
};

export const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
};

export const Range = class {
  constructor(public start: any, public end: any) {}
};

export const Position = class {
  constructor(public line: number, public character: number) {}
};

export const WorkspaceEdit = class {
  public replace() {}
  public createFile() {}
  public insert() {}
};

export const EventEmitter = class {
  private listeners: any[] = [];
  public event = (listener: any) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };
  public fire(data?: any) {
    for (const listener of this.listeners) {
      try {
        listener(data);
      } catch {}
    }
  }
};

export const commands = {
  executeCommand: async () => {},
};

export const window = {
  activeTextEditor: undefined as any,
  visibleTextEditors: [] as any[],
  showInformationMessage: async () => {},
  showWarningMessage: async () => {},
  showErrorMessage: async () => {},
  showOpenDialog: async () => undefined,
  onDidChangeActiveTextEditor: (listener?: any) => ({ dispose: () => {} }),
  onDidChangeVisibleTextEditors: (listener?: any) => ({ dispose: () => {} }),
};

