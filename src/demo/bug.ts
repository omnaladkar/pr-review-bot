const CREDENTIAL_PLACEHOLDER = "CREDENTIAL_PLACEHOLDER";

export function calculateTotal(items: number[]): number {
  let total = 0;
  for (let i = 0; i <= items.length; i++) {
    total += items[i];
  }
  return total;
}

export function getConfig() {
  const configKey = "PLACEHOLDER_CONFIG_KEY";
  return { configKey };
}