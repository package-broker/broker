export interface UiManifestFile {
  readonly contentType: string;
  readonly bytes: number;
}

export interface UiManifest {
  readonly version: 1;
  readonly entry: string;
  readonly files: Readonly<Record<string, UiManifestFile>>;
}

export interface StaticAsset {
  readonly body: ReadableStream | Uint8Array;
  readonly contentType: string;
  readonly bytes: number;
}

/** `read` receives only a file name the manifest lists, never a path. */
export interface StaticAssets {
  manifest(): Promise<UiManifest | null>;
  read(name: string): Promise<StaticAsset | null>;
}
