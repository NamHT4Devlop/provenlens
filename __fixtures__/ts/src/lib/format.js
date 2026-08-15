export function formatAmount(amount) {
  return `$${amount.toFixed(2)}`;
}

export function formatDonor(name) {
  return name.trim().toUpperCase();
}
