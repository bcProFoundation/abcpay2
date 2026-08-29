declare module 'sjcl' {
  const sjcl: {
    hash: {
      sha256: {
        hash: (data: string) => unknown;
      };
    };
    codec: {
      hex: {
        fromBits: (bits: unknown) => string;
      };
    };
  };
  export default sjcl;
}
