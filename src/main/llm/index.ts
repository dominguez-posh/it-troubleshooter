import { anthropicDefinition } from './anthropic';
import { mockDefinition } from './mock';
import { ProviderRegistry } from './registry';

export function createDefaultRegistry(): ProviderRegistry {
  return new ProviderRegistry().register(anthropicDefinition).register(mockDefinition);
}

export * from './types';
export { ProviderRegistry } from './registry';
