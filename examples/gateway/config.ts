const SENTINEL_PORT = 8080;

export const GATEWAY_CONFIG = {
  // Plugin specifiers (npm package names)
  plugins: ['@naylence/runtime', '@naylence/agent-sdk'],
  node: {
    type: 'Sentinel',
    id: '${env:FAME_NODE_ID:}',
    public_url: '${env:FAME_PUBLIC_URL:}',
    listeners: [
      {
        type: 'HttpListener' as const,
        port: SENTINEL_PORT,
      },
      {
        type: 'WebSocketListener' as const,
        port: SENTINEL_PORT,
      },
      {
        type: 'AgentHttpGatewayListener' as const,
        port: SENTINEL_PORT,
        limits: {
          bodyLimitBytes: 128
        }
      },
    ],
    requested_logicals: ['fame.fabric'],
    security: {
      type: 'SecurityProfile' as const,
      profile: '${env:FAME_SECURITY_PROFILE:open}',
    },
    admission: {
      type: 'AdmissionProfile' as const,
      profile: '${env:FAME_ADMISSION_PROFILE:none}',
    },
    storage: {
      type: 'StorageProfile' as const,
      profile: '${env:FAME_STORAGE_PROFILE:memory}',
    },
    delivery: {
      type: 'DeliveryProfile' as const,
      profile: '${env:FAME_DELIVERY_PROFILE:at-most-once}',
    },
  },
} as const;
