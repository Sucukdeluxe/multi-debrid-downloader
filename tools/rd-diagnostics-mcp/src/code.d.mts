export interface DecodedConnectionCode {
  host: string;
  port: number;
  token: string;
  scheme: string;
  name: string;
  fingerprint: string;
}

export interface EncodeConnectionCodeInput {
  host: string;
  port: number;
  token: string;
  name?: string;
  fingerprint?: string;
  scheme?: string;
}

export function encodeConnectionCode(input: EncodeConnectionCodeInput): string;
export function decodeConnectionCode(code: string): DecodedConnectionCode;
