import { Registry as DefaultRegistry } from '@naylence/factory';
import {
  MODULE_LOADERS,
  MODULES,
  NODE_ONLY_FACTORY_MODULES,
  type FactoryModuleLoader,
  type FactoryModuleSpec,
} from '../factory-manifest.js';

const FACTORY_MODULE_PREFIX = '@naylence/agent-sdk/naylence/agent/';
const isNodeEnvironment = typeof process !== 'undefined' && Boolean((process as any)?.versions?.node);

let registered = false;

function resolveCandidates(spec: string): string[] {
  const candidates: string[] = [];
  const trimmed = spec.startsWith('./') ? spec.slice(2) : spec;

  // Try relative path first (for development/tsx)
  if (spec.startsWith('./')) {
    const relative = `../${spec.slice(2)}`;
    candidates.push(relative);
    if (relative.endsWith('.js')) {
      candidates.push(relative.replace(/\.js$/u, '.ts'));
    }
  }

  // Then try package path
  candidates.push(`${FACTORY_MODULE_PREFIX}${trimmed}`);
  if (trimmed.endsWith('.js')) {
    candidates.push(`${FACTORY_MODULE_PREFIX}${trimmed.replace(/\.js$/u, '.ts')}`);
  }

  return candidates;
}

async function importFactoryModule(spec: FactoryModuleSpec): Promise<Record<string, unknown>> {
  let lastError: unknown;

  // Try static loader first (from factory-manifest)
  const staticLoader: FactoryModuleLoader | undefined = MODULE_LOADERS?.[spec];
  if (staticLoader) {
    try {
      const loaded = await staticLoader();
      if (loaded && typeof loaded === 'object') {
        return loaded as Record<string, unknown>;
      }
    } catch (error) {
      lastError = error;
    }
  } else {
    // console.log(`[DEBUG] No static loader for ${spec}`);
  }

  // Fallback to dynamic import with candidate resolution
  const candidates = resolveCandidates(spec);
  for (const [index, candidate] of candidates.entries()) {
    try {
      const loaded = await import(/* @vite-ignore */ candidate);
      if (loaded && typeof loaded === 'object') {
        return loaded as Record<string, unknown>;
      }
      lastError = new Error(`Factory module ${candidate} did not export an object`);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const moduleNotFound =
        message.includes('Cannot find module') ||
        message.includes('ERR_MODULE_NOT_FOUND') ||
        message.includes('Unknown file extension') ||
        message.includes('Failed to fetch dynamically imported module') ||
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
    MODULES.map(async (spec: FactoryModuleSpec) => {
      // Skip node-only modules in browser environment
      if (!isNodeEnvironment && NODE_ONLY_FACTORY_MODULES.has(spec)) {
        return;
      }

      try {
        const mod = await importFactoryModule(spec);

        const meta = mod.FACTORY_META as { base?: string; key?: string } | undefined;
        const factoryCtor = mod.default ?? (meta?.key ? mod[meta.key] : null);

        if (!meta?.base || !meta?.key || typeof factoryCtor !== 'function') {
          return;
        }

        registry.registerFactory(meta.base, meta.key, factoryCtor as any, meta);
      } catch (error) {
        // In browser, node-only module failures are expected - silently skip
        if (!isNodeEnvironment && NODE_ONLY_FACTORY_MODULES.has(spec)) {
          return;
        }
        // Re-throw unexpected errors
        throw error;
      }
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
