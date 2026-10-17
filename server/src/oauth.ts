import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthOpslag } from "./oauth-opslag.js";

/**
 * OAuth-autorisatieserver voor het MCP-endpoint, zodat claude.ai kan koppelen.
 *
 * De SDK doet het protocolwerk (metadata, registratie, PKCE-controle, foutvorm);
 * deze klasse beslist wie wat krijgt. De toestemming zelf geeft een mens op
 * core: `authorize` stuurt de browser daarheen en `/oauth/terug` op het
 * MCP-proces maakt pas een code als core het besluit heeft vastgelegd.
 *
 * Wat een token oplevert is precies wat de vaste bearer token al gaf: lezen en
 * voorstellen in de wachtrij zetten. Globe is langs deze weg alleen leesbaar.
 */

export const SCOPE = "globe";

export interface OAuthInstellingen {
  /** Het MCP-endpoint zelf, bv. https://…/mcp — de "resource" in RFC 8707. */
  resourceUrl: URL;
  /** Publieke basis-URL van core, waar het toestemmingsscherm staat. */
  coreUrl: URL; // hier: deze service zelf
  /** Redirect-URI's die een client mag registreren. */
  toegestaneRedirects: string[];
  /** Ook http://localhost:<poort>/… toestaan (Claude Code, MCP Inspector). */
  loopbackToestaan: boolean;
  verzoekGeldigMs?: number;
  codeGeldigMs?: number;
  accessGeldigMs?: number;
  refreshGeldigMs?: number;
}

const MINUUT = 60_000;

export class GlobeOAuth implements OAuthServerProvider {
  private readonly verzoekMs: number;
  private readonly codeMs: number;
  private readonly accessMs: number;
  private readonly refreshMs: number;

  constructor(
    private readonly opslag: OAuthOpslag,
    private readonly cfg: OAuthInstellingen,
  ) {
    this.verzoekMs = cfg.verzoekGeldigMs ?? 10 * MINUUT;
    this.codeMs = cfg.codeGeldigMs ?? 5 * MINUUT;
    this.accessMs = cfg.accessGeldigMs ?? 60 * MINUUT;
    this.refreshMs = cfg.refreshGeldigMs ?? 30 * 24 * 60 * MINUUT;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.opslag.clientOphalen(id),
      registerClient: async (client) => {
        // Registratie is open (dat eist claude.ai), dus de redirect-URI is de
        // grendel: een code kan alleen terechtkomen op een adres dat hier
        // vooraf is toegestaan. Een vreemde client krijgt nooit iets in handen,
        // ook niet als Jan per ongeluk op "toestaan" klikt.
        const fout = client.redirect_uris.find((u) => !this.redirectToegestaan(String(u)));
        if (fout) {
          throw new InvalidClientMetadataError(`redirect_uri niet toegestaan: ${fout}`);
        }
        const info = client as OAuthClientInformationFull;
        await this.opslag.clientOpslaan(info);
        return info;
      },
    };
  }

  redirectToegestaan(uri: string): boolean {
    if (this.cfg.toegestaneRedirects.includes(uri)) return true;
    if (!this.cfg.loopbackToestaan) return false;
    try {
      const u = new URL(uri);
      return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    } catch {
      return false;
    }
  }

  /** RFC 8707: een token is alleen voor dit endpoint, niet voor iets anders. */
  private controleerResource(resource: URL | undefined): string | null {
    if (!resource) return null;
    const gevraagd = resource.href.replace(/\/+$/, "");
    const eigen = this.cfg.resourceUrl.href.replace(/\/+$/, "");
    // De origin alleen accepteren we ook; sommige clients sturen die in plaats
    // van het volledige pad.
    if (gevraagd !== eigen && gevraagd !== this.cfg.resourceUrl.origin) {
      throw new InvalidTargetError(`Onbekende resource: ${resource.href}`);
    }
    return eigen;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const resource = this.controleerResource(params.resource);
    // Er is één bevoegdheid. Wat de client verder vraagt negeren we liever dan
    // dat we weigeren: dat houdt claude.ai werkend als het later iets extra's
    // meestuurt, en het levert nooit meer op dan "globe".
    const id = await this.opslag.verzoekMaken(
      {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        state: params.state ?? null,
        codeChallenge: params.codeChallenge,
        scopes: [SCOPE],
        resource,
      },
      this.verzoekMs,
    );
    const doel = new URL("/oauth/toestemming", this.cfg.coreUrl);
    doel.searchParams.set("verzoek", id);
    res.redirect(302, doel.href);
  }

  /**
   * Afronding na het besluit op core. Geeft de URL terug waar de browser heen
   * moet, of null als het verzoek onbekend, verlopen of al gebruikt is.
   */
  async afronden(verzoekId: string): Promise<string | null> {
    const v = await this.opslag.verzoekAfhandelen(verzoekId);
    if (!v) return null;

    const terug = new URL(v.redirectUri);
    if (v.besluit === "geweigerd") {
      terug.searchParams.set("error", "access_denied");
      terug.searchParams.set("error_description", "Toestemming geweigerd.");
    } else {
      terug.searchParams.set("code", await this.opslag.codeMaken(v, this.codeMs));
    }
    if (v.state) terug.searchParams.set("state", v.state);
    return terug.href;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const challenge = await this.opslag.codeChallenge(code, client.client_id);
    if (!challenge) throw new InvalidGrantError("Ongeldige of verlopen code.");
    return challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const rij = await this.opslag.codeInwisselen(code, client.client_id);
    if (!rij) throw new InvalidGrantError("Ongeldige, verlopen of al gebruikte code.");
    if (redirectUri !== undefined && redirectUri !== rij.redirectUri) {
      // De code is nu verbruikt; dat is de bedoeling bij een mismatch.
      throw new InvalidGrantError("redirect_uri wijkt af van het autorisatieverzoek.");
    }
    if (resource) this.controleerResource(resource);
    return this.uitgeven(rij);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const rij = await this.opslag.refreshInwisselen(refreshToken, client.client_id);
    if (!rij) throw new InvalidGrantError("Ongeldig, verlopen of ingetrokken refresh token.");
    if (resource) this.controleerResource(resource);
    return this.uitgeven(rij);
  }

  private async uitgeven(
    rij: { clientId: string; familie: string; scopes: string[]; resource: string | null },
  ): Promise<OAuthTokens> {
    const t = await this.opslag.tokensUitgeven(rij, this.accessMs, this.refreshMs);
    return {
      access_token: t.accessToken,
      token_type: "bearer",
      expires_in: t.expiresIn,
      refresh_token: t.refreshToken,
      scope: rij.scopes.join(" "),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rij = await this.opslag.accessControleren(token);
    if (!rij) throw new InvalidTokenError("Ongeldige of verlopen token.");
    return {
      token,
      clientId: rij.clientId,
      scopes: rij.scopes,
      expiresAt: Math.floor(rij.verlooptOp.getTime() / 1000),
      resource: rij.resource ? new URL(rij.resource) : undefined,
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.opslag.tokenIntrekken(request.token, client.client_id);
  }
}
