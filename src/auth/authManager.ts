import * as vscode from "vscode";
import { NexamindClient, NexamindApiError } from "../api/nexamindClient.js";
import { User, TokenBalance } from "../types.js";

export interface AuthStateChangeEvent {
  authenticated: boolean;
  user?: User;
  tokenBalance?: TokenBalance;
}

export class AuthManager {
  private static readonly TOKEN_SECRET_KEY = "nexamind.jwt_token";
  private secrets: vscode.SecretStorage;
  private client: NexamindClient;
  private cachedUser: User | null = null;
  private cachedTokenBalance: TokenBalance | null = null;

  private _onAuthStateChanged = new vscode.EventEmitter<AuthStateChangeEvent>();
  public readonly onAuthStateChanged = this._onAuthStateChanged.event;

  constructor(context: vscode.ExtensionContext, client: NexamindClient) {
    this.secrets = context.secrets;
    this.client = client;
  }

  public async getToken(): Promise<string | undefined> {
    return await this.secrets.get(AuthManager.TOKEN_SECRET_KEY);
  }

  public getCachedUser(): User | null {
    return this.cachedUser;
  }

  public getCachedTokenBalance(): TokenBalance | null {
    return this.cachedTokenBalance;
  }

  public async login(email: string, password: string): Promise<User> {
    const authData = await this.client.login(email, password);
    await this.secrets.store(AuthManager.TOKEN_SECRET_KEY, authData.token);
    this.cachedUser = authData.user;

    // Attempt to pre-fetch token balance
    try {
      this.cachedTokenBalance = await this.client.getTokenBalance(authData.token);
    } catch {
      this.cachedTokenBalance = null;
    }

    this._onAuthStateChanged.fire({
      authenticated: true,
      user: this.cachedUser,
      tokenBalance: this.cachedTokenBalance || undefined,
    });

    return this.cachedUser;
  }

  public async logout(): Promise<void> {
    await this.secrets.delete(AuthManager.TOKEN_SECRET_KEY);
    this.cachedUser = null;
    this.cachedTokenBalance = null;

    this._onAuthStateChanged.fire({
      authenticated: false,
    });
  }

  public async refreshTokenBalance(): Promise<TokenBalance | null> {
    const token = await this.getToken();
    if (!token) return null;

    try {
      this.cachedTokenBalance = await this.client.getTokenBalance(token);
      return this.cachedTokenBalance;
    } catch {
      return null;
    }
  }

  public async validateSession(): Promise<{ authenticated: boolean; user?: User; tokenBalance?: TokenBalance }> {
    const token = await this.getToken();
    if (!token) {
      this.cachedUser = null;
      this.cachedTokenBalance = null;
      return { authenticated: false };
    }

    try {
      const user = await this.client.getMe(token);
      this.cachedUser = user;

      try {
        this.cachedTokenBalance = await this.client.getTokenBalance(token);
      } catch {
        this.cachedTokenBalance = null;
      }

      this._onAuthStateChanged.fire({
        authenticated: true,
        user: this.cachedUser,
        tokenBalance: this.cachedTokenBalance || undefined,
      });

      return {
        authenticated: true,
        user: this.cachedUser,
        tokenBalance: this.cachedTokenBalance || undefined,
      };
    } catch (err: any) {
      if (err instanceof NexamindApiError && err.isAuthError) {
        // Expired or invalid token: clean up
        await this.logout();
      }
      return { authenticated: false };
    }
  }
}
