const CREDENTIALS_KEY = 'abcpay_v2_credentials';

export function saveCredentials(walletId: string, credentials: string) {
  const all = loadAllCredentials();
  all[walletId] = credentials;
  localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(all));
}

export function getCredentials(walletId: string): string | null {
  const all = loadAllCredentials();
  return all[walletId] ?? null;
}

export function removeCredentials(walletId: string) {
  const all = loadAllCredentials();
  delete all[walletId];
  localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(all));
}

function loadAllCredentials(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CREDENTIALS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
