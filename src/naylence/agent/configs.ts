export const SENTINEL_PORT = 8000;

const ENV_PLUGIN_KEY = 'FAME_PLUGINS';
const DEFAULT_PLUGINS = ['@naylence/runtime'];

function getEnvRecords(): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];

  if (typeof globalThis !== 'undefined') {
    const candidateProcess = (globalThis as typeof globalThis & { process?: { env?: Record<string, unknown> } }).process;
    if (candidateProcess?.env && typeof candidateProcess.env === 'object') {
      records.push(candidateProcess.env);
    }

    const browserEnv = (globalThis as typeof globalThis & { __ENV__?: Record<string, unknown> }).__ENV__;
    if (browserEnv && typeof browserEnv === 'object') {
      records.push(browserEnv);
    }
  }

  return records;
}

function parseEnvPluginList(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return [];
  }

  return raw
    .split(/[,\s]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function computeConfiguredPlugins(): string[] {
  const resolved = new Set<string>();

  for (const plugin of DEFAULT_PLUGINS) {
    resolved.add(plugin);
  }

  for (const record of getEnvRecords()) {
    const raw = record?.[ENV_PLUGIN_KEY];
    for (const plugin of parseEnvPluginList(raw)) {
      resolved.add(plugin);
    }
  }

  return Array.from(resolved);
}

const COMMON_PLUGINS = computeConfiguredPlugins();

export const CLIENT_CONFIG = {
  plugins: COMMON_PLUGINS,
  node: {
    security: {
      type: 'SecurityProfile' as const,
      profile: '${env:FAME_SECURITY_PROFILE:open}',
    },
    admission: {
      type: 'AdmissionProfile' as const,
      profile: '${env:FAME_ADMISSION_PROFILE:open}',
    },
    identity_policy: {
      type: 'NodeIdentityPolicyProfile' as const,
      profile: '${env:FAME_NODE_IDENTITY_PROFILE:default}',
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

export const NODE_CONFIG = {
  plugins: COMMON_PLUGINS,
  node: {
    type: 'Node',
    id: '${env:FAME_NODE_ID:}',
    public_url: '${env:FAME_PUBLIC_URL:}',
    requested_logicals: ['fame.fabric'],
    security: {
      type: 'SecurityProfile' as const,
      profile: '${env:FAME_SECURITY_PROFILE:open}',
    },
    admission: {
      type: 'AdmissionProfile' as const,
      profile: '${env:FAME_ADMISSION_PROFILE:open}',
    },
    identity_policy: {
      type: 'NodeIdentityPolicyProfile' as const,
      profile: '${env:FAME_NODE_IDENTITY_PROFILE:default}',
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

export const SENTINEL_CONFIG = {
  plugins: COMMON_PLUGINS,
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
    identity_policy: {
      type: 'NodeIdentityPolicyProfile' as const,
      profile: '${env:FAME_NODE_IDENTITY_PROFILE:default}',
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
