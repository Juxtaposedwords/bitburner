export interface ServerMetadata {
  hostname: string;
  organization: string;
  ip: string;
  pathFromHome: string;
  maxRam: number;
  cpuCores: number;
  purchasedByPlayer: boolean;
  securityLevel: number;
  minSecurityLevel: number;
  hacked: boolean;
  backdoorInstalled: boolean;
  hacking: {
    requirements: {
      level?: number;
      ports?: number;
    };
    ports: {
      ssh: boolean;
      ftp: boolean;
      smtp: boolean;
      http: boolean;
      sql: boolean;
    };
  };
  moneyAvailable?: number;
  maxMoney?: number;
}