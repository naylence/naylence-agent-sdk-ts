import { Registry as DefaultRegistry } from '@naylence/factory';
import { MODULE_LOADERS, MODULES } from '../factory-manifest.js';

const FACTORY_MODULE_PREFIX = '@naylence/agent-sdk/naylence/agent/';
const NODE_ONLY_FACTORY_MODULES = new Set(['./gateway/agent-http-gateway-listener-factory.js']);
const isNodeEnvironment = typeof process !== 'undefined' && Boolean((process as any)?.versions?.node);

let registered = false;

function resolveCandidates(spec: string): string[] {
  const candidates: string[] = [];
  const trimmed = spec.startsWith('./') ? spec.slice(2) : spec;

  if (spec.startsWith('./')) {
    candidates.push(spec);
  }

  candidates.push(trimmed);
  candidates.push(`${FACTORY_MODULE_PREFIX}${trimmed}`);

  if (trimmed.endsWith('.js')) {
    candidates.push(trimmed.replace(/\.js$/u, '.ts'));
  }

  return candidates;
}

async function importFactoryModule(spec: string): Promise<Record<string, any>> {
  let lastError: unknown;
  const staticLoader = MODULE_LOADERS?.[spec];
  if (staticLoader) {
    try {
      const loaded = await staticLoader();
      if (loaded && typeof loaded === 'object') {
        return loaded as Record<string, any>;
      }
    } catch (error) {
      lastError = error;
    }
  }

  const candidates = resolveCandidates(spec);
  for (const [index, candidate] of candidates.entries()) {
    try {
      const loaded = await import(/* @vite-ignore */ candidate);
      if (loaded && typeof loaded === 'object') {
        return loaded as Record<string, any>;
      }
      lastError = new Error(`Factory module ${candidate} did not export an object`);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const moduleNotFound =
        message.includes('Cannot find module') ||
        message.includes('ERR_MODULE_NOT_FOUND') ||
        message.includes('Unknown file extension') ||
        message.includes('Importing a module script failed');
      const isLast = index === candidates.length - 1;
      if (!moduleNotFound || isLast) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error(`Unable to import factory module: ${spec}`);
}

async function performRegistration(registry = DefaultRegistry): Promise<void> {
  await Promise.all(
    MODULES.map(async (spec) => {
      if (!isNodeEnvironment && NODE_ONLY_FACTORY_MODULES.has(spec)) {
        return;
      }

      const mod = await importFactoryModule(spec);
      const meta = mod.FACTORY_META;
      const factoryCtor = mod.default ?? mod?.[meta?.key] ?? null;
      if (!meta || !factoryCtor) {
        return;
      }

      registry.registerFactory(meta.base, meta.key, factoryCtor, meta);
    })
  );
}

export async function registerAgentFactories(registry = DefaultRegistry): Promise<void> {
  await performRegistration(registry);
  registered = true;
}

export async function ensureAgentFactoriesRegistered(registry = DefaultRegistry): Promise<void> {
  if (registered) {
    return;
  }
  await registerAgentFactories(registry);
}

export type AgentFactoryRegistry = typeof DefaultRegistry;
