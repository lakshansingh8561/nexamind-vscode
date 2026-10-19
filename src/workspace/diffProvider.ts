import * as vscode from "vscode";

export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  public static readonly scheme = "nexamind-diff";

  private contentMap = new Map<string, string>();
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this._onDidChange.event;

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contentMap.get(uri.toString()) || "";
  }

  public setContent(uri: vscode.Uri, content: string): void {
    this.contentMap.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }

  public removeContent(uri: vscode.Uri): void {
    this.contentMap.delete(uri.toString());
  }

  public getProposedUri(editId: string, filePath: string): vscode.Uri {
    const cleanName = filePath.replace(/[/\\:]/g, "_");
    return vscode.Uri.parse(`${DiffContentProvider.scheme}://proposal/${editId}/${cleanName}`);
  }
}
