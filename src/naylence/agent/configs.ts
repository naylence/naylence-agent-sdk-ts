export const SENTINEL_PORT = 8000;

const createCommonProfiles = (admissionProfile: string) => ({
  security: {
    type: "SecurityProfile" as const,
    profile: "${env:FAME_SECURITY_PROFILE:open}",
  },
  admission: {
    type: "AdmissionProfile" as const,
    profile: admissionProfile,
  },
  storage: {
    type: "StorageProfile" as const,
    profile: "${env:FAME_STORAGE_PROFILE:memory}",
  },
  delivery: {
    type: "DeliveryProfile" as const,
    profile: "${env:FAME_DELIVERY_PROFILE:at-most-once}",
  },
});

export const CLIENT_CONFIG = {
  plugins: ["naylence-runtime"],
  node: {
    ...createCommonProfiles("${env:FAME_ADMISSION_PROFILE:open}"),
  },
} as const;

export const NODE_CONFIG = {
  plugins: ["naylence-runtime"],
  node: {
    type: "Node",
    id: "${env:FAME_NODE_ID:}",
    public_url: "${env:FAME_PUBLIC_URL:}",
    requested_logicals: ["fame.fabric"],
    ...createCommonProfiles("${env:FAME_ADMISSION_PROFILE:open}"),
  },
} as const;

export const SENTINEL_CONFIG = {
  plugins: ["naylence-runtime"],
  node: {
    type: "Sentinel",
    id: "${env:FAME_NODE_ID:}",
    public_url: "${env:FAME_PUBLIC_URL:}",
    listeners: [
      {
        type: "HttpListener" as const,
        port: SENTINEL_PORT,
      },
      {
        type: "WebSocketListener" as const,
        port: SENTINEL_PORT,
      },
    ],
    requested_logicals: ["fame.fabric"],
    ...createCommonProfiles("${env:FAME_ADMISSION_PROFILE:none}"),
  },
} as const;
