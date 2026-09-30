/** Provider-scoped identity. Cross-provider joins require an explicit id-map row. */
export function providerPlayerId(provider: string, providerId: string) {
  return `${provider.trim().toLowerCase()}:${providerId.trim()}`;
}
