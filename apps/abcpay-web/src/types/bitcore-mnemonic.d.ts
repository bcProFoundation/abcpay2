declare module '@bcpros/bitcore-mnemonic' {
  class Mnemonic {
    static Words: { ENGLISH: string[] };
    phrase: string;
    constructor(words: string[]);
    toHDPrivateKey(passphrase: string, network: string): import('@bcpros/crypto-wallet-core').BitcoreLib.HDPrivateKey;
  }
  export default Mnemonic;
}
