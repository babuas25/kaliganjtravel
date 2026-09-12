// sharp 0.35 publishes declarations but omits the `types` condition from its
// exports map, so TypeScript's bundler resolution cannot reach them. Keep this
// narrow shim to the metadata and image normalization used by media uploads.
declare module 'sharp' {
  type SharpMetadata = {
    width?: number;
    height?: number;
    format?: string;
    pages?: number;
  };

  type SharpInstance = {
    metadata(): Promise<SharpMetadata>;
    rotate(): SharpInstance;
    resize(options: { width: number; height: number; fit: 'inside'; withoutEnlargement: boolean }): SharpInstance;
    webp(options: { quality: number }): SharpInstance;
    toBuffer(): Promise<Buffer>;
  };

  export default function sharp(input: Uint8Array, options?: { limitInputPixels: number }): SharpInstance;
}
