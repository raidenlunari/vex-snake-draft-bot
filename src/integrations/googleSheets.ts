import { createSign } from 'node:crypto';
import fs from 'node:fs';

/** Minimal interface the sync service needs; implemented for Google and faked in tests. */
export interface RangeValues {
  /** A1 range without the tab name, e.g. "C4:F28". */
  range: string;
  values: string[][];
}

export interface SheetsClient {
  /** Replaces the whole tab with `values` (creating the tab if it does not exist). */
  writeTab(spreadsheetId: string, tab: string, values: string[][]): Promise<void>;
  /** Reads every value on a tab (empty array if the tab does not exist). */
  readTab(spreadsheetId: string, tab: string): Promise<string[][]>;
  /** Writes several ranges and clears others, leaving formatting untouched. */
  updateRanges(spreadsheetId: string, tab: string, writes: RangeValues[], clears: string[]): Promise<void>;
  /** Spreadsheet title, used to confirm access when a sheet is configured. */
  describe(spreadsheetId: string): Promise<{ title: string; tabs: string[] }>;
  readonly serviceAccountEmail: string;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export class GoogleSheetsError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'GoogleSheetsError';
  }
}

export function loadServiceAccountKey(opts: { file?: string; json?: string }): ServiceAccountKey | null {
  const raw = opts.json ?? (opts.file ? fs.readFileSync(opts.file, 'utf8') : null);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<ServiceAccountKey>;
  if (!parsed.client_email || !parsed.private_key) throw new Error('Google service account key must contain client_email and private_key');
  return { client_email: parsed.client_email, private_key: parsed.private_key, token_uri: parsed.token_uri ?? 'https://oauth2.googleapis.com/token' };
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** A1 range covering a whole tab; tab names are quoted so spaces and punctuation work. */
export function tabRange(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

/**
 * Google Sheets API v4 client using a service account (JWT bearer flow). No SDK
 * dependency: tokens are minted with node:crypto and calls go through fetch.
 */
export class GoogleSheetsClient implements SheetsClient {
  private token: { value: string; expiresAt: number } | null = null;
  readonly serviceAccountEmail: string;

  constructor(
    private readonly key: ServiceAccountKey,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.serviceAccountEmail = key.client_email;
  }

  async describe(spreadsheetId: string): Promise<{ title: string; tabs: string[] }> {
    const data = (await this.request('GET', `/${spreadsheetId}?fields=properties.title,sheets.properties.title`)) as {
      properties?: { title?: string };
      sheets?: Array<{ properties?: { title?: string } }>;
    };
    return { title: data.properties?.title ?? '', tabs: (data.sheets ?? []).map((s) => s.properties?.title ?? '').filter(Boolean) };
  }

  async readTab(spreadsheetId: string, tab: string): Promise<string[][]> {
    const { tabs } = await this.describe(spreadsheetId);
    if (!tabs.includes(tab)) return [];
    const data = (await this.request('GET', `/${spreadsheetId}/values/${encodeURIComponent(tabRange(tab))}?majorDimension=ROWS`)) as { values?: string[][] };
    return (data.values ?? []).map((row) => row.map((v) => (v === null || v === undefined ? '' : String(v))));
  }

  async updateRanges(spreadsheetId: string, tab: string, writes: RangeValues[], clears: string[]): Promise<void> {
    if (clears.length) {
      await this.request('POST', `/${spreadsheetId}/values:batchClear`, { ranges: clears.map((r) => `${tabRange(tab)}!${r}`) });
    }
    if (writes.length) {
      await this.request('POST', `/${spreadsheetId}/values:batchUpdate`, {
        valueInputOption: 'RAW',
        data: writes.map((w) => ({ range: `${tabRange(tab)}!${w.range}`, majorDimension: 'ROWS', values: w.values })),
      });
    }
  }

  async writeTab(spreadsheetId: string, tab: string, values: string[][]): Promise<void> {
    const { tabs } = await this.describe(spreadsheetId);
    if (!tabs.includes(tab)) {
      await this.request('POST', `/${spreadsheetId}:batchUpdate`, { requests: [{ addSheet: { properties: { title: tab } } }] });
    }
    const range = encodeURIComponent(tabRange(tab));
    await this.request('POST', `/${spreadsheetId}/values/${range}:clear`, {});
    await this.request('PUT', `/${spreadsheetId}/values/${range}?valueInputOption=RAW`, { range: tabRange(tab), majorDimension: 'ROWS', values });
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await this.accessToken();
    const res = await this.fetchImpl(`https://sheets.googleapis.com/v4/spreadsheets${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
      } catch {
        /* keep raw text */
      }
      throw new GoogleSheetsError(`Google Sheets API ${res.status}: ${message || res.statusText}`, res.status);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(
      JSON.stringify({ iss: this.key.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: this.key.token_uri, iat: now, exp: now + 3600 }),
    );
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const assertion = `${header}.${claims}.${b64url(signer.sign(this.key.private_key))}`;
    const res = await this.fetchImpl(this.key.token_uri as string, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    if (!res.ok) throw new GoogleSheetsError(`Google token request failed (${res.status}): ${await res.text().catch(() => '')}`, res.status);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return data.access_token;
  }
}

/** Extracts a spreadsheet id from a full URL or returns the input if it already is one. */
export function parseSpreadsheetId(input: string): string | null {
  const text = input.trim();
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(text);
  if (m) return m[1] as string;
  if (/^[a-zA-Z0-9-_]{20,}$/.test(text)) return text;
  return null;
}

/** 0-based column index to A1 letters (0 -> A, 26 -> AA). */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** A1 range for a block starting at (row, col) (0-based) of the given size. */
export function a1Range(row: number, col: number, height: number, width: number): string {
  return `${columnLetter(col)}${row + 1}:${columnLetter(col + Math.max(1, width) - 1)}${row + Math.max(1, height)}`;
}
