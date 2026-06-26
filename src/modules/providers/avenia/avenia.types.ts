export interface AveniaConfig {
  baseUrl: string;       // sandbox includes the port (…:10952); prod TBD
  apiKey: string;
  signingPrivateKeyPem: string;
}
