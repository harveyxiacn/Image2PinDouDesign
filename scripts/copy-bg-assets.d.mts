export const DATA_VERSION: string;
export const TGZ_URL: string;
export const TGZ_SHA256: string;
export const WANTED_KEYS: string[];
export const MANIFEST_NAME: string;
export function sanitiseEntryName(raw: string): string | null;
export function selectAssets(
  resources: unknown,
  keys?: string[]
): { resources: Record<string, unknown>; chunks: string[] };
export function manifestProblems(
  manifest: unknown,
  actual: Record<string, { size: number; sha256: string }>
): string[];
export function verifyInstalled(dir: string): Promise<boolean>;
export function readTgz(
  file: string,
  onEntry: (entry: { name: string; size: number }) => boolean,
  onData: (name: string, data: Buffer) => void | Promise<void>
): Promise<void>;
